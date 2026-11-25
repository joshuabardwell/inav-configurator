/*
 * The turn a fixed-wing aircraft flies at a waypoint, as the firmware's terrain look-ahead
 * draws it (fork feature, firmware branch jb/wpterrain).
 *
 * The aircraft does not fly the corner of two legs. It flies over the waypoint and turns
 * outside the corner, or cuts inside it (COORD_FLYBY), or swings to the far side of the leg
 * first (COORD_FLYINTO): nav_fw_wp_turn_mode. The firmware scans that turn as a band of lanes,
 * from the bank the navigation controller plans with to half of it, and a terrain leg keeps
 * its floor until the aircraft is on course for the next leg. This module holds the same
 * rules, so that the planner can look at the ground a turn sweeps and not only at the ground
 * under the legs.
 *
 * Mirrors src/main/terrain/terrain_nav_mission_logic.h (terrainNavMissionPathStep and what it
 * calls): change both together. tools/test_terrain_rules.sh compares the two on the same
 * inputs. Pure functions, no DOM.
 */

const D = Math.PI / 180;

export const STEP_M = 30;                       // TERRAIN_NAV_MISSION_PATH_STEP_M
export const TURN_RADIUS_MIN_M = 30;            // TERRAIN_NAV_MISSION_TURN_RADIUS_MIN_M
export const TURNING_DEG = 10;                  // TERRAIN_NAV_MISSION_TURNING_DEG
export const LEAD_TAN_MAX = 3.7;                // TERRAIN_NAV_MISSION_LEAD_TAN_MAX
export const FLYBY_MIN_DEG = 30;                // TERRAIN_NAV_MISSION_FLYBY_MIN_DEG
export const FLYBY_MAX_DEG = 160;               // TERRAIN_NAV_MISSION_FLYBY_MAX_DEG
export const PLAN_RADIUS_MAX_M = 300;           // TERRAIN_NAV_MISSION_PLAN_RADIUS_MAX_M
export const BAND_MAX_LANES = 3;                // TERRAIN_NAV_BAND_MAX_LANES
export const TURN_ZONE_SETTLE_STEPS = 3;        // TERRAIN_NAV_MISSION_TURN_ZONE_SETTLE_STEPS
export const TRACK_CLOSE_S = 3;                 // TERRAIN_NAV_MISSION_TRACK_CLOSE_S
export const TRACK_MAX_ANGLE_DEG = 60;          // TERRAIN_NAV_MISSION_TRACK_MAX_ANGLE_DEG
export const FLYINTO_MIN_DEG = 30;              // TERRAIN_NAV_MISSION_FLYINTO_MIN_DEG
export const ESTABLISHED_DEG = 15;              // TERRAIN_NAV_MISSION_ESTABLISHED_DEG
export const GUARD_MIN_MS = 20000;              // TERRAIN_NAV_MISSION_GUARD_MIN_MS
export const GUARD_MAX_MS = 90000;              // TERRAIN_NAV_MISSION_GUARD_MAX_MS

/* nav_fw_wp_turn_mode, in the firmware's order. */
export const TurnMode = Object.freeze({ DIRECT: 0, COORD_FLYBY: 1, COORD_FLYOVER: 2, COORD_FLYINTO: 3 });

/* What the sweep assumes when the flight controller's settings are not known: the firmware's
   defaults, and the roll ease time of its default tune. */
export const TurnDefaults = Object.freeze({
    turnMode: TurnMode.COORD_FLYBY,     // nav_fw_wp_turn_mode
    bankDeg: 35,                        // nav_fw_bank_angle
    tracking: false,                    // nav_fw_wp_tracking_accuracy > 0
    trackMaxAngleDeg: 60,               // nav_fw_wp_tracking_max_angle
    maxLeadMs: 6000,                    // nav_fw_wp_turn_max_lead_time
    wpRadiusM: 1,                       // nav_wp_radius
    easeS: 0.6                          // the controller's roll ease time (fwTurnEaseTimeMs)
});

