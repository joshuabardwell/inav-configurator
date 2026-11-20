import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    ElevationSource,
    TerFileState,
    TileDownload,
    buildTiles,
    canBuildTiles,
    configureElevationProvider,
    declineTiles,
    forgetTerFiles,
    forgetTileQuestions,
    elevationSourceStatus,
    getElevation,
    getElevations,
    getTerFolder,
    isLocalTerrainActive,
    setTileDownload,
    setTileWantedListener,
    summariseSources,
    terFileState
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
const flatTile = createTerTile(47, 8, () => 900, { wantBlock: (ix) => ix < 2 });

function pointInTile(north, east) {
    const [lat, lon] = addOffset(47e7, 8e7, north * TERRAIN_SPACING, east * TERRAIN_SPACING);
    return { lat: lat * 1e-7, lon: lon * 1e-7 };
}

function asterService(log, fails = false) {
    return async (url) => {
        log.urls.push(url);
        if (fails) throw new Error('offline');
        const locations = url.split('locations=')[1].split('|');
        return {
            json: async () => ({
                status: 'OK',
                results: locations.map(location => ({ elevation: 1000 + Number(location.split(',')[0]) }))
            })
        };
    };
}

// A terrain folder holding one file, and a fake ASTER service that answers
// 1000 + latitude so tests can tell the two sources apart. Every cell counts as
// land Copernicus leaves out, so points outside the file go straight to ASTER.
function harness({ folder = 'X:/sd', onlineFails = false } = {}) {
    const log = { reads: [], exists: [], urls: [], folder, files: new Set(['X:/sd/N47E008.TER']) };
    configureElevationProvider({
        pathExists: async (path) => {
            log.exists.push(path);
            return log.files.has(path);
        },
        readFileRanges: async (path, ranges) => {
            log.reads.push({ path, ranges });
            return { error: false, data: ranges.map(([offset, length]) => tile.slice(offset, offset + length)) };
        },
        fetchOnline: asterService(log, onlineFails),
        terFolder: () => log.folder,
        canBuild: () => false,
        onTerrainChange: () => () => {},
        cellInfo: () => ({ source: 'srtm', downloadBytes: 1, terBytes: 2 })
    });
    return log;
}

