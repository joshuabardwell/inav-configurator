import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    STEP_M,
    TurnMode,
    bandFromBank,
    flyIntoPlan,
    guardMaxMs,
    laneStart,
    laneStep,
    maxTurnPerStepDeg,
    offsetPosition,
    onCourse,
    routeTurnSweeps,
    switchDistM,
    turnGround,
    turnRadiusM,
    turnSweep,
    wantedCourseDeg,
    wrap180
} from '../js/mission_turn.js';

const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

/* The turns tools/test_fw_turn_modes.py flew in SITL: 40 m/s, 45 degrees of bank. */
const SPEED = 40;
const BANK = 45;
const RADIUS = turnRadiusM(SPEED, BANK);
const settings = (turnMode, extra = {}) => ({ turnMode, bankDeg: BANK, wpRadiusM: 10, ...extra });

function sweep(turnMode, turnDeg, extra = {}) {
    return turnSweep({ inCourseDeg: 0, turnDeg, legInM: 1500, legOutM: 1500, speedMs: SPEED, settings: settings(turnMode, extra) });
}

/* How far the sweep reaches: inside the corner, outside it past the waypoint, and to the far
   side of the inbound leg. The inbound leg runs north and the turn is to the right. */
function extent(result, turnDeg) {
    const out = turnDeg * Math.PI / 180;
    let inside = 0, beyond = 0, away = 0;
    for (const { northM, eastM } of result.points) {
        const rightOfOut = -Math.sin(out) * northM + Math.cos(out) * eastM;
        if (northM < 0 && eastM > 0 && rightOfOut > 0) inside = Math.max(inside, Math.min(eastM, rightOfOut));
        beyond = Math.max(beyond, northM);
        away = Math.max(away, -eastM);
    }
    return { inside, beyond, away };
}

describe('turn radius and the band', () => {
    test('radius is v^2 / (g tan bank), never under one step', () => {
        assert.ok(near(RADIUS, 163.2, 0.2));
        assert.equal(turnRadiusM(8, 80), 30);
        assert.ok(turnRadiusM(30, 0) > 1e5);
    });

    test('the band runs from the planning bank to half of it', () => {
        const band = bandFromBank(SPEED, BANK);
        assert.equal(band.laneCount, 3);
        assert.ok(near(band.maxTurnDeg[0], maxTurnPerStepDeg(RADIUS)));
        assert.ok(near(band.maxTurnDeg[2], maxTurnPerStepDeg(turnRadiusM(SPEED, BANK / 2))));
        assert.ok(band.maxTurnDeg[0] > band.maxTurnDeg[1] && band.maxTurnDeg[1] > band.maxTurnDeg[2]);
    });

    test('the fly-by lead is R tan(turn / 2), capped by the lead time, and only between 30 and 160 degrees', () => {
        assert.ok(near(switchDistM(true, 60, 100, 41, 3000, 10), 57.7, 0.2));
        assert.ok(near(switchDistM(true, 141, 171, 41, 3000, 10), 123, 0.5));
        assert.equal(switchDistM(true, 170, 171, 41, 3000, 10), 10);
        assert.equal(switchDistM(false, 90, 171, 41, 3000, 10), 10);
    });
});

describe('the course a lane wants', () => {
    test('without the tracker: straight at the waypoint', () => {
        assert.ok(near(wantedCourseDeg(0, 2000, -200, false, 0, SPEED, 0), Math.atan2(-200, 2000) * 180 / Math.PI));
    });

    test('with the tracker: onto the leg, steeper the further off, at most the tracker limit', () => {
        assert.ok(near(wantedCourseDeg(0, 2000, -60, true, 0, SPEED, 0), -30));
        assert.ok(near(wantedCourseDeg(0, 2000, 60, true, 0, SPEED, 0), 30));
        assert.ok(near(wantedCourseDeg(0, 2000, -200, true, 0, SPEED, 0), -60));
        assert.ok(near(wantedCourseDeg(0, 2000, -200, true, 0, SPEED, 30), -30));
    });

    test('a waypoint behind is turned to first', () => {
        assert.ok(near(wantedCourseDeg(0, -2000, -200, true, 0, SPEED, 0), Math.atan2(-200, -2000) * 180 / Math.PI));
    });
});