export function wrap180(deg) {
    while (deg > 180) deg -= 360;
    while (deg <= -180) deg += 360;
    return deg;
}

/* terrainNavMissionTurnRadiusM: v^2 / (g tan(bank)), never under one step. */
export function turnRadiusM(speedMs, bankDeg) {
    const tanBank = Math.tan(bankDeg * D);
    if (!(tanBank > 0.01)) return 1e6;
    return Math.max(TURN_RADIUS_MIN_M, speedMs * speedMs / (9.80665 * tanBank));
}

/* terrainNavMissionMaxTurnPerStepDeg */
export function maxTurnPerStepDeg(radiusM) {
    return STEP_M / radiusM / D;
}

/*
 * terrainNavMissionSwitchDistM: how far before the waypoint the navigation switches to the
 * next. COORD_FLYBY starts its turn R tan(turn / 2) early, plus the distance its roll-in
 * takes (1.5 x the ease time of flight), never more than maxLeadMs of flight.
 */
export function switchDistM(flyBy, turnAngleDeg, radiusM, speedMs, maxLeadMs, wpRadiusM, easeS = 0) {
    let dist = wpRadiusM;
    const angle = Math.abs(turnAngleDeg);
    if (flyBy && angle > FLYBY_MIN_DEG && angle < FLYBY_MAX_DEG) {
        const lead = Math.min(
            1.5 * speedMs * easeS + Math.min(radiusM, PLAN_RADIUS_MAX_M) * Math.min(Math.tan(angle * 0.5 * D), LEAD_TAN_MAX),
            speedMs * maxLeadMs * 0.001);
        if (lead > dist) dist = lead;
    }
    return dist;
}

/* terrainNavBandFromBank: lane 0 at the planning bank, the last at half of it. */
export function bandFromBank(speedMs, bankDeg, lanes = BAND_MAX_LANES) {
    const tight = maxTurnPerStepDeg(turnRadiusM(speedMs, bankDeg));
    const wide = maxTurnPerStepDeg(turnRadiusM(speedMs, bankDeg * 0.5));
    const maxTurnDeg = [];
    for (let i = 0; i < lanes; i++) {
        maxTurnDeg.push(lanes === 1 ? tight : tight + (wide - tight) * i / (lanes - 1));
    }
    return { laneCount: lanes, maxTurnDeg };
}

/*
 * terrainNavMissionWantedCourseDeg: the course a lane wants on the way to a point toN, toE
 * from it. With the leg's line given (trackLine) and the point roughly ahead, the tracker's
 * course onto the line; otherwise straight at the point.
 */
export function wantedCourseDeg(courseDeg, toN, toE, trackLine, lineCourseDeg, speedMs, trackMaxAngleDeg) {
    const direct = Math.atan2(toE, toN) / D;
    if (!trackLine || Math.abs(wrap180(direct - courseDeg)) >= 90) return direct;
    const crossTrackM = Math.sin(lineCourseDeg * D) * toN - Math.cos(lineCourseDeg * D) * toE;    // + = right of the line
    const speed = speedMs > 5 ? speedMs : 5;
    const sinMax = Math.sin((trackMaxAngleDeg > 0 ? trackMaxAngleDeg : TRACK_MAX_ANGLE_DEG) * D);
    const angle = Math.asin(Math.min(Math.abs(crossTrackM) / (TRACK_CLOSE_S * speed), sinMax)) / D;
    return crossTrackM > 0 ? lineCourseDeg - angle : lineCourseDeg + angle;
}

/*
 * terrainNavMissionFlyIntoPlan: COORD_FLYINTO's S ahead of a waypoint. Returns null where the
 * controller flies no S, else { triggerM, dir, counterEndDeg, gapSteps, outCourseDeg }.
 */
