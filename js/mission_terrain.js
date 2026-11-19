'use strict';

/*
 * Terrain analysis of a waypoint mission: where the route is sampled, how much
 * ground clearance it has, and the per-waypoint terrain options stored in P3.
 *
 * Pure module: no DOM, no map library, no file or network access. Elevations
 * are handed in by the caller (js/elevationProvider.js supplies them).
 */

import MWNP from './mwnp.js';
import { altitudeAlongLeg, distanceBetween } from './mission_sim.js';

// ─── Per-waypoint terrain options in P3 ───────────────────────────────────────
//
// Stock INAV uses P3 bits 0-4 (altitude reference, user actions) and ignores
// the rest. This fork keeps its options at the top of the field so that bit 5,
// the next one upstream would use, stays free, and leaves bit 15 clear so the
// number never goes negative:
//   bits 6-12   minimum height above ground for the leg flown toward this
//               waypoint, in whole metres; 0 = use the global terrain_nav_min_agl
//   bits 13-14  terrain mode for that leg: 0 off, 1 floor, 2 follow (3 reads as off)

export const TerrainMode = Object.freeze({ OFF: 0, FLOOR: 1, FOLLOW: 2 });

export const P3_TERRAIN_MIN_SHIFT = 6;
export const P3_TERRAIN_MIN_MASK = 0x7F << P3_TERRAIN_MIN_SHIFT;
export const P3_TERRAIN_MODE_SHIFT = 13;
export const P3_TERRAIN_MODE_MASK = 0x3 << P3_TERRAIN_MODE_SHIFT;
export const P3_TERRAIN_MASK = P3_TERRAIN_MIN_MASK | P3_TERRAIN_MODE_MASK;

// Limits and default of the firmware setting terrain_nav_min_agl, in metres.
export const MIN_AGL_LOWEST_M = 50;
export const MIN_AGL_HIGHEST_M = 120;
export const MIN_AGL_DEFAULT_M = 60;

/* Only waypoints the aircraft flies to carry terrain options. JUMP reuses P3 as a counter. */
export function supportsTerrainOptions(action) {
    return action === MWNP.WPTYPE.WAYPOINT || action === MWNP.WPTYPE.POSHOLD_TIME;
}

export function terrainModeOfP3(action, p3) {
    if (!supportsTerrainOptions(action)) return TerrainMode.OFF;
    const mode = (Number(p3) & P3_TERRAIN_MODE_MASK) >> P3_TERRAIN_MODE_SHIFT;
    return mode === TerrainMode.FLOOR || mode === TerrainMode.FOLLOW ? mode : TerrainMode.OFF;
}

export function withTerrainMode(p3, mode) {
    const value = mode === TerrainMode.FLOOR || mode === TerrainMode.FOLLOW ? mode : TerrainMode.OFF;
    return (Number(p3) & ~P3_TERRAIN_MODE_MASK) | (value << P3_TERRAIN_MODE_SHIFT);
}

/* The waypoint's own minimum in metres, or null when it uses the global setting. */
export function legMinOverrideM(action, p3) {
    if (!supportsTerrainOptions(action)) return null;
    const metres = (Number(p3) & P3_TERRAIN_MIN_MASK) >> P3_TERRAIN_MIN_SHIFT;
    return metres >= MIN_AGL_LOWEST_M && metres <= MIN_AGL_HIGHEST_M ? metres : null;
}

/* Minimum height above ground that applies to the leg flown toward a waypoint. */
export function legMinM(action, p3, globalMinM) {
    const own = legMinOverrideM(action, p3);
    return own === null ? globalMinM : own;
}

/* Stores a per-waypoint minimum; null (or a value outside the limits) returns it to the global setting. */
export function withLegMin(p3, metres) {
    const rounded = Math.round(Number(metres));
    const value = metres !== null && rounded >= MIN_AGL_LOWEST_M && rounded <= MIN_AGL_HIGHEST_M ? rounded : 0;
    return (Number(p3) & ~P3_TERRAIN_MIN_MASK) | (value << P3_TERRAIN_MIN_SHIFT);
}

/* Removes every terrain option, leaving the stock bits as they are. */
export function clearTerrainBits(p3) {
    return Number(p3) & ~P3_TERRAIN_MASK;
}

// ─── Sampling a route ─────────────────────────────────────────────────────────

function interpolate(from, to, t) {
    return {
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + (to.lon - from.lon) * t
    };
}

