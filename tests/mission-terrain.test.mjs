import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import MWNP from '../js/mwnp.js';
import { altitudeAlongLeg, destination, distanceBetween } from '../js/mission_sim.js';
import {
    AltitudeReason,
    MIN_AGL_DEFAULT_M,
    P3_TERRAIN_MASK,
    TerrainMode,
    analyseClearance,
    clearTerrainBits,
    climbLineM,
    heldHeightM,
    lagM,
    legMinM,
    legMinOverrideM,
    limitDescentM,
    lineAdvanceM,
    lineNextExtraM,
    lineRateMs,
    lineRiseMs,
    lineTargetM,
    lookaheadDistanceM,
    predictAltitude,
    sampleLegs,
    samplePathEvenly,
    supportsTerrainOptions,
    terrainModeOfP3,
    turnExtraRiseM,
    withLegMin,
    withTerrainMode
} from '../js/mission_terrain.js';

const WP = MWNP.WPTYPE.WAYPOINT;
const START = { lat: 47.2, lon: 8.3 };

// A route heading due north from START; distances are metres from START.
function northRoute(points) {
    return points.map(({ atM, altAmslM, p3 = 0, action = WP }) => ({
        ...destination(START, 0, atM), altAmslM, p3, action
    }));
}

// Ground height as a function of distance along the route.
function terrainAlong(sampling, heightAt) {
    return sampling.samples.map(sample => heightAt(sample.distM));
}

function ridge(centreM, halfWidthM, heightM, baseM = 400) {
    return (distM) => {
        const offset = Math.abs(distM - centreM);
        return offset >= halfWidthM ? baseM : baseM + heightM * 0.5 * (1 + Math.cos(Math.PI * offset / halfWidthM));
    };
}

function p3With(mode, minM = null, base = 0) {
    return withLegMin(withTerrainMode(base, mode), minM);
}

describe('terrain options in P3', () => {
    test('leave the stock bits alone', () => {
        const stock = 0b11111;   // sea-level reference and all four user actions
        const p3 = p3With(TerrainMode.FOLLOW, 85, stock);
        assert.equal(p3 & 0b11111, stock);
        assert.equal(p3 & (1 << 5), 0, 'bit 5 stays free for upstream');
        assert.equal(p3 & (1 << 15), 0, 'bit 15 stays clear so the number is never negative');
        assert.ok(p3 > 0 && p3 < 32768);
        assert.equal(terrainModeOfP3(WP, p3), TerrainMode.FOLLOW);
        assert.equal(legMinOverrideM(WP, p3), 85);
        assert.equal(clearTerrainBits(p3), stock);
        assert.equal(P3_TERRAIN_MASK, 0x7FC0);
    });

    test('round-trip every mode and the limits of the minimum', () => {
        for (const mode of [TerrainMode.OFF, TerrainMode.FLOOR, TerrainMode.FOLLOW]) {
            assert.equal(terrainModeOfP3(WP, withTerrainMode(0, mode)), mode);
        }
        assert.equal(legMinOverrideM(WP, withLegMin(0, 50)), 50);
        assert.equal(legMinOverrideM(WP, withLegMin(0, 120)), 120);
        assert.equal(legMinOverrideM(WP, withLegMin(0, 49)), null, 'below the firmware limit');
        assert.equal(legMinOverrideM(WP, withLegMin(0, 121)), null, 'above the firmware limit');
        assert.equal(legMinOverrideM(WP, withLegMin(withLegMin(0, 90), null)), null, 'reset to the global value');
    });

    test('read unknown values as off and the global minimum', () => {
        assert.equal(terrainModeOfP3(WP, 3 << 13), TerrainMode.OFF, 'reserved mode');
        assert.equal(legMinOverrideM(WP, 30 << 6), null, 'a stored minimum outside the limits');
        assert.equal(legMinM(WP, 30 << 6, 70), 70);
        assert.equal(legMinM(WP, withLegMin(0, 100), 70), 100);
    });

    test('apply only to waypoints the aircraft flies to', () => {
        const p3 = p3With(TerrainMode.FLOOR, 100);
        assert.equal(supportsTerrainOptions(MWNP.WPTYPE.POSHOLD_TIME), true);
        for (const action of [MWNP.WPTYPE.JUMP, MWNP.WPTYPE.LAND, MWNP.WPTYPE.RTH, MWNP.WPTYPE.SET_POI, MWNP.WPTYPE.SET_HEAD]) {
            assert.equal(terrainModeOfP3(action, p3), TerrainMode.OFF);
            assert.equal(legMinOverrideM(action, p3), null);
        }
        // JUMP keeps its repeat counter in P3: 100 repeats left must not read as a terrain mode.
        assert.equal(terrainModeOfP3(MWNP.WPTYPE.JUMP, 0x6000), TerrainMode.OFF);
    });
});

