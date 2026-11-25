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
 * src/main/terrain/terrain_nav_hold.c, terrain_nav_hold_core.h and
 * terrain_nav_mission_logic.h.
 */
export const TerrainDefaults = Object.freeze({
    speedMs: 15,                // ground speed along the route
    climbRateMs: 5,             // nav_fw_auto_climb_rate (500 cm/s): the altitude controller's limit, both ways
    plannedClimbFraction: 0.5,  // TERRAIN_NAV_HOLD_PLANNED_CLIMB_FRACTION: the look-ahead plans with half of it,
                                // and a terrain leg descends no faster than that
    altResponse: 0.4,           // nav_fw_alt_control_response (40): climb rate = 0.4 x altitude error
    viewS: 20,                  // TERRAIN_NAV_MISSION_VIEW_S: how far ahead the line a terrain leg flies looks
    lineRiseTauS: 1,            // TERRAIN_NAV_MISSION_LINE_RISE_TAU_S: the lead follows the line's rise smoothed
    lineSettleS: 5,             // TERRAIN_NAV_MISSION_LINE_SETTLE_S: the last metres of the line's way down are eased
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

/*
 * The target a terrain leg hands to the altitude controller: the firmware's rules
 * (terrain_nav_mission_logic.h), in metres, metres per second and with the response
 * as a rate per metre of error (0.4 for a setting of 40). tools/compare_terrain_rules.mjs
 * runs these and the firmware's own functions on the same numbers.
 */

/* How far under a target rising at rateMs the altitude controller lets the aircraft settle. */
export function lagM(rateMs, altResponse) {
    return rateMs / Math.max(altResponse, 0.01);
}

/* Extra rise the look-ahead adds past the next waypoint: the difference of the two minimums. */
export function turnExtraRiseM(minM, nextMinM) {
    return nextMinM - minM;
}

/* The height above ground a terrain leg holds; clearanceM null = not known (or a floor leg). */
export function heldHeightM(mode, clearanceM, minM, marginM) {
    const floorM = minM + marginM;
    return mode === TerrainMode.FOLLOW && clearanceM !== null && clearanceM > floorM ? clearanceM : floorM;
}

/* The look-ahead's climb line: ground + minimum + margin + the climb the scan asks for. */
export function climbLineM(groundM, minM, marginM, climbNeededM) {
    return groundM + minM + marginM + climbNeededM;
}

/* Extra rise the line's look-ahead adds past the next waypoint: the line is aimed over the
   ground at the height this leg holds, and past the waypoint at the next leg's minimum +
   margin (the next leg's own held height is not known before it starts). */
export function lineNextExtraM(heldM, nextMinM, marginM) {
    return nextMinM + marginM - heldM;
}

/* The rate the line a terrain leg flies moves at. slope: height per distance flown that the
   steepest point in view needs: up, the line is aimed at that point. Negative: every point
   is lower, and the line comes down toward the highest of them (dropM below it) at
   maxDescentMs at most, eased over the last metres. Without an answer the line stays level;
   a leg that may not come down yet (a point in view without data) only goes up. */
export function lineRateMs(slopeValid, slope, speedMs, dropM, mayDescend, maxDescentMs, maxClimbMs,
    settleS = TerrainDefaults.lineSettleS) {
    if (!slopeValid) return 0;
    if (!(slope < 0)) return Math.min(slope * speedMs, maxClimbMs);
    if (!mayDescend || !(dropM > 0)) return 0;
    return -Math.min(dropM / settleS, maxDescentMs);
}

/* The line after seconds at rateMs, kept on or above what it may never be under:
   heldAltM (ground + the height the leg holds; from below it the line also rises at
   approachMs, up to it), hardFloorM (ground + minimum + margin) and, while the look-ahead
   asks for a climb, its climb line. */
export function lineAdvanceM(lineM, rateMs, seconds, heldAltM, approachMs, hardFloorM, climbing, climbLineAltM) {
    let z = lineM + rateMs * seconds;
    if (z < heldAltM) z = Math.min(heldAltM, z + approachMs * seconds);
    if (z < hardFloorM) z = hardFloorM;
    if (climbing && z < climbLineAltM) z = climbLineAltM;
    return z;
}

/* The line's rise, smoothed, after it moved from fromM to toM in seconds. Only a rise
   counts, and no faster than the altitude controller may command a climb. */
export function lineRiseMs(riseMs, fromM, toM, seconds, maxClimbMs, tauS = TerrainDefaults.lineRiseTauS) {
    if (!(seconds > 0)) return riseMs;
    let rate = (toM - fromM) / seconds;
    if (rate > maxClimbMs) rate = maxClimbMs;
    else if (!(rate > 0)) rate = 0;
    return riseMs + (rate - riseMs) * seconds / (tauS + seconds);
}

/* The terrain target: the line raised by the lag of its rise. */
export function lineTargetM(lineM, riseMs, altResponse) {
    return lineM + lagM(riseMs > 0 ? riseMs : 0, altResponse);
}

/* The target no lower than the altitude controller answers with a descent of maxDescentMs. */
export function limitDescentM(targetM, currentM, maxDescentMs, altResponse) {
    return Math.max(targetM, currentM - lagM(maxDescentMs, altResponse));
}

/* The fixed-wing altitude controller in one line: climb rate proportional to the
   altitude error, limited to the configured rate. A terrain leg limits the descent
   further (maxDescentMs), by keeping the target close enough under the aircraft. */
function respond(altM, targetM, seconds, p, maxDescentMs = p.climbRateMs) {
    let z = altM;
    let left = seconds;
    while (left > 1e-6) {
        const h = Math.min(0.5, left);
        const limitedM = limitDescentM(targetM, z, maxDescentMs, p.altResponse);
        const rate = Math.max(-p.climbRateMs, Math.min(p.climbRateMs, p.altResponse * (limitedM - z)));
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
 *   the line   a terrain leg flies a line over the ground ahead, not the ground's
 *              contour: up, aimed at the point in view (viewS of flight) that needs
 *              the steepest line; down only when every point in view is lower, to the
 *              highest of them; never under ground + minimum + 10 m nor under the
 *              look-ahead's climb line
 *   floor      the higher of the stock line and that line, held at minimum + 10 m
 *   follow     that line, held at the waypoint's own clearance at least (never less
 *              than minimum + 10 m): the aircraft comes down with the terrain after an
 *              obstacle, and stays up over a dip shorter than the view
 *   lead       the target is the line raised by what the altitude controller would
 *              otherwise lag behind its rise
 *   descent    on a terrain leg no faster than the climb the look-ahead plans with
 *   data lost  never below the last terrain target, still following a higher stock line
 *   the turn   with turns (mission_turn.js, turnGround(): the highest ground each turn's
 *              sweep may cross): a terrain leg's look-ahead sees that ground at its
 *              waypoint, and a stock leg after a terrain leg keeps that leg's floor until
 *              the aircraft is on course for it (the turn guard). Without turns the turn is
 *              the corner of the two legs, as before
 *
 * Not modelled: the scan across the width of a turn and the weaker climb in it (the
 * planner scans along the route), the cycles a new leg waits for its own answers,
 * during which the firmware's line does not come down, and the ground speed, which
 * the firmware's scan takes smoothed over 10 s and the planner as one fixed value.
 */
export function predictAltitude({ route, sampling, terrainM, globalMinM, params = {}, ignoreModes = false, turns = null }) {
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
    const plannedClimbMs = p.plannedClimbFraction * p.climbRateMs;
    const slopeSpeedMs = Math.max(p.speedMs, p.minSlopeSpeedMs);
    const climbRatio = plannedClimbMs / slopeSpeedMs;
    const viewM = Math.min(scanM, slopeSpeedMs * p.viewS);

    // The route look-ahead from sample k of leg i, as the firmware's scan answers it:
    //   neededM     worst shortfall ahead: how much the ground (plus any rise in the
    //               minimum past the next waypoint) outruns a climb at the planned rate
    //   lineSlope   the steepest line a point within the view needs from the line's
    //               height over the held height (lineStartM, not below 0); lineTopM:
    //               the highest ground in view, above the ground here; lineMissed: a
    //               point in view has no data
    function lookAhead(k, i, lineStartM, heldM) {
        const out = { neededM: 0, lineValid: false, lineMissed: false, lineSlope: 0, lineTopM: 0 };
        if (scanM <= 0 || terrainM[k] === null) return out;
        const next = legInfo[i + 1];
        const lastLeg = next && next.mode !== TerrainMode.OFF ? i + 1 : i;
        const startM = Math.max(0, lineStartM);
        for (let n = k + 1; n < samples.length && samples[n].legIndex <= lastLeg; n++) {
            const ahead = samples[n].distM - samples[k].distM;
            if (ahead > scanM) break;
            const inView = ahead <= viewM;
            if (terrainM[n] === null) {
                if (inView) out.lineMissed = true;
                continue;
            }
            const rise = terrainM[n] - terrainM[k];
            // Past the turn the next leg's minimum applies. The climb line aims at
            // minimum + margin on either leg; the line at this leg's held height, then
            // at the next leg's minimum + margin.
            const past = samples[n].legIndex === i + 1;
            out.neededM = Math.max(out.neededM,
                rise + (past ? turnExtraRiseM(legInfo[i].minM, next.minM) : 0) - climbRatio * ahead);
            if (inView && ahead > 0) {
                const lineRise = rise + (past ? lineNextExtraM(heldM, next.minM, p.recoverMarginM) : 0);
                const slope = (lineRise - startM) / ahead;
                if (!out.lineValid || slope > out.lineSlope) out.lineSlope = slope;
                if (!out.lineValid || lineRise > out.lineTopM) out.lineTopM = lineRise;
                out.lineValid = true;
            }
        }
        // The turn at the end of the leg crosses ground the legs do not. The firmware scans
        // it; here its highest ground stands where the turn begins (backM before the
        // waypoint), with this leg's minimum as a floor (never a follow leg's clearance)
        const turn = turns && turns[i];
        if (turn && turn.groundM !== null && turn.groundM !== undefined && i < route.length - 1) {
            const ahead = Math.max(0, samples[legs[i].lastSample].distM - (turn.backM || 0) - samples[k].distM);
            if (ahead <= scanM) {
                const rise = turn.groundM - terrainM[k];
                out.neededM = Math.max(out.neededM, rise - climbRatio * ahead);
                if (ahead <= viewM && ahead > 0) {
                    const lineRise = rise + lineNextExtraM(heldM, legInfo[i].minM, p.recoverMarginM);
                    const slope = (lineRise - startM) / ahead;
                    if (!out.lineValid || slope > out.lineSlope) out.lineSlope = slope;
                    if (!out.lineValid || lineRise > out.lineTopM) out.lineTopM = lineRise;
                    out.lineValid = true;
                }
            }
        }
        return out;
    }

    let z = route[0].altAmslM;
    altM[0] = z;
    reason[0] = z === null ? AltitudeReason.UNKNOWN : AltitudeReason.PLANNED;
    let lastTerrainTarget = null;

    // The line the terrain legs fly: it goes on from one terrain leg to the next and
    // starts again after a stock leg
    let lineM = null;
    let lineRate = 0;
    let lineRise = 0;

    for (let i = 1; i < route.length; i++) {
        const info = legInfo[i];
        const leg = legs[i];

        if (z === null || info.targetAmslM === null) {
            // Nothing to fly a line between. Pick up again from the next known altitude.
            z = info.targetAmslM;
            altM[leg.lastSample] = z;
            reason[leg.lastSample] = z === null ? AltitudeReason.UNKNOWN : AltitudeReason.PLANNED;
            lastTerrainTarget = null;
            lineM = null;
            continue;
        }
        // The turn guard: a stock leg after a terrain leg keeps that leg's floor until the
        // aircraft is on course for it, which the turn's sweep puts alongOutM into the leg.
        // Its ground is the higher of the ground under the leg and the turn's highest
        let guard = null;
        if (info.mode === TerrainMode.OFF) {
            const before = legInfo[i - 1];
            const turn = turns && turns[i - 1];
            if (turn && before && before.mode !== TerrainMode.OFF && lineM !== null) {
                guard = { minM: before.minM, untilM: leg.startDistM + turn.alongOutM, groundM: turn.groundM ?? null };
            } else {
                lastTerrainTarget = null;
                lineM = null;
            }
        }

        const startAltM = z;
        for (let k = leg.firstSample; k <= leg.lastSample; k++) {
            const sample = samples[k];
            const stockM = altitudeAlongLeg(startAltM, info.targetAmslM, leg.lengthM, sample.remainingM);
            const seconds = (sample.distM - samples[k - 1].distM) / Math.max(p.speedMs, 1);
            let targetM = stockM;
            let tag = AltitudeReason.PLANNED;
            let maxDescentMs = p.climbRateMs;

            if (guard && sample.distM > guard.untilM) {
                guard = null;
                lastTerrainTarget = null;
                lineM = null;
            }
            if (guard) {
                const own = terrainM[k];
                const groundM = own === null ? guard.groundM : (guard.groundM === null ? own : Math.max(own, guard.groundM));
                if (groundM === null) {
                    if (lastTerrainTarget !== null) targetM = Math.max(stockM, lastTerrainTarget);
                    tag = AltitudeReason.NO_DATA;
                } else {
                    // A floor at minimum + margin over that ground; the line comes down to
                    // it at the terrain legs' rate and is never under it
                    const heldAltM = groundM + guard.minM + p.recoverMarginM;
                    const beforeM = lineM;
                    lineM = lineAdvanceM(lineM, lineRate, seconds, heldAltM, plannedClimbMs, heldAltM, false, 0);
                    lineRise = lineRiseMs(lineRise, beforeM, lineM, seconds, p.climbRateMs, p.lineRiseTauS);
                    lineRate = lineRateMs(true, -1, 0, lineM - heldAltM, true, plannedClimbMs, p.climbRateMs, p.lineSettleS);
                    const terrainTargetM = lineTargetM(lineM, lineRise, p.altResponse);
                    lastTerrainTarget = terrainTargetM;
                    maxDescentMs = plannedClimbMs;
                    if (terrainTargetM > stockM) {
                        targetM = terrainTargetM;
                        tag = AltitudeReason.TERRAIN_CLIMB;
                    }
                }
            }

            if (info.mode !== TerrainMode.OFF) {
                const groundM = terrainM[k];
                if (groundM === null) {
                    // The line stands where it is: never descend on no data
                    if (lastTerrainTarget !== null) targetM = Math.max(stockM, lastTerrainTarget);
                    tag = AltitudeReason.NO_DATA;
                } else {
                    const following = info.mode === TerrainMode.FOLLOW && info.clearanceM !== null;
                    const heldM = heldHeightM(info.mode, info.clearanceM, info.minM, p.recoverMarginM);
                    const hardFloorM = groundM + info.minM + p.recoverMarginM;
                    if (lineM === null) {
                        // The first sample of a run of terrain legs: the line starts at
                        // the height the leg holds
                        lineM = groundM + heldM;
                        lineRate = 0;
                        lineRise = 0;
                    }
                    // As the firmware does it: on at the rate of the sample before, the
                    // scan from there, what the line may never be under, its rise, and
                    // the rate until the next sample
                    const beforeM = lineM;
                    const scan = lookAhead(k, i, lineM + lineRate * seconds - (groundM + heldM), heldM);
                    lineM = lineAdvanceM(lineM, lineRate, seconds, groundM + heldM, plannedClimbMs, hardFloorM,
                        scan.neededM > 0, climbLineM(groundM, info.minM, p.recoverMarginM, scan.neededM));
                    lineRise = lineRiseMs(lineRise, beforeM, lineM, seconds, p.climbRateMs, p.lineRiseTauS);
                    // Without a look-ahead there is nothing to aim at, and the only ground
                    // in view is the ground here: the line comes down to the held height
                    // and stays on it
                    lineRate = scanM <= 0
                        ? lineRateMs(true, -1, 0, lineM - (groundM + heldM), true, plannedClimbMs, p.climbRateMs, p.lineSettleS)
                        : lineRateMs(scan.lineValid, scan.lineSlope, slopeSpeedMs, lineM - (groundM + heldM + scan.lineTopM),
                            !scan.lineMissed, plannedClimbMs, p.climbRateMs, p.lineSettleS);
                    const terrainTargetM = lineTargetM(lineM, lineRise, p.altResponse);
                    lastTerrainTarget = terrainTargetM;
                    maxDescentMs = plannedClimbMs;
                    if (following) {
                        targetM = terrainTargetM;
                        tag = AltitudeReason.FOLLOW;
                    } else if (terrainTargetM > stockM) {
                        targetM = terrainTargetM;
                        tag = AltitudeReason.TERRAIN_CLIMB;
                    }
                }
            }

            z = respond(z, targetM, seconds, p, maxDescentMs);
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
 *   waypoints[i]       { index, clearanceM, minM, low, legLow, turnLow, flagged }: low = the waypoint's
 *                      own altitude is under its minimum; legLow = the leg flown to it dips under
 *                      it; turnLow = the turn at it does
 *   turns[i]           with turns (mission_turn.js, turnGround()), per waypoint null or
 *                      { index, groundM, position, altM, clearanceM, stockClearanceM, minM, low,
 *                      fallbackLow }: the highest ground the turn may cross against the lowest
 *                      altitude through the turn; low = under the minimum of the leg flown to the
 *                      waypoint; fallbackLow = only that leg's terrain mode keeps it clear
 */
export function analyseClearance({ route, sampling, terrainM, globalMinM, params = {}, turns = null }) {
    const { samples, legs } = sampling;
    const predicted = predictAltitude({ route, sampling, terrainM, globalMinM, params, turns });
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

    // Each turn against the highest ground its sweep may cross: the lowest altitude the
    // aircraft has from the turn's start to where it is on course again
    const turnResults = route.map((_, i) => {
        const turn = turns && turns[i];
        if (!turn || turn.groundM === null || turn.groundM === undefined || i === 0) return null;
        const cornerM = samples[waypointSample[i]].distM;
        let lowestM = null;
        let stockLowestM = null;
        for (let k = 0; k < samples.length; k++) {
            if (samples[k].distM < cornerM - (turn.backM || 0) || samples[k].distM > cornerM + turn.alongOutM) continue;
            if (predicted.altM[k] !== null && (lowestM === null || predicted.altM[k] < lowestM)) lowestM = predicted.altM[k];
            if (stock.altM[k] !== null && (stockLowestM === null || stock.altM[k] < stockLowestM)) stockLowestM = stock.altM[k];
        }
        const turnClearanceM = lowestM === null ? null : lowestM - turn.groundM;
        const stockClearanceM = stockLowestM === null ? null : stockLowestM - turn.groundM;
        const low = turnClearanceM !== null && turnClearanceM < ownMinM[i];
        const guarded = predicted.legs[i].mode !== TerrainMode.OFF;
        return {
            index: i,
            groundM: turn.groundM,
            position: turn.position,
            altM: lowestM,
            clearanceM: turnClearanceM,
            stockClearanceM,
            minM: ownMinM[i],
            low,
            fallbackLow: !low && guarded && stockClearanceM !== null && stockClearanceM < ownMinM[i]
        };
    });

    const waypoints = route.map((wp, i) => {
        const groundM = samples.length ? terrainM[waypointSample[i]] : null;
        const ownClearanceM = wp.altAmslM === null || groundM === null || groundM === undefined ? null : wp.altAmslM - groundM;
        const low = ownClearanceM !== null && ownClearanceM < ownMinM[i];
        const legLow = i > 0 && legSummaries[i].below;
        const turnLow = Boolean(turnResults[i] && turnResults[i].low);
        return { index: i, clearanceM: ownClearanceM, minM: ownMinM[i], low, legLow, turnLow, flagged: low || legLow || turnLow };
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
        waypoints,
        turns: turnResults
    };
}
