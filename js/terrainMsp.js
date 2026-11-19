'use strict';

/*
 * Asks the flight controller what its SD card terrain map says
 * (MSP2_INAV_TERRAIN_HEIGHT, this fork's firmware only). Kept out of
 * js/msp/MSPHelper.js and js/fc.js on purpose: upstream tests load those two
 * with every import stubbed by name, and a new import there breaks them.
 */

import MSP from './msp';
import MSPCodes from './msp/MSPCodes';
import {
    TERRAIN_HEIGHT_MAX_POINTS, TerrainHeightStatus, decodeTerrainHeightReply, encodeTerrainHeightRequest
} from './terrain_msp_codec.js';

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(points) {
    let response;
    try {
        response = await MSP.promise(MSPCodes.MSP2_INAV_TERRAIN_HEIGHT, encodeTerrainHeightRequest(points));
    } catch (error) {
        return null;
    }
    // Stock firmware answers an unknown command with an error frame
    if (!response || response.unsupported || !response.data) {
        return null;
    }
    return decodeTerrainHeightReply(response.data);
}

/* The terrain status of the flight controller, or null when the firmware does not have the command. */
export function queryTerrainStatus() {
    return request([]);
}

/*
 * Terrain heights at points [{ lat, lon }] (degrees) from the flight controller's
 * SD card. A block the firmware has not read yet answers "no data" and is read in
 * the background, so those points are asked again a few times before the answer
 * stands. Returns { status, heights }: status as queryTerrainStatus(), heights[i]
 * in metres or null (no tile for that point, not answered, or refused).
 * Null when the firmware does not have the command.
 */
export async function queryTerrainHeights(points, { retries = 8, retryDelayMs = 300 } = {}) {
    const heights = new Array(points.length).fill(null);
    let status = null;

    for (let start = 0; start < points.length; start += TERRAIN_HEIGHT_MAX_POINTS) {
        let pending = [];
        for (let i = start; i < Math.min(points.length, start + TERRAIN_HEIGHT_MAX_POINTS); i++) {
            pending.push(i);
        }
        for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
            if (attempt > 0) {
                await wait(retryDelayMs);
            }
            const reply = await request(pending.map(i => points[i]));
            if (!reply) {
                return status ? { status, heights } : null;
            }
            status = reply;
            if (!reply.enabled || reply.armed) {
                return { status, heights };
            }
            const still = [];
            pending.forEach((index, n) => {
                const answer = reply.points[n];
                if (answer && answer.status === TerrainHeightStatus.OK) {
                    heights[index] = answer.heightM;
                } else if (answer && answer.status === TerrainHeightStatus.NO_DATA) {
                    still.push(index);
                }
            });
            pending = still;
        }
    }

    if (!status) {
        status = await request([]);
    }
    return status ? { status, heights } : null;
}