describe('route sampling', () => {
    test('spaces points evenly along a path', () => {
        const path = [START, destination(START, 0, 1000), destination(destination(START, 0, 1000), 90, 500)];
        const samples = samplePathEvenly(path, 30);
        assert.equal(samples.length, 31);
        assert.ok(distanceBetween(samples[0], path[0]) < 0.01);
        assert.ok(distanceBetween(samples[30], path[2]) < 0.01);
        for (let i = 1; i < samples.length; i++) {
            assert.ok(Math.abs(distanceBetween(samples[i - 1], samples[i]) - 50) < 1.5, `step ${i}`);
        }
    });

    test('cuts every leg into steps of at most 30 m ending on the waypoint', () => {
        const route = northRoute([{ atM: 0 }, { atM: 1000 }, { atM: 1045 }]);
        const { samples, legs, totalM } = sampleLegs(route);

        assert.ok(Math.abs(totalM - 1045) < 0.5);
        assert.equal(legs[0], null);
        assert.equal(samples[0].waypointIndex, 0);
        for (const leg of legs.slice(1)) {
            const last = samples[leg.lastSample];
            assert.equal(last.waypointIndex, leg.index);
            assert.ok(Math.abs(last.remainingM) < 1e-6);
            assert.ok(distanceBetween(last, route[leg.index]) < 0.01);
            for (let k = leg.firstSample; k <= leg.lastSample; k++) {
                assert.equal(samples[k].legIndex, leg.index);
                assert.ok(samples[k].distM - samples[k - 1].distM <= 30.01);
            }
        }
        assert.equal(legs[1].lastSample - legs[1].firstSample + 1, 34);
        assert.equal(legs[2].lastSample - legs[2].firstSample + 1, 2);
    });

    test('widens the spacing for a route too long to sample at 30 m', () => {
        const route = northRoute([{ atM: 0 }, { atM: 60000 }]);
        const { samples, spacingM } = sampleLegs(route, { maxSamples: 500 });
        assert.ok(samples.length <= 502);
        assert.ok(spacingM > 100);
    });
});