export function flyIntoPlan(inCourseDeg, turnDeg, radiusM, speedMs, easeS) {
    if (!(Math.abs(turnDeg) > FLYINTO_MIN_DEG)) return null;
    const dir = turnDeg > 0 ? 1 : -1;
    const inRad = inCourseDeg * D, outRad = (inCourseDeg + turnDeg) * D;
    const gapM = 2 * speedMs * easeS;
    const mainN = radiusM * Math.cos(outRad + dir * Math.PI / 2), mainE = radiusM * Math.sin(outRad + dir * Math.PI / 2);
    const legN = radiusM * Math.cos(inRad - dir * Math.PI / 2), legE = radiusM * Math.sin(inRad - dir * Math.PI / 2);
    const wN = mainN - legN, wE = mainE - legE;
    const wAlong = wN * Math.cos(inRad) + wE * Math.sin(inRad);
    const disc = wAlong * wAlong - (wN * wN + wE * wE) + 4 * radiusM * radiusM + gapM * gapM;
    if (!(disc > 0)) return null;
    const startM = wAlong - Math.sqrt(disc);
    if (!(startM < 0)) return null;
    const counterN = legN + startM * Math.cos(inRad), counterE = legE + startM * Math.sin(inRad);
    const centresRad = Math.atan2(mainE - counterE, mainN - counterN);
    const betaRad = Math.atan2(gapM, 2 * radiusM);
    return {
        triggerM: -startM + 1.5 * speedMs * easeS,
        dir,
        counterEndDeg: wrap180((centresRad - dir * (Math.PI / 2 - betaRad)) / D),
        gapSteps: Math.min(255, Math.round(gapM / STEP_M)),
        outCourseDeg: wrap180(inCourseDeg + turnDeg)
    };
}

/* terrainNavMissionOnCourse: the aircraft is on course for the leg it flies. */
export function onCourse(courseDeg, toWpDeg, trackLine, lineCourseDeg, arcActive) {
    if (arcActive || Math.abs(wrap180(toWpDeg - courseDeg)) > ESTABLISHED_DEG) return false;
    return !trackLine || Math.abs(wrap180(lineCourseDeg - courseDeg)) <= ESTABLISHED_DEG;
}

/* terrainNavMissionGuardMaxMs: a full circle at half the planning bank, within limits. */
export function guardMaxMs(speedMs, planningBankDeg) {
    const tanHalf = Math.tan(planningBankDeg * 0.5 * D);
    let ms = GUARD_MAX_MS;
    if (tanHalf > 0.01) ms = 2 * Math.PI * speedMs / (9.80665 * tanHalf) * 1000;
    return Math.trunc(Math.min(GUARD_MAX_MS, Math.max(GUARD_MIN_MS, ms)));
}

/* terrainNavMissionPathStart */
export function laneStart(courseDeg) {
    return { n: 0, e: 0, course: courseDeg, past: false, turning: false, wantedTurnDeg: 0, settled: 0, into: 0, gap: 0,
        arcDone: false, nextArc: 0 };
}

/* terrainNavMissionForcedTurn: toward courseDeg in direction dir, the long way round if need be. */
function forcedTurn(s, courseDeg, dir, maxTurnDeg) {
    let left = dir * wrap180(courseDeg - s.course);
    if (left < -maxTurnDeg) left += 360;
    const turn = Math.max(0, Math.min(maxTurnDeg, left));
    s.wantedTurnDeg = Math.abs(left);
    s.turning = true;
    s.course = wrap180(s.course + dir * turn);
    return left <= maxTurnDeg;
}

function move(s) {
    s.n += Math.cos(s.course * D) * STEP_M;
    s.e += Math.sin(s.course * D) * STEP_M;
}