/*
 * `count` + 1 points spaced evenly by distance along a path of [{ lat, lon }],
 * first and last included. Each has distM, its distance from the start.
 */
export function samplePathEvenly(points, count) {
    const path = points.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (path.length === 0) return [];
    if (path.length === 1 || count < 1) return [{ ...path[0], distM: 0 }];

    const cumulative = [0];
    for (let i = 1; i < path.length; i++) {
        cumulative.push(cumulative[i - 1] + distanceBetween(path[i - 1], path[i]));
    }
    const total = cumulative[cumulative.length - 1];

    const samples = [];
    let leg = 1;
    for (let n = 0; n <= count; n++) {
        const distM = total * n / count;
        while (leg < path.length - 1 && cumulative[leg] < distM) leg++;
        const legLength = cumulative[leg] - cumulative[leg - 1];
        const t = legLength > 0 ? Math.min(1, Math.max(0, (distM - cumulative[leg - 1]) / legLength)) : 0;
        samples.push({ ...interpolate(path[leg - 1], path[leg], t), distM });
    }
    return samples;
}

/*
 * Samples a route for terrain analysis.
 *
 * route: [{ lat, lon, ... }] in the order the waypoints are flown. Leg i (from 1)
 * runs from route[i - 1] to route[i]. Each leg is cut into equal steps no longer
 * than spacingM, and its last sample is exactly the waypoint. When the whole
 * route would need more than maxSamples, the spacing is widened to fit.
 *
 * Returns { samples, legs, spacingM, totalM }:
 *   samples[k] = { lat, lon, distM, legIndex, remainingM, waypointIndex }
 *       distM from the start of the route, remainingM to the end of the leg,
 *       waypointIndex = index into route when the sample is a waypoint, else null
 *   legs[i]    = { index, lengthM, startDistM, firstSample, lastSample }  (legs[0] is null)
 */
export function sampleLegs(route, { spacingM = 30, maxSamples = 6000 } = {}) {
    const samples = [];
    const legs = [null];
    if (!route.length) {
        return { samples, legs, spacingM, totalM: 0 };
    }

    const lengths = [0];
    let totalM = 0;
    for (let i = 1; i < route.length; i++) {
        lengths.push(distanceBetween(route[i - 1], route[i]));
        totalM += lengths[i];
    }
    const spacing = totalM / spacingM > maxSamples ? totalM / maxSamples : spacingM;

    samples.push({
        lat: route[0].lat, lon: route[0].lon, distM: 0,
        legIndex: route.length > 1 ? 1 : 0, remainingM: lengths[1] || 0, waypointIndex: 0
    });

    let startDistM = 0;
    for (let i = 1; i < route.length; i++) {
        const lengthM = lengths[i];
        const steps = Math.max(1, Math.ceil(lengthM / spacing));
        const firstSample = samples.length;
        for (let j = 1; j <= steps; j++) {
            const t = j / steps;
            samples.push({
                ...interpolate(route[i - 1], route[i], t),
                distM: startDistM + lengthM * t,
                legIndex: i,
                remainingM: lengthM * (1 - t),
                waypointIndex: j === steps ? i : null
            });
        }
        legs.push({ index: i, lengthM, startDistM, firstSample, lastSample: samples.length - 1 });
        startDistM += lengthM;
    }
    return { samples, legs, spacingM: spacing, totalM };
}

// ─── Predicting the altitude the aircraft flies ───────────────────────────────

/*
 * What the prediction assumes about the aircraft and the firmware. The values
 * are the firmware defaults; the planner replaces them with the flight
 * controller's settings when it is connected. Keep in step with
 * src/main/terrain/terrain_nav_hold.c and terrain_nav_hold_core.h.
 */
export const TerrainDefaults = Object.freeze({
    speedMs: 15,                // ground speed along the route
    climbRateMs: 5,             // nav_fw_auto_climb_rate (500 cm/s), also the descent limit
    altResponse: 0.4,           // nav_fw_alt_control_response (40): climb rate = 0.4 x altitude error
    lookaheadM: 1000,           // terrain_nav_lookahead
    cacheBlocks: 8,             // terrain block cache: 8 on boards with 512 kB RAM or more, else 4
    recoverMarginM: 10,         // TERRAIN_NAV_HOLD_RECOVER_MARGIN_CM: the hold keeps minimum + 10 m
    timeHorizonS: 35,           // TERRAIN_NAV_HOLD_TIME_HORIZON_S
    minSlopeSpeedMs: 8,         // the look-ahead never assumes less than 8 m/s ground speed
    metresPerBlockWorst: 540,   // TERRAIN_NAV_HOLD_M_PER_BLOCK_WORST
    maxLookaheadM: 1920         // 64 samples of 30 m (TERRAIN_NAV_LOOKAHEAD_MAX_SAMPLES)
});