describe('predicted altitude', () => {
    const params = { speedMs: 18, climbRateMs: 5 };

    test('a stock leg follows the firmware ramp and arrives at the waypoint altitude', () => {
        const route = northRoute([{ atM: 0, altAmslM: 500 }, { atM: 3000, altAmslM: 560 }]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const { altM, reason } = predictAltitude({ route, sampling, terrainM, globalMinM: 60, params });

        sampling.samples.forEach((sample, k) => {
            if (k === 0) return;
            const ramp = altitudeAlongLeg(500, 560, 3000, sample.remainingM);
            // 0.4 m/s climb here: the controller trails the ramp by about a metre.
            assert.ok(Math.abs(altM[k] - ramp) < 1.5, `sample ${k}: ${altM[k]} vs ramp ${ramp}`);
            assert.equal(reason[k], AltitudeReason.PLANNED);
        });
        assert.ok(Math.abs(altM[altM.length - 1] - 560) < 0.2);
    });

    test('a leg starts from the altitude the aircraft actually has', () => {
        // The climb asked of leg 1 is far beyond the climb rate, so it arrives low.
        const route = northRoute([{ atM: 0, altAmslM: 500 }, { atM: 600, altAmslM: 800 }, { atM: 3600, altAmslM: 800 }]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 300);
        const { altM } = predictAltitude({ route, sampling, terrainM, globalMinM: 60, params });

        const atFirstWaypoint = altM[sampling.legs[1].lastSample];
        assert.ok(atFirstWaypoint < 700, `arrives at ${atFirstWaypoint}`);
        const justAfter = altM[sampling.legs[2].firstSample + 2];
        assert.ok(justAfter > atFirstWaypoint && justAfter < 800);
        assert.ok(Math.abs(altM[altM.length - 1] - 800) < 0.5);
    });

    test('without a home elevation a relative leg has no predicted altitude', () => {
        const route = northRoute([{ atM: 0, altAmslM: null }, { atM: 1000, altAmslM: null }, { atM: 2000, altAmslM: 520 }]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });

        assert.equal(result.altM[5], null);
        assert.equal(result.reason[5], AltitudeReason.UNKNOWN);
        assert.equal(result.legs[1].known, false);
        assert.equal(result.waypoints[0].flagged, false);
        assert.equal(result.belowRanges.length, 0);
    });

    test('the look-ahead distance is limited by the setting, the block cache and the speed', () => {
        assert.equal(lookaheadDistanceM({ speedMs: 40, lookaheadM: 1000, cacheBlocks: 8 }), 1000);
        assert.equal(lookaheadDistanceM({ speedMs: 40, lookaheadM: 2000, cacheBlocks: 8 }), 1400);
        assert.equal(lookaheadDistanceM({ speedMs: 40, lookaheadM: 2000, cacheBlocks: 4 }), 540);
        assert.equal(lookaheadDistanceM({ speedMs: 15, lookaheadM: 1000, cacheBlocks: 8 }), 525);
        assert.equal(lookaheadDistanceM({ speedMs: 2, lookaheadM: 1000, cacheBlocks: 8 }), 280);
        assert.equal(lookaheadDistanceM({ lookaheadM: 0 }), 0);
    });
});