describe('COORD_FLYINTO plan', () => {
    test('a 90 degree turn starts R + sqrt(3 R^2 + gap^2) + the roll-in lead before the waypoint', () => {
        const plan = flyIntoPlan(0, 90, RADIUS, SPEED, 0.6);
        assert.ok(near(plan.triggerM, 485.5, 2));
        assert.equal(plan.dir, 1);
        assert.ok(plan.counterEndDeg < -50 && plan.counterEndDeg > -60);
        assert.equal(plan.outCourseDeg, 90);
    });

    test('a left turn mirrors it, and a turn of 30 degrees or less has no S', () => {
        const left = flyIntoPlan(0, -175, RADIUS, SPEED, 0.6);
        assert.equal(left.dir, -1);
        assert.ok(left.counterEndDeg > 0);
        assert.equal(flyIntoPlan(0, 20, RADIUS, SPEED, 0.6), null);
    });
});

describe('lanes', () => {
    test('a turn-zone lane goes round the corner and ends on course, after three straight steps', () => {
        const path = { wpN: 300, wpE: 0, switchDistM: 10, nextLegValid: true, nextWpN: 300, nextWpE: 1500, turnZoneOnly: true };
        const lane = laneStart(0);
        const turnDeg = maxTurnPerStepDeg(RADIUS);
        const flown = [];
        while (flown.length < 200 && laneStep(lane, path, turnDeg)) flown.push({ ...lane });
        assert.ok(flown.length > 15 && flown.length < 30);
        const last = flown[flown.length - 1];
        assert.ok(last.past && !last.turning && last.e < 500);
        assert.ok(flown[flown.length - 4].turning && !flown[flown.length - 3].turning);
    });

    test('an arc in progress is flown on the way it goes, the long way round if need be', () => {
        const path = { wpN: -1500, wpE: -130, nextLegValid: false, arc: { dir: 1, outCourseDeg: -175 } };
        const lane = laneStart(0);
        const turnDeg = maxTurnPerStepDeg(RADIUS);
        for (let i = 0; i < 6; i++) laneStep(lane, path, turnDeg);
        assert.ok(lane.course > 50 && lane.e > 50);
        for (let i = 0; i < 34; i++) laneStep(lane, path, turnDeg);
        assert.ok(lane.arcDone && Math.abs(wrap180(lane.course + 175)) < 20);
    });
});