/*
 * terrainNavMissionPathStep: moves a lane one step on, its course changing by at most
 * maxTurnDeg. False, without moving, when the lane ends.
 *
 * path: { wpN, wpE, switchDistM, nextLegValid, nextWpN, nextWpE } in metres north and east of
 * where the lane starts, and, all optional:
 *   turnZoneOnly    past the waypoint a lane ends once it has come round onto its course and
 *                   flown the roll-out: the leg after is not a terrain leg
 *   guard           the same on the way to the active waypoint: the turn onto this leg is
 *                   still being flown
 *   lineCourseDeg, nextLineCourseDeg   the course of the leg into the waypoint and of the leg
 *                   after it (null: none), when the waypoint tracker holds the aircraft on the
 *                   leg's line; speedMs and trackMaxAngleDeg go with them
 *   flyInto         flyIntoPlan()'s answer for the waypoint
 *   arc             { dir, outCourseDeg }: an arc the turn coordinator is flying onto the
 *                   active leg
 *   nextArc         { dir, outCourseDeg }: the arc it will fly onto the next leg from the
 *                   switch on (COORD_FLYBY): the lane turns onto that leg's course first
 */
export function laneStep(s, path, maxTurnDeg) {
    s.turning = false;
    if (path.arc && !s.arcDone) {
        if (forcedTurn(s, path.arc.outCourseDeg, path.arc.dir, maxTurnDeg)) s.arcDone = true;
        move(s);
        return true;
    }
    if (s.nextArc === 1) {
        if (forcedTurn(s, path.nextArc.outCourseDeg, path.nextArc.dir, maxTurnDeg)) s.nextArc = 2;
        move(s);
        return true;
    }

    const into = path.flyInto || null;
    if (!s.past && into && s.into === 0) {
        const dn = path.wpN - s.n, de = path.wpE - s.e;
        if (dn * dn + de * de < into.triggerM * into.triggerM) s.into = 1;
    }
    if (!s.past && s.into > 0) {
        // the S: counter arc (1), straight (2), main arc (3)
        if (s.into === 1) {
            if (forcedTurn(s, into.counterEndDeg, -into.dir, maxTurnDeg)) {
                s.into = 2;
                s.gap = into.gapSteps;
            }
        } else if (s.into === 2) {
            s.wantedTurnDeg = 0;
            if (s.gap === 0) s.into = 3; else s.gap--;
        }
        if (s.into === 3 && forcedTurn(s, into.outCourseDeg, into.dir, maxTurnDeg)) {
            if (!path.nextLegValid) return false;
            s.past = true;
        }
        move(s);
        return true;
    }

    if (!s.past) {
        const dn = path.wpN - s.n, de = path.wpE - s.e;
        const reach = (path.nextLegValid && path.switchDistM > STEP_M) ? path.switchDistM : STEP_M;
        if (dn * dn + de * de < reach * reach) {
            if (!path.nextLegValid) return false;
            s.past = true;
            if (path.nextArc) {
                s.nextArc = forcedTurn(s, path.nextArc.outCourseDeg, path.nextArc.dir, maxTurnDeg) ? 2 : 1;
                move(s);
                return true;
            }
        }
    }
    const toN = (s.past ? path.nextWpN : path.wpN) - s.n, toE = (s.past ? path.nextWpE : path.wpE) - s.e;
    if (s.past && toN * toN + toE * toE < STEP_M * STEP_M) return false;
    const lineCourse = s.past ? path.nextLineCourseDeg : path.lineCourseDeg;
    const tracked = lineCourse !== null && lineCourse !== undefined;
    const want = wantedCourseDeg(s.course, toN, toE, tracked, tracked ? lineCourse : 0, path.speedMS || 0, path.trackMaxAngleDeg || 0);
    const err = wrap180(want - s.course);
    s.wantedTurnDeg = Math.abs(err);
    s.turning = s.wantedTurnDeg > TURNING_DEG;
    if (path.turnZoneOnly && (s.past || path.guard)) {
        // On course, as the turn guard judges it: not turning and, with the tracker on, on the
        // leg's course, not still on the way to its line
        const on = !s.turning && (!tracked || Math.abs(wrap180(lineCourse - s.course)) <= ESTABLISHED_DEG);
        s.settled = on ? s.settled + 1 : 0;
        if (s.settled > TURN_ZONE_SETTLE_STEPS) return false;
    }
    s.course = wrap180(s.course + Math.max(-maxTurnDeg, Math.min(maxTurnDeg, err)));
    move(s);
    return true;
}