describe('clearance analysis', () => {
    const params = { speedMs: 18, climbRateMs: 5 };

    test('flags a leg that dips below the minimum between two safe waypoints', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 500 }, { atM: 4000, altAmslM: 500 }, { atM: 6000, altAmslM: 500 }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ridge(2000, 400, 80));   // ridge top at 480 m: 20 m of clearance
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });

        assert.equal(result.waypoints[0].low, false);
        assert.equal(result.waypoints[1].low, false, 'the waypoint itself has 100 m of clearance');
        assert.equal(result.waypoints[1].legLow, true);
        assert.equal(result.waypoints[1].flagged, true);
        assert.equal(result.waypoints[2].flagged, false);

        assert.equal(result.belowRanges.length, 1);
        const range = result.belowRanges[0];
        assert.equal(range.legIndex, 1);
        const from = sampling.samples[range.fromSample].distM;
        const to = sampling.samples[range.toSample].distM;
        assert.ok(from > 1600 && from < 1900, `starts at ${from}`);
        assert.ok(to > 2100 && to < 2400, `ends at ${to}`);

        assert.ok(Math.abs(result.legs[1].lowestClearanceM - 20) < 1);
        assert.ok(Math.abs(sampling.samples[result.legs[1].lowestAtSample].distM - 2000) < 31);
        assert.equal(result.legs[2].below, false);
        assert.equal(result.fallbackRanges.length, 0, 'a stock leg has no fallback to warn about');
        assert.equal(result.reason[range.toSample], AltitudeReason.BELOW_MIN);
    });

    test('flags a waypoint whose own altitude is under its minimum', () => {
        const route = northRoute([{ atM: 0, altAmslM: 500 }, { atM: 2000, altAmslM: 440 }]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });
        assert.equal(result.waypoints[1].low, true);
        assert.ok(Math.abs(result.waypoints[1].clearanceM - 40) < 0.01);
        assert.equal(result.waypoints[0].low, false);
    });

    test('uses each waypoint own minimum, and the global one where none is set', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 480 },
            { atM: 2000, altAmslM: 480 },                                   // 80 m over flat ground, global minimum 60
            { atM: 4000, altAmslM: 480, p3: p3With(TerrainMode.OFF, 100) }  // the same 80 m, but this leg wants 100
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: MIN_AGL_DEFAULT_M, params });

        assert.equal(result.legs[1].minM, 60);
        assert.equal(result.legs[1].below, false);
        assert.equal(result.legs[2].minM, 100);
        assert.equal(result.legs[2].below, true);
        assert.equal(result.waypoints[2].low, true);
        assert.equal(result.minM[sampling.legs[2].firstSample], 100);
        assert.equal(result.minM[sampling.legs[1].lastSample], 60);
    });

    test('floor: climbs over a ridge, keeps the minimum and comes back to the planned line', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 500 }, { atM: 6000, altAmslM: 500, p3: p3With(TerrainMode.FLOOR) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ridge(2500, 500, 80));
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });

        assert.equal(result.belowRanges.length, 0, 'the floor keeps the aircraft above the minimum');
        const lowest = result.legs[1].lowestClearanceM;
        assert.ok(lowest >= 60 && lowest < 80, `lowest clearance ${lowest}`);

        const climbing = sampling.samples.filter((_, k) => result.reason[k] === AltitudeReason.TERRAIN_CLIMB);
        assert.ok(climbing.length > 5);
        assert.ok(climbing[0].distM < 2200, `climb starts at ${climbing[0].distM}, before the ridge`);
        assert.ok(climbing[climbing.length - 1].distM < 3400);

        const end = result.altM[result.altM.length - 1];
        assert.ok(Math.abs(end - 500) < 1, `back on the planned altitude: ${end}`);

        // On stock firmware the same leg flies through the low stretch: that is the dashed warning.
        assert.equal(result.fallbackRanges.length, 1);
        assert.equal(result.legs[1].fallbackBelow, true);
        assert.equal(result.waypoints[1].flagged, false);
    });

    test('floor: a wall the aircraft cannot out-climb still shows as below the minimum', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 500 }, { atM: 4000, altAmslM: 500, p3: p3With(TerrainMode.FLOOR) }
        ]);
        const sampling = sampleLegs(route);
        // 300 m rise within 150 m of ground distance: far steeper than 5 m/s at 18 m/s.
        const terrainM = terrainAlong(sampling, (d) => (d < 2000 ? 400 : Math.min(700, 400 + (d - 2000) * 2)));
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params: { ...params, lookaheadM: 0 } });
        assert.ok(result.belowRanges.length >= 1);
        assert.equal(result.waypoints[1].flagged, true);
    });

    test('follow: keeps at least the waypoint clearance over rolling ground, and goes down into its valleys', () => {
        const ground = (d) => 400 + 30 * Math.sin(d / 400);
        const route = northRoute([
            { atM: 0, altAmslM: ground(0) + 90 },
            { atM: 6000, altAmslM: ground(6000) + 90, p3: p3With(TerrainMode.FOLLOW) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ground);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });

        // The valleys are 1250 m wide, the line looks 360 m ahead (20 s at 18 m/s): it comes
        // down into them, later than the ground does, and is back up before the next rise
        let lowestAlt = Infinity;
        let highestAlt = -Infinity;
        for (let k = 20; k < sampling.samples.length; k++) {
            assert.equal(result.reason[k], AltitudeReason.FOLLOW);
            assert.ok(result.clearanceM[k] > 88 && result.clearanceM[k] < 110, `sample ${k}: clearance ${result.clearanceM[k]}`);
            lowestAlt = Math.min(lowestAlt, result.altM[k]);
            highestAlt = Math.max(highestAlt, result.altM[k]);
        }
        assert.ok(highestAlt - lowestAlt > 45, `the altitude follows the 60 m of the ground: ${lowestAlt} to ${highestAlt}`);
        assert.equal(result.belowRanges.length, 0);
        assert.equal(result.legs[1].mode, TerrainMode.FOLLOW);
    });

    test('follow: a clearance under the minimum is raised to minimum plus the margin', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 500 }, { atM: 4000, altAmslM: 430, p3: p3With(TerrainMode.FOLLOW) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });
        const end = result.clearanceM[result.clearanceM.length - 1];
        assert.ok(Math.abs(end - 70) < 1, `held ${end} m`);
        assert.equal(result.waypoints[1].low, true, 'the stored altitude is still flagged: it is what stock firmware flies');
    });

    test('a terrain leg with its own minimum holds that one', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 600 }, { atM: 5000, altAmslM: 450, p3: p3With(TerrainMode.FLOOR, 100) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => 400);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });
        const end = result.clearanceM[result.clearanceM.length - 1];
        assert.ok(Math.abs(end - 110) < 1, `held ${end} m (100 m minimum + 10 m margin)`);
        assert.equal(result.belowRanges.length, 0);
    });

    test('route-aware look-ahead: climbs before the waypoint for a higher minimum on the next leg', () => {
        const flat = () => 400;
        const build = (nextP3) => {
            const route = northRoute([
                { atM: 0, altAmslM: 470 },
                { atM: 3000, altAmslM: 470, p3: p3With(TerrainMode.FLOOR) },
                { atM: 6000, altAmslM: 470, p3: nextP3 }
            ]);
            const sampling = sampleLegs(route);
            const result = analyseClearance({ route, sampling, terrainM: terrainAlong(sampling, flat), globalMinM: 60, params });
            return { sampling, result, atWaypoint: result.clearanceM[sampling.legs[1].lastSample] };
        };

        const higher = build(p3With(TerrainMode.FLOOR, 100));
        assert.ok(higher.atWaypoint >= 100, `arrives with ${higher.atWaypoint} m, the next leg wants 100`);
        assert.equal(higher.result.belowRanges.length, 0);
        const firstClimb = higher.sampling.samples.findIndex((_, k) => higher.result.reason[k] === AltitudeReason.TERRAIN_CLIMB);
        assert.ok(higher.sampling.samples[firstClimb].distM > 2400, 'the climb starts in the last part of the leg, not at its start');

        // Stock next leg: the planner flags it, but the firmware does not scan a leg it does not control.
        const stockNext = build(p3With(TerrainMode.OFF, 100));
        assert.ok(Math.abs(stockNext.atWaypoint - 70) < 1, `no early climb: ${stockNext.atWaypoint}`);
        assert.equal(stockNext.result.legs[2].below, true);
    });

    test('route-aware look-ahead: climbs before the waypoint for a ridge just after the turn', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 470 },
            { atM: 3000, altAmslM: 470, p3: p3With(TerrainMode.FLOOR) },
            { atM: 6000, altAmslM: 470, p3: p3With(TerrainMode.FLOOR) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ridge(3350, 300, 90));
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });
        const atWaypoint = result.altM[sampling.legs[1].lastSample];
        assert.ok(atWaypoint > 475, `already climbing at the waypoint: ${atWaypoint}`);
        assert.equal(result.belowRanges.length, 0);
    });

    test('terrain data missing mid-leg: never below the last terrain target', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 600 }, { atM: 6000, altAmslM: 420, p3: p3With(TerrainMode.FLOOR) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, (d) => (d > 3000 ? null : 400));
        const { altM, reason } = predictAltitude({ route, sampling, terrainM, globalMinM: 60, params });

        const lost = sampling.samples.findIndex(sample => sample.distM > 3000);
        assert.equal(reason[lost + 5], AltitudeReason.NO_DATA);
        const end = altM[altM.length - 1];
        assert.ok(end > 468, `held ${end}: the last terrain target was 470, the stock line ends at 420`);
    });

    test('terrain data missing from the start of a terrain leg: flies the stock line', () => {
        const route = northRoute([
            { atM: 0, altAmslM: 600 }, { atM: 6000, altAmslM: 420, p3: p3With(TerrainMode.FOLLOW) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, () => null);
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params });
        assert.ok(Math.abs(result.altM[result.altM.length - 1] - 420) < 1);
        assert.equal(result.legs[1].noData, true);
        assert.equal(result.belowRanges.length, 0, 'no clearance can be judged without terrain');
    });
});