describe('the sweep of a turn, against what SITL flew (40 m/s, 45 degrees)', () => {
    test('COORD_FLYBY at 90 degrees cuts inside, and goes past the waypoint less than a fly-over', () => {
        const { inside, beyond, away } = extent(sweep(TurnMode.COORD_FLYBY, 90), 90);
        assert.ok(inside >= 0.25 * RADIUS, `inside ${inside}`);          // flown: 0.30 R
        // the widest lane is a turn at half the bank: it starts as early and still overshoots
        assert.ok(beyond < extent(sweep(TurnMode.COORD_FLYOVER, 90), 90).beyond - 2 * STEP_M, `beyond ${beyond}`);
        assert.ok(away < STEP_M);
    });

    test('DIRECT and COORD_FLYOVER at 90 degrees go outside: past the waypoint by more than a radius', () => {
        for (const mode of [TurnMode.DIRECT, TurnMode.COORD_FLYOVER]) {
            const { inside, beyond } = extent(sweep(mode, 90), 90);
            assert.ok(beyond >= 1.3 * RADIUS, `beyond ${beyond}`);       // flown: 1.14 to 1.32 R
            assert.ok(inside < STEP_M, `inside ${inside}`);
        }
    });

    test('a 175 degree turn has no fly-by lead: every mode but fly-into goes past the waypoint and two radii to the side', () => {
        for (const mode of [TurnMode.DIRECT, TurnMode.COORD_FLYBY, TurnMode.COORD_FLYOVER]) {
            const result = sweep(mode, 175);
            const east = Math.max(...result.points.map(point => point.eastM));
            assert.ok(extent(result, 175).beyond >= 1.1 * RADIUS);      // flown: 1.05 to 1.12 R
            assert.ok(east >= 2.2 * RADIUS, `east ${east}`);             // flown: 2.04 to 2.22 R
        }
    });

    test('COORD_FLYINTO swings to the far side of the inbound leg before the waypoint', () => {
        assert.ok(extent(sweep(TurnMode.COORD_FLYINTO, 90), 90).away >= 0.93 * RADIUS);     // flown: 0.93 R
        const reversal = extent(sweep(TurnMode.COORD_FLYINTO, 175), 175);
        assert.ok(reversal.away >= 1.89 * RADIUS, `away ${reversal.away}`);                 // flown: 1.89 R
        assert.ok(reversal.beyond >= 0.7 * RADIUS, `beyond ${reversal.beyond}`);            // flown: 0.96 R
    });

    test('the other modes do not go to the far side', () => {
        for (const mode of [TurnMode.DIRECT, TurnMode.COORD_FLYBY, TurnMode.COORD_FLYOVER]) {
            assert.ok(extent(sweep(mode, 90), 90).away < STEP_M);
        }
    });

    test('with the tracker on the sweep comes back onto the next leg', () => {
        const off = sweep(TurnMode.COORD_FLYOVER, 90);
        const on = sweep(TurnMode.COORD_FLYOVER, 90, { tracking: true });
        const lastNorth = (result) => result.points[result.points.length - 1].northM;
        assert.ok(Math.abs(lastNorth(on)) < 40, `ends ${lastNorth(on)} m off the leg`);
        assert.ok(on.alongOutM > 100 && off.alongOutM > 100);
    });

    test('a short inbound leg bounds where the lanes start', () => {
        const result = turnSweep({ inCourseDeg: 0, turnDeg: 90, legInM: 60, legOutM: 1500, speedMs: SPEED, settings: settings(TurnMode.DIRECT) });
        assert.ok(Math.min(...result.points.map(point => point.northM)) >= -60 - STEP_M);
    });
});

describe('a route', () => {
    const home = { lat: 47.3, lon: 8.5 };
    const corner = offsetPosition(home, 1500, 0);
    const route = [home, corner, offsetPosition(corner, 0, 1500)];

    test('a turn at every waypoint with a leg in and a leg out', () => {
        const turns = routeTurnSweeps(route, SPEED, settings(TurnMode.DIRECT));
        assert.equal(turns[0], null);
        assert.equal(turns[2], null);
        assert.ok(near(turns[1].turnDeg, 90, 0.5));
        assert.equal(turns[1].positions.length, turns[1].points.length);
        assert.ok(turns[1].positions.every(position => position.lat > home.lat));
    });

    test('the highest ground of a sweep, and where it is', () => {
        const turns = routeTurnSweeps(route, SPEED, settings(TurnMode.DIRECT));
        // a rise north of the corner, where only the overshoot goes
        const ground = turns.map(turn => turn && turn.positions.map(position => (position.lat > corner.lat + 0.0005 ? 520 : 400)));
        const result = turnGround(turns, ground);
        assert.equal(result[0], null);
        assert.equal(result[1].groundM, 520);
        assert.ok(result[1].position.lat > corner.lat + 0.0005);
        assert.ok(result[1].known);
        const noData = turnGround(turns, turns.map(turn => turn && turn.positions.map(() => null)));
        assert.equal(noData[1].known, false);
        assert.equal(noData[1].groundM, null);
    });
});

describe('when a turn guard ends', () => {
    test('on course: within 15 degrees of the bearing to the waypoint, no arc, and of the leg with the tracker on', () => {
        assert.ok(onCourse(10, 0, false, 0, false));
        assert.ok(!onCourse(20, 0, false, 0, false));
        assert.ok(!onCourse(0, 0, false, 0, true));
        assert.ok(onCourse(30, 30, true, 40, false));
        assert.ok(!onCourse(30, 30, true, 50, false));
    });

    test('the limit: a full circle at half the planning bank, 20 to 90 s', () => {
        assert.ok(guardMaxMs(40, 45) > 61000 && guardMaxMs(40, 45) < 63000);
        assert.equal(guardMaxMs(10, 45), 20000);
        assert.equal(guardMaxMs(40, 5), 90000);
    });
});
