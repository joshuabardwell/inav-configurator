import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    TERRAIN_HEIGHT_MAX_POINTS,
    TerrainHeightStatus,
    decodeTerrainHeightReply,
    encodeTerrainHeightRequest
} from '../js/terrain_msp_codec.js';

function reply({ version = 1, flags = 0x0D, cache = 8, home = 400, points = [] }) {
    const bytes = new Uint8Array(6 + points.length * 5);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, version);
    view.setUint8(1, flags);
    view.setUint8(2, cache);
    view.setInt16(3, home, true);
    view.setUint8(5, points.length);
    points.forEach(([status, centimetres], i) => {
        view.setUint8(6 + i * 5, status);
        view.setInt32(7 + i * 5, centimetres, true);
    });
    return view;
}

describe('MSP2_INAV_TERRAIN_HEIGHT payloads', () => {
    test('a request is latitude and longitude as little-endian 1e7 integers', () => {
        const bytes = encodeTerrainHeightRequest([{ lat: 47.3, lon: 8.5 }, { lat: -33.5, lon: -70.25 }]);
        assert.equal(bytes.length, 16);
        const view = new DataView(Uint8Array.from(bytes).buffer);
        assert.equal(view.getInt32(0, true), 473000000);
        assert.equal(view.getInt32(4, true), 85000000);
        assert.equal(view.getInt32(8, true), -335000000);
        assert.equal(view.getInt32(12, true), -702500000);
        assert.deepEqual(encodeTerrainHeightRequest([]), []);
    });

    test('a request holds at most eight points', () => {
        const points = Array.from({ length: TERRAIN_HEIGHT_MAX_POINTS + 1 }, () => ({ lat: 1, lon: 1 }));
        assert.throws(() => encodeTerrainHeightRequest(points));
    });

    test('a reply decodes status flags, cache size, home height and each point', () => {
        const decoded = decodeTerrainHeightReply(reply({
            flags: 0x0D, cache: 4, home: -12,
            points: [[TerrainHeightStatus.OK, 45612], [TerrainHeightStatus.NO_DATA, 0], [TerrainHeightStatus.REFUSED, 0], [TerrainHeightStatus.OK, -350]]
        }));
        assert.equal(decoded.enabled, true);
        assert.equal(decoded.ioFailure, false);
        assert.equal(decoded.healthy, true);
        assert.equal(decoded.homeValid, true);
        assert.equal(decoded.armed, false);
        assert.equal(decoded.cacheBlocks, 4);
        assert.equal(decoded.homeHeightM, -12);
        assert.deepEqual(decoded.points, [
            { status: 0, heightM: 456.12 }, { status: 1, heightM: null }, { status: 2, heightM: null }, { status: 0, heightM: -3.5 }
        ]);
    });

    test('flags for a disabled, failed or armed controller', () => {
        assert.equal(decodeTerrainHeightReply(reply({ flags: 0x00 })).enabled, false);
        assert.equal(decodeTerrainHeightReply(reply({ flags: 0x03 })).ioFailure, true);
        assert.equal(decodeTerrainHeightReply(reply({ flags: 0x1D })).armed, true);
    });

    test('a reply it does not understand decodes to nothing', () => {
        assert.equal(decodeTerrainHeightReply(null), null);
        assert.equal(decodeTerrainHeightReply(new DataView(new ArrayBuffer(3))), null);
        assert.equal(decodeTerrainHeightReply(reply({ version: 2 })), null);
        const short = reply({ points: [[0, 100], [0, 200]] });
        assert.equal(decodeTerrainHeightReply(new DataView(short.buffer, 0, 12)), null, 'truncated point list');
    });
});