/*
 * The ground positions the turn at a waypoint may take the aircraft over: the firmware's band
 * of lanes, walked from the inbound leg round the corner until every lane is on course for
 * the next waypoint, with the points between neighbouring lanes.
 *
 *   inCourseDeg   course of the leg into the waypoint;  turnDeg   change of course there, + right
 *   legInM, legOutM   lengths of the two legs
 *   speedMs       ground speed;  settings   TurnDefaults, with the flight controller's values
 *
 * Returns { points, reachM, backM, alongOutM, radiusM }: points [{ northM, eastM }] relative to
 * the waypoint, reachM the furthest of them from it, backM how far before the waypoint the turn
 * begins, alongOutM how far along the next leg it ends (the last lane on course), radiusM the
 * turn radius at the planning bank.
 */
export function turnSweep({ inCourseDeg, turnDeg, legInM, legOutM, speedMs, settings = {} }) {
    const cfg = { ...TurnDefaults, ...settings };
    const radiusM = turnRadiusM(speedMs, cfg.bankDeg);
    const band = bandFromBank(speedMs, cfg.bankDeg);
    const outCourseDeg = inCourseDeg + turnDeg;
    const flyBy = cfg.turnMode === TurnMode.COORD_FLYBY;
    const into = cfg.turnMode === TurnMode.COORD_FLYINTO ? flyIntoPlan(inCourseDeg, turnDeg, radiusM, speedMs, cfg.easeS) : null;
    const switchM = switchDistM(flyBy, turnDeg, radiusM, speedMs, cfg.maxLeadMs, cfg.wpRadiusM, cfg.easeS);
    // COORD_FLYBY flies an arc onto the next leg's course from its switch on, for any turn
    // sharper than FLYINTO_MIN_DEG (the coordinator's own limit for an arc)
    const nextArc = flyBy && Math.abs(turnDeg) > FLYINTO_MIN_DEG
        ? { dir: turnDeg > 0 ? 1 : -1, outCourseDeg: wrap180(outCourseDeg) } : null;

    // The lanes start on the inbound leg, far enough back to hold everything the turn begins with
    const backM = Math.min(legInM, Math.max(switchM, into ? into.triggerM : 0) + 4 * STEP_M);
    const startN = -backM * Math.cos(inCourseDeg * D), startE = -backM * Math.sin(inCourseDeg * D);
    const path = {
        wpN: -startN, wpE: -startE, switchDistM: switchM, nextLegValid: true,
        nextWpN: -startN + legOutM * Math.cos(outCourseDeg * D), nextWpE: -startE + legOutM * Math.sin(outCourseDeg * D),
        turnZoneOnly: true, speedMS: speedMs, trackMaxAngleDeg: cfg.trackMaxAngleDeg,
        lineCourseDeg: null, nextLineCourseDeg: cfg.tracking ? wrap180(outCourseDeg) : null,
        flyInto: into, nextArc
    };

    const lanes = band.maxTurnDeg.map(() => laneStart(inCourseDeg));
    const alive = lanes.map(() => true);
    const points = [];
    let reachM = 0, alongOutM = 0, turnBackM = 0;
    const add = (n, e) => {
        const northM = n + startN, eastM = e + startE;
        points.push({ northM, eastM });
        reachM = Math.max(reachM, Math.hypot(northM, eastM));
        turnBackM = Math.max(turnBackM, -(northM * Math.cos(inCourseDeg * D) + eastM * Math.sin(inCourseDeg * D)));
        alongOutM = Math.max(alongOutM, northM * Math.cos(outCourseDeg * D) + eastM * Math.sin(outCourseDeg * D));
    };
    let started = false;        // the straight run-in lies on the leg, which is sampled as part of the route
    for (let step = 0; step < 400 && alive.some(Boolean); step++) {
        lanes.forEach((lane, i) => {
            if (alive[i] && !laneStep(lane, path, band.maxTurnDeg[i])) alive[i] = false;
        });
        started = started || lanes.some((lane, i) => alive[i] && (lane.turning || lane.past || lane.into > 0));
        if (!started) continue;
        lanes.forEach((lane, i) => {
            if (!alive[i]) return;
            add(lane.n, lane.e);
            if (i === 0 || !alive[i - 1]) return;
            const dn = lane.n - lanes[i - 1].n, de = lane.e - lanes[i - 1].e;
            const pieces = Math.ceil(Math.hypot(dn, de) / STEP_M);
            for (let p = 1; p < pieces; p++) add(lanes[i - 1].n + dn * p / pieces, lanes[i - 1].e + de * p / pieces);
        });
    }
    return { points, reachM, backM: Math.min(turnBackM, legInM), alongOutM: Math.min(alongOutM, legOutM), radiusM };
}