/* Why the predicted altitude at a sample is what it is. */
export const AltitudeReason = Object.freeze({
    PLANNED: 'planned',             // on the stock line between the waypoint altitudes
    FOLLOW: 'follow',               // holding the leg's ground clearance
    TERRAIN_CLIMB: 'terrain-climb', // above the stock line because the terrain floor demands it
    BELOW_MIN: 'below-min',         // closer to the ground than the leg's minimum
    NO_DATA: 'no-data',             // terrain leg without terrain data here
    UNKNOWN: 'unknown'              // altitude frame not known (relative altitude without a home elevation)
});

/* How far ahead the firmware's terrain look-ahead scans, in metres. */
export function lookaheadDistanceM(params = {}) {
    const p = { ...TerrainDefaults, ...params };
    if (!(p.lookaheadM > 0)) return 0;
    const slopeSpeed = Math.max(p.speedMs, p.minSlopeSpeedMs);
    return Math.max(0, Math.min(
        p.lookaheadM,
        (p.cacheBlocks - 3) * p.metresPerBlockWorst,
        slopeSpeed * p.timeHorizonS,
        p.maxLookaheadM));
}

/* The fixed-wing altitude controller in one line: climb rate proportional to the
   altitude error, limited to the configured rate. */
function respond(altM, targetM, seconds, p) {
    let z = altM;
    let left = seconds;
    while (left > 1e-6) {
        const h = Math.min(0.5, left);
        const rate = Math.max(-p.climbRateMs, Math.min(p.climbRateMs, p.altResponse * (targetM - z)));
        z += rate * h;
        left -= h;
    }
    return z;
}

/*
 * Altitude (metres above sea level) the aircraft is expected to fly at each
 * sample of a route, for stock legs and for the terrain modes.
 *
 * route[i] = { altAmslM, action, p3 }: altAmslM is the waypoint altitude above
 * sea level, or null when it cannot be known (a relative altitude without a home
 * elevation). terrainM[k] is the ground elevation at sample k, or null.
 * With ignoreModes every leg is treated as stock: the line the aircraft flies on
 * stock firmware, or when the terrain data is unusable.
 *
 * Mirrors the firmware:
 *   stock      linear from the altitude at the start of the leg to the waypoint
 *              altitude, reached with a tenth of the leg left
 *   floor      the higher of the stock line and (ground + minimum + 10 m), raised
 *              early for higher ground or a higher minimum ahead along the route
 *   follow     ground + the waypoint's own clearance (never less than minimum + 10 m),
 *              with the same early raise
 *   data lost  never below the last terrain target, still following a higher stock line
 */
