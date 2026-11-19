import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
    ElevationSource,
    configureElevationProvider,
    elevationSourceStatus,
    getElevation,
    getElevations,
    isLocalTerrainActive,
    setTerFolder,
    summariseSources
} from '../js/elevationProvider.js';
import {
    TERRAIN_BLK_SPACE_X,
    TERRAIN_BLK_SPACE_Y,
    TERRAIN_SPACING,
    addOffset,
    createTerTile
} from '../js/terrain_ter.js';

function hills(latDeg, lonDeg) {
    return Math.round(400 + 60 * Math.sin(latDeg * 900) + 40 * Math.cos(lonDeg * 700));
}

// First two block rows of N47E008: about 1.4 km north of the 47th parallel.
const tile = createTerTile(47, 8, hills, { wantBlock: (ix) => ix < 2 });

function pointInTile(north, east) {
    const [lat, lon] = addOffset(47e7, 8e7, north * TERRAIN_SPACING, east * TERRAIN_SPACING);
    return { lat: lat * 1e-7, lon: lon * 1e-7 };
}

// Fake file system holding one tile, and a fake online service that answers
// 1000 + latitude index so tests can tell the two sources apart.
function harness({ folder = 'X:/sd', onlineFails = false } = {}) {
    const log = { reads: [], exists: [], urls: [] };
    configureElevationProvider({
        pathExists: async (path) => {
            log.exists.push(path);
            return path === 'X:/sd/N47E008.TER';
        },
        readFileRanges: async (path, ranges) => {
            log.reads.push({ path, ranges });
            return { error: false, data: ranges.map(([offset, length]) => tile.slice(offset, offset + length)) };
        },
        fetchOnline: async (url) => {
            log.urls.push(url);
            if (onlineFails) throw new Error('offline');
            const locations = url.split('locations=')[1].split('|');
            return {
                json: async () => ({
                    status: 'OK',
                    results: locations.map(location => ({ elevation: 1000 + Number(location.split(',')[0]) }))
                })
            };
        }
    });
    setTerFolder(folder);
    return log;
}

describe('elevation provider', () => {
    beforeEach(() => {
        setTerFolder(null);
    });

    test('answers from the terrain folder and says so', async () => {
        const log = harness();
        const point = pointInTile(10.5, 300.5);
        const result = await getElevation(point.lat, point.lon);

        assert.equal(result.source, ElevationSource.TER);
        assert.ok(Math.abs(result.elevation - hills(point.lat, point.lon)) <= 3, `got ${result.elevation}`);
        assert.equal(log.urls.length, 0, 'no online request when the tile has the point');
        assert.deepEqual(elevationSourceStatus().tilesUsed, ['N47E008.TER']);
    });

    test('reads only the blocks it needs, once', async () => {
        const log = harness();
        const points = [pointInTile(3.5, 5.5), pointInTile(4.5, 6.5), pointInTile(5.5, 7.5 + 5 * TERRAIN_BLK_SPACE_Y)];
        await getElevations(points);

        assert.equal(log.reads.length, 1, 'one read call for the tile');
        assert.equal(log.reads[0].ranges.length, 2, 'two distinct blocks');
        for (const [, length] of log.reads[0].ranges) {
            assert.ok(length < 2048, 'a block read is smaller than its 2048-byte slot');
        }
        assert.equal(log.exists.length, 1, 'tile existence is checked once');

        await getElevations(points);
        assert.equal(log.reads.length, 1, 'second lookup is served from memory');
    });

    test('falls back to the online source where the folder has no tile', async () => {
        const log = harness();
        const inTile = pointInTile(10.5, 300.5);
        const results = await getElevations([inTile, { lat: 51.5, lon: -0.1 }]);

        assert.equal(results[0].source, ElevationSource.TER);
        assert.equal(results[1].source, ElevationSource.ONLINE);
        assert.equal(results[1].elevation, 1051.5);
        assert.equal(log.urls.length, 1);
        assert.ok(log.urls[0].endsWith('locations=51.50000,-0.10000'), log.urls[0]);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N51W001.TER']);
        assert.equal(summariseSources(results).overall, 'mixed');
    });

    test('falls back to online for a part of the tile that was never written', async () => {
        harness();
        const beyond = pointInTile(5 * TERRAIN_BLK_SPACE_X + 4.5, 20.5);
        const result = await getElevation(beyond.lat, beyond.lon);
        assert.equal(result.source, ElevationSource.ONLINE);
    });

    test('reports no data when neither source answers', async () => {
        harness({ onlineFails: true });
        const result = await getElevation(51.5, -0.1);
        assert.deepEqual(result, { elevation: null, source: ElevationSource.NONE });
    });

    test('stays off the network when asked to', async () => {
        const log = harness();
        const result = await getElevation(51.5, -0.1, { online: false });
        assert.equal(result.source, ElevationSource.NONE);
        assert.equal(log.urls.length, 0);
    });

    test('without a folder everything comes from the online source', async () => {
        const log = harness({ folder: null });
        assert.equal(isLocalTerrainActive(), false);
        const point = pointInTile(10.5, 300.5);
        const result = await getElevation(point.lat, point.lon);
        assert.equal(result.source, ElevationSource.ONLINE);
        assert.equal(log.reads.length, 0);
        assert.equal(log.exists.length, 0);
    });

    test('batches online lookups at 100 locations per request and remembers answers', async () => {
        const log = harness({ folder: null });
        const points = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 1 }));
        const results = await getElevations(points, { onlineLimit: 300 });

        assert.equal(log.urls.length, 3);
        assert.ok(results.every(result => result.source === ElevationSource.ONLINE));
        assert.equal(results[249].elevation, 1050.249);

        await getElevations(points, { onlineLimit: 300 });
        assert.equal(log.urls.length, 3, 'repeat lookups are served from memory');
    });

    test('thins a long list out instead of flooding the online source', async () => {
        const log = harness({ folder: null });
        const points = Array.from({ length: 500 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 1 }));
        const results = await getElevations(points);

        assert.equal(log.urls.length, 1, 'one request by default');
        assert.equal(results[0].source, ElevationSource.ONLINE);
        assert.equal(results[499].source, ElevationSource.ONLINE);
        const coarse = results.filter(result => result.source === ElevationSource.ONLINE_COARSE);
        assert.equal(coarse.length, 400);
        // The fake service is linear in latitude, so interpolation must land on the same line.
        results.forEach((result, i) => {
            assert.ok(Math.abs(result.elevation - (1050 + i * 0.001)) < 0.06, `point ${i}: ${result.elevation}`);
        });
        assert.equal(summariseSources(results).overall, ElevationSource.ONLINE_COARSE);
    });

    test('changing the folder forgets what the old one held', async () => {
        const log = harness();
        const point = pointInTile(10.5, 300.5);
        await getElevation(point.lat, point.lon);
        setTerFolder('Y:/other');
        const result = await getElevation(point.lat, point.lon);

        assert.equal(result.source, ElevationSource.ONLINE);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N47E008.TER']);
        assert.ok(log.exists.includes('Y:/other/N47E008.TER'));
    });

    test('ignores points that are not coordinates', async () => {
        const log = harness();
        const results = await getElevations([{ lat: NaN, lon: 8 }, { lat: 'x', lon: 'y' }]);
        assert.ok(results.every(result => result.source === ElevationSource.NONE));
        assert.equal(log.urls.length, 0);
    });
});
