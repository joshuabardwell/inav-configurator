import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
    ElevationSource,
    OnlineSource,
    TileDownload,
    configureElevationProvider,
    declineTiles,
    downloadTiles,
    forgetTileQuestions,
    elevationSourceStatus,
    getElevation,
    getElevations,
    isLocalTerrainActive,
    setOnlineSource,
    setTerFolder,
    setTileDownload,
    setTileWantedListener,
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
    setOnlineSource(OnlineSource.ASTER);
    return log;
}

describe('elevation provider: terrain folder and ASTER', () => {
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
        assert.equal(results[1].source, ElevationSource.ASTER);
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
        assert.equal(result.source, ElevationSource.ASTER);
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
        assert.equal(result.source, ElevationSource.ASTER);
        assert.equal(log.reads.length, 0);
        assert.equal(log.exists.length, 0);
    });

    test('batches online lookups at 100 locations per request and remembers answers', async () => {
        const log = harness({ folder: null });
        const points = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 1 }));
        const results = await getElevations(points, { onlineLimit: 300 });

        assert.equal(log.urls.length, 3);
        assert.ok(results.every(result => result.source === ElevationSource.ASTER));
        assert.equal(results[249].elevation, 1050.249);

        await getElevations(points, { onlineLimit: 300 });
        assert.equal(log.urls.length, 3, 'repeat lookups are served from memory');
    });

    test('thins a long list out instead of flooding the online source', async () => {
        const log = harness({ folder: null });
        const points = Array.from({ length: 500 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 1 }));
        const results = await getElevations(points);

        assert.equal(log.urls.length, 1, 'one request by default');
        assert.equal(results[0].source, ElevationSource.ASTER);
        assert.equal(results[499].source, ElevationSource.ASTER);
        const coarse = results.filter(result => result.coarse);
        assert.equal(coarse.length, 400);
        assert.ok(coarse.every(result => result.source === ElevationSource.ASTER));
        // The fake service is linear in latitude, so interpolation must land on the same line.
        results.forEach((result, i) => {
            assert.ok(Math.abs(result.elevation - (1050 + i * 0.001)) < 0.06, `point ${i}: ${result.elevation}`);
        });
        assert.equal(summariseSources(results).overall, ElevationSource.ASTER);
        assert.equal(summariseSources(results).coarse, true);
    });

    test('changing the folder forgets what the old one held', async () => {
        const log = harness();
        const point = pointInTile(10.5, 300.5);
        await getElevation(point.lat, point.lon);
        setTerFolder('Y:/other');
        const result = await getElevation(point.lat, point.lon);

        assert.equal(result.source, ElevationSource.ASTER);
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

// A fake Copernicus tile and SRTM grid, a fake offline folder and fake servers.
// Copernicus heights are 2000 + cell latitude; a saved tile answers 100 more than
// the server, SRTM (saved) 3000 + cell latitude, opentopodata 1000 + latitude.
function tileHarness({ saved = [], offline = true, remoteFails = false, downloadFails = false, cellBytes } = {}) {
    const log = { urls: [], opens: [], downloads: [], exists: [] };
    const folder = new Set(saved);
    const flatImage = (height) => ({
        width: 3600,
        height: 3600,
        blockWidth: 1024,
        blockHeight: 1024,
        readBlock: async (bx, by) => {
            const w = Math.min(3600, (bx + 1) * 1024) - bx * 1024;
            const h = Math.min(3600, (by + 1) * 1024) - by * 1024;
            return { data: new Float32Array(w * h).fill(height), width: w };
        }
    });
    let clock = 0;
    configureElevationProvider({
        localAvailable: () => false,
        offlineAvailable: () => offline,
        savedExists: async (relPath) => {
            log.exists.push(relPath);
            return folder.has(relPath);
        },
        openCopernicus: async (where, lat, lon) => {
            log.opens.push(where + ':' + lat + '_' + lon);
            if (where === 'remote' && remoteFails) throw new Error('offline');
            return flatImage(2000 + lat + (where === 'saved' ? 100 : 0));
        },
        loadSrtmGrid: async (lat) => {
            const bytes = new Uint8Array(3601 * 3601 * 2);
            const view = new DataView(bytes.buffer);
            for (let i = 0; i < 3601 * 3601; i++) {
                view.setInt16(i * 2, i === 1800 * 3601 + 1800 ? 32767 : 3000 + lat, false);
            }
            return view;
        },
        downloadFile: async (url, relPath) => {
            log.downloads.push(relPath);
            if (downloadFails) return { status: 'error', error: 'no route' };
            folder.add(relPath);
            return { status: 200, bytes: 1 };
        },
        cellBytes: cellBytes || ((source, lat) => (source === 'copernicus' && lat < 0 ? 0 : 5000000)),
        now: () => clock,
        fetchOnline: async (url) => {
            log.urls.push(url);
            const locations = url.split('locations=')[1].split('|');
            return {
                json: async () => ({
                    status: 'OK',
                    results: locations.map(location => ({ elevation: 1000 + Number(location.split(',')[0]) }))
                })
            };
        }
    });
    setTerFolder(null);
    setTileDownload(TileDownload.ASK);
    setTileWantedListener(null);
    log.advance = (ms) => { clock += ms; };
    return log;
}

const COP_N30 = 'elevation/copernicus/Copernicus_DSM_COG_10_N30_00_W103_00_DEM.tif';
const SRTM_N30 = 'elevation/srtm/N30W103.hgt.gz';

describe('elevation provider: Copernicus', () => {
    beforeEach(() => {
        setOnlineSource(OnlineSource.COPERNICUS);
    });

    test('an unknown source or download setting counts as Copernicus and ask', () => {
        setOnlineSource('nonsense');
        setTileDownload('nonsense');
        const log = tileHarness();
        assert.equal(log.urls.length, 0);
        setOnlineSource(undefined);
        return getElevation(30.5, -102.5).then(result => assert.equal(result.source, ElevationSource.COPERNICUS));
    });

    test('reads the server tile when the offline folder has none, and says which tile it wanted', async () => {
        const log = tileHarness();
        const wanted = [];
        setTileWantedListener(tiles => wanted.push(...tiles));
        const result = await getElevation(30.5, -102.5);

        assert.deepEqual(result, { elevation: 2030, source: ElevationSource.COPERNICUS });
        assert.deepEqual(log.opens, ['remote:30_-103']);
        assert.equal(log.urls.length, 0, 'no opentopodata request');
        assert.equal(wanted.length, 1);
        assert.equal(wanted[0].name, 'Copernicus_DSM_COG_10_N30_00_W103_00_DEM');
        assert.equal(wanted[0].bytes, 5000000);
        assert.equal(wanted[0].source, 'copernicus');
    });

    test('asks about a tile once per session, and one call names every tile it touched', async () => {
        tileHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles.map(tile => tile.lat + '_' + tile.lon)));
        await getElevations([{ lat: 30.5, lon: -102.5 }, { lat: 31.5, lon: -102.5 }, { lat: 30.6, lon: -102.4 }]);
        await getElevation(30.7, -102.3);
        assert.deepEqual(calls, [['30_-103', '31_-103']]);
    });

    test('reads a tile saved in the offline folder and does not ask', async () => {
        const log = tileHarness({ saved: [COP_N30] });
        const wanted = [];
        setTileWantedListener(tiles => wanted.push(...tiles));
        const result = await getElevation(30.5, -102.5);

        assert.deepEqual(result, { elevation: 2130, source: ElevationSource.COPERNICUS_SAVED });
        assert.deepEqual(log.opens, ['saved:30_-103']);
        assert.equal(wanted.length, 0);
    });

    test('after a download the next lookup reads the saved tile', async () => {
        const log = tileHarness();
        let wanted = [];
        setTileWantedListener(tiles => { wanted = tiles; });
        assert.equal((await getElevation(30.5, -102.5)).source, ElevationSource.COPERNICUS);

        const progress = [];
        const outcome = await downloadTiles(wanted, step => progress.push(step.done + '/' + step.total));
        assert.equal(outcome.downloaded.length, 1);
        assert.equal(outcome.failed.length, 0);
        assert.deepEqual(log.downloads, [COP_N30]);
        assert.deepEqual(progress, ['0/1', '1/1']);

        const result = await getElevation(30.6, -102.4);
        assert.deepEqual(result, { elevation: 2130, source: ElevationSource.COPERNICUS_SAVED });
    });

    test('a failed download is reported and lookups stay on the server', async () => {
        tileHarness({ downloadFails: true });
        let wanted = [];
        setTileWantedListener(tiles => { wanted = tiles; });
        await getElevation(30.5, -102.5);
        const outcome = await downloadTiles(wanted);
        assert.equal(outcome.failed.length, 1);
        assert.equal(outcome.failed[0].error, 'no route');
        assert.equal((await getElevation(30.6, -102.4)).source, ElevationSource.COPERNICUS);
    });

    test('a declined tile is not asked about again', async () => {
        tileHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        declineTiles([{ source: 'copernicus', lat: 30, lon: -103 }]);
        await getElevation(30.5, -102.5);
        assert.equal(calls.length, 0);
    });

    test('a question that was withdrawn may be asked again', async () => {
        tileHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        await getElevation(30.5, -102.5);
        await getElevation(30.6, -102.5);
        assert.equal(calls.length, 1);
        forgetTileQuestions(calls[0]);
        await getElevation(30.7, -102.5);
        assert.equal(calls.length, 2);
    });

    test('"always" downloads without asking, "never" does neither', async () => {
        let log = tileHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        setTileDownload(TileDownload.ALWAYS);
        await getElevation(30.5, -102.5);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(log.downloads, [COP_N30]);
        assert.equal(calls.length, 0);

        log = tileHarness();
        setTileWantedListener(tiles => calls.push(tiles));
        setTileDownload(TileDownload.NEVER);
        await getElevation(30.5, -102.5);
        assert.deepEqual(log.downloads, []);
        assert.equal(calls.length, 0);
    });

    test('without an offline folder nothing is asked or checked', async () => {
        const log = tileHarness({ offline: false });
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        const result = await getElevation(30.5, -102.5);
        assert.equal(result.source, ElevationSource.COPERNICUS);
        assert.equal(calls.length, 0);
        assert.equal(log.exists.length, 0);
    });

    test('falls back to ASTER when the server tile cannot be read, and leaves the server alone for a minute', async () => {
        const log = tileHarness({ remoteFails: true });
        const result = await getElevation(30.5, -102.5);
        assert.deepEqual(result, { elevation: 1030.5, source: ElevationSource.ASTER_FALLBACK });
        assert.ok(log.urls[0].includes('/aster30m?'), log.urls[0]);

        await getElevation(30.6, -102.5);
        assert.equal(log.opens.length, 1, 'no second attempt straight away');
        log.advance(61000);
        await getElevation(30.7, -102.5);
        assert.equal(log.opens.length, 2);
    });

    test('a sea cell reads 0 m without any request; land Copernicus leaves out goes to ASTER', async () => {
        const log = tileHarness({
            cellBytes: (source, lat) => {
                if (source === 'copernicus') return 0;
                return lat === 40 ? 12000000 : 1100000;
            }
        });
        const sea = await getElevation(0.5, -140.5);
        assert.deepEqual(sea, { elevation: 0, source: ElevationSource.COPERNICUS });
        assert.equal(log.urls.length, 0);
        assert.equal(log.opens.length, 0);

        const armenia = await getElevation(40.5, 45.5);
        assert.deepEqual(armenia, { elevation: 1040.5, source: ElevationSource.ASTER_FALLBACK });
    });

    test('offline lookups use a saved tile but never the server', async () => {
        const log = tileHarness({ saved: [COP_N30] });
        const results = await getElevations([{ lat: 30.5, lon: -102.5 }, { lat: 31.5, lon: -102.5 }], { online: false });
        assert.equal(results[0].source, ElevationSource.COPERNICUS_SAVED);
        assert.equal(results[1].source, ElevationSource.NONE);
        assert.deepEqual(log.opens, ['saved:30_-103']);
        assert.equal(log.urls.length, 0);
    });

    test('a mix of sources is summarised as mixed', async () => {
        tileHarness({ saved: [COP_N30] });
        const results = await getElevations([{ lat: 30.5, lon: -102.5 }, { lat: 31.5, lon: -102.5 }]);
        assert.equal(results[0].source, ElevationSource.COPERNICUS_SAVED);
        assert.equal(results[1].source, ElevationSource.COPERNICUS);
        assert.equal(summariseSources(results).overall, 'mixed');
        assert.equal(summariseSources([results[0]]).overall, ElevationSource.COPERNICUS_SAVED);
    });
});