export function predictAltitude({ route, sampling, terrainM, globalMinM, params = {}, ignoreModes = false }) {
    const p = { ...TerrainDefaults, ...params };
    const { samples, legs } = sampling;
    const altM = new Array(samples.length).fill(null);
    const reason = new Array(samples.length).fill(AltitudeReason.UNKNOWN);
    if (!samples.length) return { altM, reason, legs: [null] };

    const legInfo = route.map((wp, i) => {
        if (i === 0) return null;
        const mode = ignoreModes ? TerrainMode.OFF : terrainModeOfP3(wp.action, wp.p3);
        const minM = legMinM(wp.action, wp.p3, globalMinM);
        const groundAtWaypoint = terrainM[legs[i].lastSample];
        const clearanceM = mode === TerrainMode.FOLLOW && wp.altAmslM !== null && groundAtWaypoint !== null
            ? wp.altAmslM - groundAtWaypoint
            : null;
        return { index: i, mode, minM, targetAmslM: wp.altAmslM, clearanceM };
    });

    const scanM = lookaheadDistanceM(p);
    const climbRatio = 0.5 * p.climbRateMs / Math.max(p.speedMs, p.minSlopeSpeedMs);

    // Worst shortfall ahead along the route: how much the ground (plus any rise in
    // the minimum past the next waypoint) outruns a climb at half the configured rate.
    function climbNeededAhead(k, i) {
        if (scanM <= 0 || terrainM[k] === null) return 0;
        const next = legInfo[i + 1];
        const lastLeg = next && next.mode !== TerrainMode.OFF ? i + 1 : i;
        let worst = 0;
        for (let n = k + 1; n < samples.length && samples[n].legIndex <= lastLeg; n++) {
            const ahead = samples[n].distM - samples[k].distM;
            if (ahead > scanM) break;
            if (terrainM[n] === null) continue;
            let rise = terrainM[n] - terrainM[k];
            if (samples[n].legIndex === i + 1) {
                // Past the turn the next leg's minimum applies. Where it is higher, aim for
                // the height that leg will hold (its minimum plus the margin), so the
                // aircraft arrives at the waypoint already above the new minimum.
                rise += next.minM - legInfo[i].minM;
                if (next.minM > legInfo[i].minM) rise += p.recoverMarginM;
            }
            worst = Math.max(worst, rise - climbRatio * ahead);
        }
        return worst;
    }

    let z = route[0].altAmslM;
    altM[0] = z;
    reason[0] = z === null ? AltitudeReason.UNKNOWN : AltitudeReason.PLANNED;
    let lastTerrainTarget = null;

    for (let i = 1; i < route.length; i++) {
        const info = legInfo[i];
        const leg = legs[i];

        if (z === null || info.targetAmslM === null) {
            // Nothing to fly a line between. Pick up again from the next known altitude.
            z = info.targetAmslM;
            altM[leg.lastSample] = z;
            reason[leg.lastSample] = z === null ? AltitudeReason.UNKNOWN : AltitudeReason.PLANNED;
            lastTerrainTarget = null;
            continue;
        }
        if (info.mode === TerrainMode.OFF) {
            lastTerrainTarget = null;
        }

        const startAltM = z;
        for (let k = leg.firstSample; k <= leg.lastSample; k++) {
            const sample = samples[k];
            const stockM = altitudeAlongLeg(startAltM, info.targetAmslM, leg.lengthM, sample.remainingM);
            let targetM = stockM;
            let tag = AltitudeReason.PLANNED;

            if (info.mode !== TerrainMode.OFF) {
                const groundM = terrainM[k];
                if (groundM === null) {
                    if (lastTerrainTarget !== null) targetM = Math.max(stockM, lastTerrainTarget);
                    tag = AltitudeReason.NO_DATA;
                } else {
                    const following = info.mode === TerrainMode.FOLLOW && info.clearanceM !== null;
                    const heldM = following
                        ? Math.max(info.clearanceM, info.minM + p.recoverMarginM)
                        : info.minM + p.recoverMarginM;
                    const terrainTargetM = Math.max(groundM + heldM, groundM + info.minM + climbNeededAhead(k, i));
                    lastTerrainTarget = terrainTargetM;
                    if (following) {
                        targetM = terrainTargetM;
                        tag = AltitudeReason.FOLLOW;
                    } else if (terrainTargetM > stockM) {
                        targetM = terrainTargetM;
                        tag = AltitudeReason.TERRAIN_CLIMB;
                    }
                }
            }

            const seconds = (sample.distM - samples[k - 1].distM) / Math.max(p.speedMs, 1);
            z = respond(z, targetM, seconds, p);
            altM[k] = z;
            reason[k] = tag;
        }
    }

    return { altM, reason, legs: legInfo };
}

// ─── Clearance analysis ───────────────────────────────────────────────────────

function runsOf(flags, samples) {
    const runs = [];
    let start = -1;
    for (let k = 0; k <= flags.length; k++) {
        const on = k < flags.length && flags[k];
        const sameLeg = start >= 0 && k < flags.length && samples[k].legIndex === samples[start].legIndex;
        if (on && start < 0) {
            start = k;
        } else if (start >= 0 && (!on || !sameLeg)) {
            // Drawn from the sample before the run so that a single low sample still has a length.
            const from = start > 0 && samples[start - 1].legIndex <= samples[start].legIndex ? start - 1 : start;
            runs.push({ legIndex: samples[start].legIndex, fromSample: from, toSample: k - 1 });
            start = on ? k : -1;
        }
    }
    return runs;
}

