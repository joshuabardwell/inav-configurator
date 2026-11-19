'use strict';

/*
 * Payloads of MSP2_INAV_TERRAIN_HEIGHT (0x2F02, this fork's firmware only): what
 * the terrain map on the flight controller's SD card says at a few points.
 *
 *   request  n x { I32 lat, I32 lon } in degrees x 1e7, n = 0..8
 *   reply    U8 version (1), U8 flags, U8 block cache size, I16 home terrain height [m], U8 n,
 *            n x { U8 status, I32 height [cm] }
 *   flags    bit 0 terrain_enabled, bit 1 SD/IO failure, bit 2 healthy, bit 3 home height valid, bit 4 armed
 *   status   0 height valid, 1 no data (block still loading, or no tile), 2 refused (armed)
 *
 * Pure encoding and decoding, no MSP traffic: see js/terrainMsp.js for that.
 */

export const TERRAIN_HEIGHT_MAX_POINTS = 8;

export const TerrainHeightStatus = Object.freeze({ OK: 0, NO_DATA: 1, REFUSED: 2 });

/* points: [{ lat, lon }] in degrees, at most TERRAIN_HEIGHT_MAX_POINTS. Returns an array of bytes. */
export function encodeTerrainHeightRequest(points) {
    if (points.length > TERRAIN_HEIGHT_MAX_POINTS) {
        throw new Error('at most ' + TERRAIN_HEIGHT_MAX_POINTS + ' points per request');
    }
    const bytes = new Uint8Array(points.length * 8);
    const view = new DataView(bytes.buffer);
    points.forEach((point, i) => {
        view.setInt32(i * 8, Math.round(Number(point.lat) * 1e7), true);
        view.setInt32(i * 8 + 4, Math.round(Number(point.lon) * 1e7), true);
    });
    return Array.from(bytes);
}

/* view: DataView over the reply payload. Returns null for a reply this code does not understand. */
export function decodeTerrainHeightReply(view) {
    if (!view || view.byteLength < 6) {
        return null;
    }
    const version = view.getUint8(0);
    if (version !== 1) {
        return null;
    }
    const flags = view.getUint8(1);
    const count = view.getUint8(5);
    if (view.byteLength < 6 + count * 5) {
        return null;
    }
    const points = [];
    for (let i = 0; i < count; i++) {
        const status = view.getUint8(6 + i * 5);
        points.push({
            status,
            heightM: status === TerrainHeightStatus.OK ? view.getInt32(7 + i * 5, true) / 100 : null
        });
    }
    return {
        version,
        enabled: (flags & 0x01) !== 0,
        ioFailure: (flags & 0x02) !== 0,
        healthy: (flags & 0x04) !== 0,
        homeValid: (flags & 0x08) !== 0,
        armed: (flags & 0x10) !== 0,
        cacheBlocks: view.getUint8(2),
        homeHeightM: view.getInt16(3, true),
        points
    };
}