// The firmware's rules for the target a terrain leg hands to the altitude controller
// (terrain_nav_mission_logic.h). tools/compare_terrain_rules.mjs checks these functions
// against the firmware's own on a grid of inputs.
describe('terrain target and the altitude controller', () => {
    const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

    test('the lag of a rising target, and the lead of the line that cancels it', () => {
        assert.ok(near(lagM(10, 0.4), 25), 'a target rising 10 m/s leaves the aircraft 25 m under it');
        assert.ok(near(lineTargetM(520, 4, 0.4), 530), 'the line raised by the lag of its rise');
        assert.equal(lineTargetM(520, 0, 0.4), 520);
        assert.equal(lineTargetM(520, -3, 0.4), 520, 'a line coming down has no lead');
        // The rise is smoothed over 1 s: a line that starts rising 5 m/s reads 5 m/s after a few seconds
        let rise = 0;
        let z = 500;
        for (let i = 0; i < 50; i++) {
            rise = lineRiseMs(rise, z, z + 0.5, 0.1, 20);
            z += 0.5;
        }
        assert.ok(near(rise, 5, 0.1), `rise after 5 s ${rise}`);
        assert.ok(near(lineRiseMs(0, 500, 530, 0.1, 20), 20 * 0.1 / 1.1), "a step counts no faster than the controller's fastest climb");
        assert.equal(lineRiseMs(3, 500, 400, 0, 20), 3, 'no time passed, no change');
    });

    test('the line: its rate, what it is never under, and the descent limit', () => {
        assert.equal(climbLineM(400, 60, 10, 50), 520);
        // Up: the slope to the point in view that needs the steepest line, at 30 m/s
        assert.ok(near(lineRateMs(true, 0.1, 30, 60, true, 10, 20), 3));
        assert.equal(lineRateMs(true, 1, 30, 60, true, 10, 20), 20, "no faster than the controller's fastest climb");
        assert.equal(lineRateMs(false, 0.1, 30, 60, true, 10, 20), 0, 'no answer: level');
        // Down: every point in view lower, toward the highest of them, eased over the last metres
        assert.equal(lineRateMs(true, -0.01, 30, 60, true, 10, 20), -10);
        assert.equal(lineRateMs(true, -0.01, 30, 20, true, 10, 20), -4);
        assert.equal(lineRateMs(true, -0.01, 30, 0, true, 10, 20), 0);
        assert.equal(lineRateMs(true, -0.01, 30, 60, false, 10, 20), 0, 'a point in view without data: not down');
        // One step of 0.1 s: held height at 150 m, minimum + margin at 140 m
        assert.ok(near(lineAdvanceM(200, 3, 0.1, 150, 10, 140, false, 0), 200.3));
        assert.ok(near(lineAdvanceM(145, 0, 0.1, 150, 10, 140, false, 0), 146), 'under the held height it rises to it at the planned rate');
        assert.equal(lineAdvanceM(120, -10, 0.1, 150, 10, 140, false, 0), 140, 'never under minimum + margin');
        assert.equal(lineAdvanceM(150, 0, 0.1, 150, 10, 140, true, 165), 165, "never under the look-ahead's climb line");
        assert.equal(lineAdvanceM(150, 0, 0.1, 150, 10, 140, false, 165), 150);
        assert.equal(lineNextExtraM(121, 120, 10), 9, "past the waypoint the line is aimed at the next leg's minimum + margin");
        assert.equal(limitDescentM(450, 550, 10, 0.4), 525);
        assert.equal(limitDescentM(540, 550, 10, 0.4), 540);
        assert.equal(limitDescentM(580, 550, 10, 0.4), 580);
    });

    test('the height a leg holds and the extra rise past a waypoint', () => {
        assert.equal(heldHeightM(TerrainMode.FLOOR, 200, 60, 10), 70);
        assert.equal(heldHeightM(TerrainMode.FOLLOW, 90, 60, 10), 90);
        assert.equal(heldHeightM(TerrainMode.FOLLOW, 65, 60, 10), 70);
        assert.equal(heldHeightM(TerrainMode.FOLLOW, null, 60, 10), 70);
        assert.equal(turnExtraRiseM(60, 100), 40);
        assert.equal(turnExtraRiseM(100, 60), -40);
    });

    // A follow leg up a steady slope, then level: 4 m/s of ground rise at 20 m/s.
    function slopeLeg(params) {
        const ground = (d) => 400 + 0.2 * Math.min(Math.max(d - 1000, 0), 3000);
        const route = northRoute([
            { atM: 0, altAmslM: ground(0) + 90 },
            { atM: 6000, altAmslM: ground(6000) + 90, p3: p3With(TerrainMode.FOLLOW) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ground);
        return { sampling, result: analyseClearance({ route, sampling, terrainM, globalMinM: 60, params }) };
    }

    test('follow: on a steady slope the aircraft holds its clearance, not the clearance less the lag', () => {
        // No look-ahead: the measured lead alone. Without it the aircraft would settle
        // 4 / 0.4 = 10 m under its clearance.
        const { sampling, result } = slopeLeg({ speedMs: 20, climbRateMs: 10, lookaheadM: 0 });
        const onSlope = sampling.samples
            .map((sample, k) => ({ distM: sample.distM, clearanceM: result.clearanceM[k] }))
            .filter(({ distM }) => distM > 2000 && distM < 4000);
        assert.ok(onSlope.length > 30);
        for (const { distM, clearanceM } of onSlope) {
            // (the prediction steps 1.5 s at a time and reads each step's target at its end,
            // which puts it a few metres high on a slope)
            assert.ok(Math.abs(clearanceM - 90) < 5, `at ${distM} m: clearance ${clearanceM}`);
        }
    });

    test('a climb the look-ahead asks for is flown above the bare minimum', () => {
        // The ridge of the floor test, with a plane whose planned climb (5 m/s) leaves a
        // lag of 12.5 m: it still crosses with more than the minimum in hand.
        const route = northRoute([
            { atM: 0, altAmslM: 500 }, { atM: 6000, altAmslM: 500, p3: p3With(TerrainMode.FLOOR) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ridge(2500, 300, 120));
        const result = analyseClearance({ route, sampling, terrainM, globalMinM: 60, params: { speedMs: 20, climbRateMs: 10 } });
        assert.equal(result.belowRanges.length, 0);
        assert.ok(result.legs[1].lowestClearanceM >= 65, `lowest clearance ${result.legs[1].lowestClearanceM}`);
    });

    test('a terrain leg descends no faster than the climb the look-ahead plans with', () => {
        // Follow over a 150 m cliff: the aircraft comes down at 5 m/s (half of 10), not 10.
        const ground = (d) => (d < 2000 ? 550 : 400);
        const route = northRoute([
            { atM: 0, altAmslM: ground(0) + 90 },
            { atM: 6000, altAmslM: ground(6000) + 90, p3: p3With(TerrainMode.FOLLOW) }
        ]);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, ground);
        const params = { speedMs: 20, climbRateMs: 10 };
        const { altM } = predictAltitude({ route, sampling, terrainM, globalMinM: 60, params });
        let fastest = 0;
        for (let k = 1; k < altM.length; k++) {
            const seconds = (sampling.samples[k].distM - sampling.samples[k - 1].distM) / params.speedMs;
            fastest = Math.min(fastest, (altM[k] - altM[k - 1]) / seconds);
        }
        assert.ok(fastest < -4.9 && fastest > -5.01, `fastest descent ${fastest} m/s`);
        assert.ok(Math.abs(altM[altM.length - 1] - 490) < 1, 'and still arrives at its clearance');

        // A stock leg keeps the altitude controller's own limit
        const stock = northRoute([{ atM: 0, altAmslM: 700 }, { atM: 1000, altAmslM: 500 }]);
        const stockSampling = sampleLegs(stock);
        const stockAlt = predictAltitude({
            route: stock, sampling: stockSampling, terrainM: terrainAlong(stockSampling, () => 300), globalMinM: 60, params
        }).altM;
        assert.ok(Math.abs(stockAlt[stockAlt.length - 1] - 500) < 12, `stock leg ends at ${stockAlt[stockAlt.length - 1]}`);
    });
});

describe('the turn at a waypoint', () => {
    // Flat ground at 400 m under the legs; the turn at the middle waypoint may cross ground
    // at 460 m (mission_turn.js finds it; here it is given). Every altitude is 70 m over the
    // flat: the floor of a 60 m minimum exactly.
    const flat = () => 400;
    const turnAt = (route, groundM) => [null, { index: 1, groundM, position: { lat: route[1].lat, lon: route[1].lon + 0.002 }, reachM: 300, backM: 0, alongOutM: 300 }, null];
    const routeWith = (p3) => northRoute([
        { atM: 0, altAmslM: 470 },
        { atM: 2000, altAmslM: 470, p3 },
        { atM: 4000, altAmslM: 470 }
    ]);
    const sampleAt = (sampling, distM) => sampling.samples.findIndex(sample => sample.distM >= distM);

    test('a floor leg climbs for the ground its turn crosses and keeps the floor until it is on course', () => {
        const route = routeWith(p3With(TerrainMode.FLOOR));
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, flat);
        const analysis = analyseClearance({ route, sampling, terrainM, globalMinM: 60, turns: turnAt(route, 460) });
        const corner = sampling.legs[1].lastSample;
        assert.ok(analysis.altM[corner] >= 460 + 60, `at the waypoint ${analysis.altM[corner]}`);
        assert.ok(analysis.altM[sampleAt(sampling, 2150)] >= 460 + 60, 'through the guard');
        assert.ok(Math.abs(analysis.altM[sampleAt(sampling, 3800)] - 470) < 3, 'then back on the stock line');
        assert.equal(analysis.turns[1].low, false);
        assert.equal(analysis.turns[1].fallbackLow, true, 'without terrain data the stock line is 10 m over it');
        assert.ok(Math.abs(analysis.turns[1].stockClearanceM - 10) < 0.5);
        assert.equal(analysis.waypoints[1].turnLow, false);
        assert.equal(analysis.turns[0], null);
        assert.equal(analysis.turns[2], null);
    });

    test('a stock leg does not: the turn is flagged at its waypoint', () => {
        const route = routeWith(0);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, flat);
        const analysis = analyseClearance({ route, sampling, terrainM, globalMinM: 60, turns: turnAt(route, 460) });
        assert.ok(Math.abs(analysis.altM[sampling.legs[1].lastSample] - 470) < 0.5);
        assert.equal(analysis.turns[1].low, true);
        assert.equal(analysis.turns[1].fallbackLow, false);
        assert.ok(Math.abs(analysis.turns[1].clearanceM - 10) < 0.5);
        assert.equal(analysis.waypoints[1].turnLow, true);
        assert.equal(analysis.waypoints[1].flagged, true);
        assert.equal(analysis.waypoints[1].legLow, false, 'the legs themselves are clear');
    });

    test('a turn over ground no higher than the legs changes nothing', () => {
        const route = routeWith(p3With(TerrainMode.FLOOR));
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, flat);
        const plain = analyseClearance({ route, sampling, terrainM, globalMinM: 60 });
        const withTurn = analyseClearance({ route, sampling, terrainM, globalMinM: 60, turns: turnAt(route, 400) });
        plain.altM.forEach((altitude, k) => assert.ok(Math.abs(altitude - withTurn.altM[k]) < 0.05, `sample ${k}`));
        assert.equal(withTurn.turns[1].low, false);
        assert.equal(withTurn.turns[1].fallbackLow, false);
        assert.deepEqual(plain.turns, [null, null, null]);
    });

    test('a turn whose ground is not known is left out', () => {
        const route = routeWith(0);
        const sampling = sampleLegs(route);
        const terrainM = terrainAlong(sampling, flat);
        const analysis = analyseClearance({ route, sampling, terrainM, globalMinM: 60, turns: turnAt(route, null) });
        assert.equal(analysis.turns[1], null);
        assert.equal(analysis.waypoints[1].flagged, false);
    });
});