describe('elevation provider: terrain folder and ASTER', () => {
    test('answers from the terrain folder and says which file', async () => {
        const log = harness();
        const point = pointInTile(10.5, 300.5);
        const result = await getElevation(point.lat, point.lon);

        assert.equal(result.source, ElevationSource.TER);
        assert.equal(result.file, 'N47E008.TER');
        assert.ok(Math.abs(result.elevation - hills(point.lat, point.lon)) <= 3, `got ${result.elevation}`);
        assert.equal(log.urls.length, 0, 'no online request when the file has the point');
        assert.deepEqual(elevationSourceStatus().tilesUsed, ['N47E008.TER']);
        assert.equal(getTerFolder(), 'X:/sd');
    });

    test('reads only the blocks it needs, once', async () => {
        const log = harness();
        const points = [pointInTile(3.5, 5.5), pointInTile(4.5, 6.5), pointInTile(5.5, 7.5 + 5 * TERRAIN_BLK_SPACE_Y)];
        await getElevations(points);

        assert.equal(log.reads.length, 1, 'one read call for the file');
        assert.equal(log.reads[0].ranges.length, 2, 'two distinct blocks');
        for (const [, length] of log.reads[0].ranges) {
            assert.ok(length < 2048, 'a block read is smaller than its 2048-byte slot');
        }
        assert.equal(log.exists.length, 1, 'file existence is checked once');

        await getElevations(points);
        assert.equal(log.reads.length, 1, 'second lookup is served from memory');
    });

    test('falls back to ASTER where the folder has no file', async () => {
        const log = harness();
        const inTile = pointInTile(10.5, 300.5);
        const results = await getElevations([inTile, { lat: 51.5, lon: -0.1 }]);

        assert.equal(results[0].source, ElevationSource.TER);
        assert.deepEqual(results[1], { elevation: 1051.5, source: ElevationSource.ASTER });
        assert.equal(log.urls.length, 1);
        assert.ok(log.urls[0].endsWith('/aster30m?locations=51.50000,-0.10000'), log.urls[0]);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N51W001.TER']);
        assert.equal(summariseSources(results).overall, 'mixed');
    });

    test('falls back for a part of the file that was never written', async () => {
        harness();
        const beyond = pointInTile(5 * TERRAIN_BLK_SPACE_X + 4.5, 20.5);
        const result = await getElevation(beyond.lat, beyond.lon);
        assert.equal(result.source, ElevationSource.ASTER);
        assert.equal(result.file, undefined);
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

    test('without a folder everything comes from online', async () => {
        const log = harness({ folder: null });
        assert.equal(isLocalTerrainActive(), false);
        const point = pointInTile(10.5, 300.5);
        const result = await getElevation(point.lat, point.lon);
        assert.equal(result.source, ElevationSource.ASTER);
        assert.equal(log.reads.length, 0);
        assert.equal(log.exists.length, 0);
    });

    test('batches ASTER lookups at 100 locations per request and remembers answers', async () => {
        const log = harness({ folder: null });
        const points = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 1 }));
        const results = await getElevations(points, { onlineLimit: 300 });

        assert.equal(log.urls.length, 3);
        assert.ok(results.every(result => result.source === ElevationSource.ASTER));
        assert.equal(results[249].elevation, 1050.249);

        await getElevations(points, { onlineLimit: 300 });
        assert.equal(log.urls.length, 3, 'repeat lookups are served from memory');
    });

    test('thins a long list out instead of flooding ASTER', async () => {
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
        log.folder = 'Y:/other';
        const result = await getElevation(point.lat, point.lon);

        assert.equal(result.source, ElevationSource.ASTER);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N47E008.TER']);
        assert.ok(log.exists.includes('Y:/other/N47E008.TER'));
    });

    test('a file copied into the folder is found after forgetTerFiles', async () => {
        const log = harness();
        log.files.clear();
        const point = pointInTile(10.5, 300.5);
        assert.equal((await getElevation(point.lat, point.lon)).source, ElevationSource.ASTER);
        log.files.add('X:/sd/N47E008.TER');
        assert.equal((await getElevation(point.lat, point.lon)).source, ElevationSource.ASTER, 'still remembered as missing');
        forgetTerFiles();
        assert.equal((await getElevation(point.lat, point.lon)).source, ElevationSource.TER);
    });

    test('ignores points that are not coordinates', async () => {
        const log = harness();
        const results = await getElevations([{ lat: NaN, lon: 8 }, { lat: 'x', lon: 'y' }]);
        assert.ok(results.every(result => result.source === ElevationSource.NONE));
        assert.equal(log.urls.length, 0);
    });
});

// An empty terrain folder that files can be built into, a fake Copernicus server
// (every tile is flat at 2000 + its latitude) and the fake ASTER service. A
// "build" puts N47E008.TER (the hills tile above) into the folder and tells the
// provider, as js/terrain_library.js does.
function buildHarness({ folder = 'X:/sd', canBuild = true, remoteFails = false, buildFails = false, cellInfo } = {}) {
    const log = { urls: [], opens: [], builds: [], reads: 0, files: new Set(), bytes: tile, pending: false, listener: null };
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
    log.land = (ter) => {       // a file is written into the folder
        log.files.add('X:/sd/' + ter.name);
        if (log.listener) log.listener({ type: 'file', dir: 'X:/sd', name: ter.name, lat: ter.lat, lon: ter.lon });
    };
    configureElevationProvider({
        pathExists: async (path) => log.files.has(path),
        readFileRanges: async (path, ranges) => {
            log.reads++;
            return { error: false, data: ranges.map(([offset, length]) => log.bytes.slice(offset, offset + length)) };
        },
        fetchOnline: asterService(log),
        terFolder: () => folder,
        canBuild: () => canBuild,
        buildPending: () => log.pending,
        onTerrainChange: (listener) => {
            log.listener = listener;
            return () => { log.listener = null; };
        },
        buildTerrain: async (cells, options) => {
            const outcome = { built: [], present: [], failed: [], aborted: false };
            cells.forEach((cell, index) => {
                const name = 'N' + cell.lat + 'E00' + cell.lon + '.TER';
                log.builds.push(name);
                if (options.onProgress) options.onProgress({ index, total: cells.length, name, cell, stage: 'downloading', done: 1, of: 2 });
                if (buildFails) {
                    outcome.failed.push({ name, cell, error: 'no route' });
                } else {
                    log.land({ name, lat: cell.lat, lon: cell.lon });
                    outcome.built.push({ name, cell, source: 'copernicus', bytes: 1 });
                }
            });
            return outcome;
        },
        openCopernicus: async (lat, lon) => {
            log.opens.push(lat + '_' + lon);
            if (remoteFails) throw new Error('offline');
            return flatImage(2000 + lat);
        },
        cellInfo: cellInfo || ((lat) => (lat < 0
            ? { source: 'sea', downloadBytes: 0, terBytes: 40000000 }
            : { source: 'copernicus', downloadBytes: 7500000, terBytes: 30000000 })),
        now: () => clock
    });
    setTileDownload(TileDownload.ASK);
    setTileWantedListener(null);
    log.advance = (ms) => { clock += ms; };
    return log;
}