const M_PER_DEG = 111319.5;     // the firmware's metres per degree of latitude

/* A point northM, eastM from a position, as { lat, lon }. */
export function offsetPosition(from, northM, eastM) {
    return {
        lat: from.lat + northM / M_PER_DEG,
        lon: from.lon + eastM / (M_PER_DEG * Math.cos(from.lat * D))
    };
}

function courseBetween(from, to) {
    const north = (to.lat - from.lat) * M_PER_DEG;
    const east = (to.lon - from.lon) * M_PER_DEG * Math.cos((from.lat + to.lat) * 0.5 * D);
    return { courseDeg: Math.atan2(east, north) / D, lengthM: Math.hypot(north, east) };
}

/*
 * The sweep of every turn of a route. route[i] = { lat, lon } in flown order; a turn is flown
 * at every waypoint that has a leg into it and a leg out of it (not the first, not the last).
 *
 * Returns turns[i] (null where there is no turn): turnSweep()'s answer plus turnDeg and
 * positions, the sweep's points as { lat, lon }.
 */
export function routeTurnSweeps(route, speedMs, settings = {}) {
    return route.map((wp, i) => {
        if (i === 0 || i >= route.length - 1) return null;
        const legIn = courseBetween(route[i - 1], wp);
        const legOut = courseBetween(wp, route[i + 1]);
        if (!(legIn.lengthM > 1) || !(legOut.lengthM > 1)) return null;
        const turnDeg = wrap180(legOut.courseDeg - legIn.courseDeg);
        const sweep = turnSweep({ inCourseDeg: legIn.courseDeg, turnDeg, legInM: legIn.lengthM, legOutM: legOut.lengthM, speedMs, settings });
        return { ...sweep, turnDeg, positions: sweep.points.map(point => offsetPosition(wp, point.northM, point.eastM)) };
    });
}

/*
 * The highest ground of each turn's sweep. turns from routeTurnSweeps(); groundM[i][j] the
 * ground elevation at turns[i].positions[j], or null.
 *
 * Returns per waypoint null or { index, groundM, position, reachM, backM, alongOutM, known }:
 * the highest ground the turn may cross and where; known is false when no point had data.
 */
export function turnGround(turns, groundM) {
    return turns.map((turn, i) => {
        if (!turn) return null;
        let highest = null;
        let position = null;
        (groundM[i] || []).forEach((height, j) => {
            if (height !== null && height !== undefined && (highest === null || height > highest)) {
                highest = height;
                position = turn.positions[j];
            }
        });
        return {
            index: i, groundM: highest, position, reachM: turn.reachM, backM: turn.backM, alongOutM: turn.alongOutM,
            known: highest !== null
        };
    });
}