/*
 * Ground clearance of a whole mission.
 *
 * route[i] = { lat, lon, altAmslM, action, p3 } in flown order; sampling from
 * sampleLegs(route); terrainM[k] the ground elevation at sample k or null.
 *
 * Returns:
 *   altM / reason      predicted altitude per sample and why (AltitudeReason);
 *                      a sample closer to the ground than its leg's minimum is BELOW_MIN
 *   stockAltM          the altitude per sample on stock firmware (terrain options ignored)
 *   clearanceM, minM   predicted clearance and the applicable minimum per sample
 *   belowRanges        [{ legIndex, fromSample, toSample }] where the prediction is below the minimum
 *   fallbackRanges     the same for the stock line on legs that rely on a terrain mode
 *   legs[i]            { index, mode, minM, lowestClearanceM, lowestAtSample, below, fallbackBelow, known, noData }
 *   waypoints[i]       { index, clearanceM, minM, low, legLow, flagged }: low = the waypoint's own
 *                      altitude is under its minimum; legLow = the leg flown to it dips under it
 */
export function analyseClearance({ route, sampling, terrainM, globalMinM, params = {} }) {
    const { samples, legs } = sampling;
    const predicted = predictAltitude({ route, sampling, terrainM, globalMinM, params });
    const stock = predictAltitude({ route, sampling, terrainM, globalMinM, params, ignoreModes: true });

    // A landing descends to the ground on purpose: its leg has no minimum to hold.
    const ownMinM = route.map(wp => (wp.action === MWNP.WPTYPE.LAND
        ? -Infinity : legMinM(wp.action, wp.p3, globalMinM)));
    const minM = samples.map(sample => ownMinM[sample.waypointIndex === 0 ? 0 : sample.legIndex] ?? globalMinM);
    const clearanceM = samples.map((_, k) => (predicted.altM[k] === null || terrainM[k] === null
        ? null : predicted.altM[k] - terrainM[k]));
    const stockClearanceM = samples.map((_, k) => (stock.altM[k] === null || terrainM[k] === null
        ? null : stock.altM[k] - terrainM[k]));

    const reason = predicted.reason.slice();
    const below = samples.map((_, k) => clearanceM[k] !== null && clearanceM[k] < minM[k]);
    below.forEach((isBelow, k) => {
        if (isBelow) reason[k] = AltitudeReason.BELOW_MIN;
    });
    const fallbackBelow = samples.map((sample, k) => {
        const info = predicted.legs[sample.legIndex];
        return Boolean(info) && info.mode !== TerrainMode.OFF && !below[k] &&
            stockClearanceM[k] !== null && stockClearanceM[k] < minM[k];
    });

    const belowRanges = runsOf(below, samples);
    const fallbackRanges = runsOf(fallbackBelow, samples);

    const legSummaries = legs.map((leg, i) => {
        if (!leg) return null;
        const info = predicted.legs[i];
        let lowestClearanceM = null;
        let lowestAtSample = null;
        let noData = false;
        for (let k = leg.firstSample; k <= leg.lastSample; k++) {
            if (terrainM[k] === null) noData = true;
            if (clearanceM[k] !== null && (lowestClearanceM === null || clearanceM[k] < lowestClearanceM)) {
                lowestClearanceM = clearanceM[k];
                lowestAtSample = k;
            }
        }
        return {
            index: i,
            mode: info.mode,
            minM: ownMinM[i],
            lowestClearanceM,
            lowestAtSample,
            below: belowRanges.some(range => range.legIndex === i),
            fallbackBelow: fallbackRanges.some(range => range.legIndex === i),
            known: route[i].altAmslM !== null && route[i - 1].altAmslM !== null,
            noData
        };
    });

    const waypointSample = route.map((_, i) => (i === 0 ? 0 : legs[i].lastSample));
    const waypoints = route.map((wp, i) => {
        const groundM = samples.length ? terrainM[waypointSample[i]] : null;
        const ownClearanceM = wp.altAmslM === null || groundM === null || groundM === undefined ? null : wp.altAmslM - groundM;
        const low = ownClearanceM !== null && ownClearanceM < ownMinM[i];
        const legLow = i > 0 && legSummaries[i].below;
        return { index: i, clearanceM: ownClearanceM, minM: ownMinM[i], low, legLow, flagged: low || legLow };
    });

    return {
        altM: predicted.altM,
        stockAltM: stock.altM,
        reason,
        clearanceM,
        minM,
        belowRanges,
        fallbackRanges,
        legs: legSummaries,
        waypoints
    };
}