describe('elevation provider: SRTM', () => {
    beforeEach(() => {
        setOnlineSource(OnlineSource.SRTM);
    });

    test('uses opentopodata srtm30m when the offline folder has no tile, and asks about the tile', async () => {
        const log = tileHarness();
        const wanted = [];
        setTileWantedListener(tiles => wanted.push(...tiles));
        const result = await getElevation(30.5, -102.5);
        assert.deepEqual(result, { elevation: 1030.5, source: ElevationSource.SRTM_ONLINE });
        assert.ok(log.urls[0].includes('/srtm30m?'), log.urls[0]);
        assert.equal(wanted.length, 1);
        assert.equal(wanted[0].name, 'N30W103');
    });

    test('reads a saved tile; a spike goes to ASTER', async () => {
        const log = tileHarness({ saved: [SRTM_N30] });
        const good = await getElevation(30.25, -102.75);
        assert.deepEqual(good, { elevation: 3030, source: ElevationSource.SRTM_SAVED });
        assert.equal(log.urls.length, 0);

        const spike = await getElevation(30.5, -102.5);     // node 1800,1800
        assert.equal(spike.source, ElevationSource.ASTER_FALLBACK);
        assert.ok(log.urls[0].includes('/aster30m?'), log.urls[0]);
    });

    test('a long path over opentopodata is thinned out and marked coarse', async () => {
        const log = tileHarness();
        const points = Array.from({ length: 500 }, (_, i) => ({ lat: 30.1 + i * 0.001, lon: -102.5 }));
        const results = await getElevations(points);
        assert.equal(log.urls.length, 1);
        assert.equal(results.filter(result => result.coarse).length, 400);
        assert.ok(results.every(result => result.source === ElevationSource.SRTM_ONLINE));
    });

    test('changing the source keeps answers of the two opentopodata sets apart', async () => {
        const log = tileHarness();
        await getElevation(30.5, -102.5);
        setOnlineSource(OnlineSource.ASTER);
        const result = await getElevation(30.5, -102.5);
        assert.equal(result.source, ElevationSource.ASTER);
        assert.equal(log.urls.length, 2);
    });
});