const IN_FILE = pointInTile(10.5, 300.5);       // in N47E008, inside the two block rows a build writes

describe('elevation provider: cells with no terrain file', () => {
    test('an unknown build setting counts as ask', async () => {
        buildHarness();
        setTileDownload('nonsense');
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.equal(calls.length, 1);
        assert.ok(canBuildTiles());
    });

    test('reads the server tile and says which terrain file it wanted', async () => {
        const log = buildHarness();
        const wanted = [];
        setTileWantedListener(tiles => wanted.push(...tiles));
        const result = await getElevation(IN_FILE.lat, IN_FILE.lon);

        assert.deepEqual(result, { elevation: 2047, source: ElevationSource.COPERNICUS });
        assert.deepEqual(log.opens, ['47_8']);
        assert.equal(log.urls.length, 0, 'no ASTER request');
        assert.deepEqual(wanted, [{
            key: 'N47E008.TER', name: 'N47E008.TER', lat: 47, lon: 8,
            source: 'copernicus', downloadBytes: 7500000, terBytes: 30000000
        }]);
    });

    test('asks about a file once per session, and one call names every file it touched', async () => {
        buildHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles.map(t => t.name)));
        await getElevations([{ lat: 30.5, lon: -102.5 }, { lat: 31.5, lon: -102.5 }, { lat: 30.6, lon: -102.4 }]);
        await getElevation(30.7, -102.3);
        assert.deepEqual(calls, [['N30W103.TER', 'N31W103.TER']]);
    });

    test('after a build the next lookup reads the terrain file', async () => {
        const log = buildHarness();
        let wanted = [];
        setTileWantedListener(tiles => { wanted = tiles; });
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N47E008.TER']);

        const progress = [];
        const outcome = await buildTiles(wanted, step => progress.push(step));
        assert.deepEqual(outcome, { built: [wanted[0]], failed: [], aborted: false });
        assert.deepEqual(log.builds, ['N47E008.TER']);
        assert.deepEqual(progress, [{ done: 0, total: 1, tile: wanted[0], stage: 'downloading', stageDone: 1, stageOf: 2 }]);

        const result = await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.equal(result.source, ElevationSource.TER);
        assert.equal(result.file, 'N47E008.TER');
        assert.ok(Math.abs(result.elevation - hills(IN_FILE.lat, IN_FILE.lon)) <= 3);
        assert.deepEqual(elevationSourceStatus().tilesMissing, []);
        assert.deepEqual(elevationSourceStatus().tilesUsed, ['N47E008.TER']);
    });

    test('a file that is written again replaces what was read from the old one', async () => {
        const log = buildHarness();
        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        const before = await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.equal(before.source, ElevationSource.TER);
        assert.notEqual(before.elevation, 900);

        log.bytes = flatTile;
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).elevation, before.elevation, 'served from memory');
        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).elevation, 900);
    });

    test('a file written into another folder changes nothing here', async () => {
        const log = buildHarness();
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        log.files.add('X:/sd/N47E008.TER');
        log.listener({ type: 'file', dir: 'Y:/other', name: 'N47E008.TER', lat: 47, lon: 8 });
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
    });

    test('a failed build is reported and lookups stay on the server', async () => {
        buildHarness({ buildFails: true });
        let wanted = [];
        setTileWantedListener(tiles => { wanted = tiles; });
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        const outcome = await buildTiles(wanted);
        assert.deepEqual(outcome.built, []);
        assert.deepEqual(outcome.failed, [{ tile: wanted[0], error: 'no route' }]);
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
    });

    test('a declined file is not asked about again', async () => {
        buildHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        declineTiles([{ lat: 47, lon: 8 }]);
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.equal(calls.length, 0);
    });

    test('a question that was withdrawn may be asked again', async () => {
        buildHarness();
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        await getElevation(30.5, -102.5);
        await getElevation(30.6, -102.5);
        assert.equal(calls.length, 1);
        forgetTileQuestions(calls[0]);
        await getElevation(30.7, -102.5);
        assert.equal(calls.length, 2);
    });

    test('"always" builds without asking, once; "never" does neither', async () => {
        let log = buildHarness({ buildFails: true });
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        setTileDownload(TileDownload.ALWAYS);
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        await getElevation(IN_FILE.lat, IN_FILE.lon);       // the build failed: not tried again on every lookup
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(log.builds, ['N47E008.TER']);
        assert.equal(calls.length, 0);

        log = buildHarness();
        setTileWantedListener(tiles => calls.push(tiles));
        setTileDownload(TileDownload.NEVER);
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.deepEqual(log.builds, []);
        assert.equal(calls.length, 0);
    });

    test('nothing is asked where files cannot be built, or while one is being built', async () => {
        buildHarness({ canBuild: false });
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
        assert.ok(!canBuildTiles());

        buildHarness({ folder: null });
        setTileWantedListener(tiles => calls.push(tiles));
        await getElevation(IN_FILE.lat, IN_FILE.lon);

        const log = buildHarness();
        log.pending = true;
        setTileWantedListener(tiles => calls.push(tiles));
        await getElevation(IN_FILE.lat, IN_FILE.lon);
        assert.equal(calls.length, 0);
    });

    test('a file that is there but has no data for the point is not offered again', async () => {
        const log = buildHarness();
        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        const beyond = pointInTile(5 * TERRAIN_BLK_SPACE_X + 4.5, 20.5);
        const result = await getElevation(beyond.lat, beyond.lon);
        assert.deepEqual(result, { elevation: 2047, source: ElevationSource.COPERNICUS });
        assert.equal(calls.length, 0);
    });

    test('falls back to ASTER when the server tile cannot be read, and leaves the server alone for a minute', async () => {
        const log = buildHarness({ remoteFails: true });
        const result = await getElevation(30.5, -102.5);
        assert.deepEqual(result, { elevation: 1030.5, source: ElevationSource.ASTER });
        assert.ok(log.urls[0].includes('/aster30m?'), log.urls[0]);

        await getElevation(30.6, -102.5);
        assert.equal(log.opens.length, 1, 'no second attempt straight away');
        log.advance(61000);
        await getElevation(30.7, -102.5);
        assert.equal(log.opens.length, 2);
    });

    test('a sea cell reads 0 m with no request; land Copernicus leaves out goes to ASTER; both can be built', async () => {
        const log = buildHarness({
            cellInfo: (lat) => (lat === 40
                ? { source: 'srtm', downloadBytes: 48000000, terBytes: 31000000 }
                : { source: 'sea', downloadBytes: 0, terBytes: 40000000 })
        });
        const wanted = [];
        setTileWantedListener(tiles => wanted.push(...tiles));
        const sea = await getElevation(0.5, -140.5);
        assert.deepEqual(sea, { elevation: 0, source: ElevationSource.COPERNICUS });
        assert.equal(log.urls.length, 0);
        assert.equal(log.opens.length, 0);

        const armenia = await getElevation(40.5, 45.5);
        assert.deepEqual(armenia, { elevation: 1040.5, source: ElevationSource.ASTER });
        assert.equal(log.opens.length, 0);
        assert.deepEqual(wanted.map(t => [t.name, t.source, t.downloadBytes]),
            [['N00W141.TER', 'sea', 0], ['N40E045.TER', 'srtm', 48000000]]);
    });

    test('offline lookups read the folder and know the sea, but never ask a server', async () => {
        const log = buildHarness();
        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        const calls = [];
        setTileWantedListener(tiles => calls.push(tiles));
        const results = await getElevations([IN_FILE, { lat: 31.5, lon: -102.5 }, { lat: -10.5, lon: -140.5 }], { online: false });
        assert.equal(results[0].source, ElevationSource.TER);
        assert.equal(results[1].source, ElevationSource.NONE);
        assert.deepEqual(results[2], { elevation: 0, source: ElevationSource.COPERNICUS });
        assert.deepEqual(log.opens, []);
        assert.equal(log.urls.length, 0);
        assert.equal(calls.length, 0);
    });

    test('terFileState: missing, building, present, and none without a folder', async () => {
        const log = buildHarness();
        assert.deepEqual(await terFileState(IN_FILE.lat, IN_FILE.lon),
            { state: TerFileState.MISSING, name: 'N47E008.TER', lat: 47, lon: 8, stale: false });

        log.pending = true;
        assert.equal((await terFileState(IN_FILE.lat, IN_FILE.lon)).state, TerFileState.BUILDING);
        log.pending = false;

        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        assert.deepEqual(await terFileState(IN_FILE.lat, IN_FILE.lon),
            { state: TerFileState.PRESENT, name: 'N47E008.TER', lat: 47, lon: 8, stale: false });
        assert.deepEqual(await terFileState(-33.5, -70.5),
            { state: TerFileState.MISSING, name: 'S34W071.TER', lat: -34, lon: -71, stale: false });

        buildHarness({ folder: null });
        assert.equal((await terFileState(IN_FILE.lat, IN_FILE.lon)).state, TerFileState.NONE);
    });

    test('terFileState asks the folder, and corrects what lookups remembered', async () => {
        const log = buildHarness();
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
        // The file is copied in outside the app: lookups still remember it as missing.
        log.files.add('X:/sd/N47E008.TER');
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
        assert.deepEqual(elevationSourceStatus().tilesMissing, ['N47E008.TER']);

        const state = await terFileState(IN_FILE.lat, IN_FILE.lon);
        assert.equal(state.state, TerFileState.PRESENT);
        assert.equal(state.stale, true);
        assert.deepEqual(elevationSourceStatus().tilesMissing, []);
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.TER);
        assert.equal((await terFileState(IN_FILE.lat, IN_FILE.lon)).stale, false);

        // And the other way: the file is deleted outside the app.
        log.files.delete('X:/sd/N47E008.TER');
        const gone = await terFileState(IN_FILE.lat, IN_FILE.lon);
        assert.equal(gone.state, TerFileState.MISSING);
        assert.equal(gone.stale, true);
        assert.equal((await getElevation(IN_FILE.lat, IN_FILE.lon)).source, ElevationSource.COPERNICUS);
    });

    test('terFileState says building when a build starts while the folder is asked', async () => {
        const log = buildHarness();
        const original = log.files.has.bind(log.files);
        log.files.has = (path) => {
            log.pending = true;         // the build is queued while pathExists is under way
            return original(path);
        };
        assert.equal((await terFileState(IN_FILE.lat, IN_FILE.lon)).state, TerFileState.BUILDING);
    });

    test('a mix of sources is summarised as mixed', async () => {
        const log = buildHarness();
        log.land({ name: 'N47E008.TER', lat: 47, lon: 8 });
        const results = await getElevations([IN_FILE, { lat: 31.5, lon: -102.5 }]);
        assert.equal(results[0].source, ElevationSource.TER);
        assert.equal(results[1].source, ElevationSource.COPERNICUS);
        assert.equal(summariseSources(results).overall, 'mixed');
        assert.equal(summariseSources([results[0]]).overall, ElevationSource.TER);
        assert.equal(summariseSources([results[1]]).overall, ElevationSource.COPERNICUS);
    });
});
