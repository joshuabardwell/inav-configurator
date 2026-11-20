import test from 'node:test';
import assert from 'node:assert/strict';

import {
    configureTerrainLibrary, terrainLibraryAvailable,
    terrainFolderDir, terrainFolderDefaultDir, terrainFolderParentDir, terrainFolderIsDefault, setTerrainFolder,
    terrainFilePath, onTerrainChange, parseTerrainIndex, listTerrain, terrainFileInfo,
    terFileBytes, buildTerrain, terrainBuildPending, copyTerrainTo, terrainNoticeText,
    TERRAIN_FOLDER_KEY, TERRAIN_INDEX_FILE, TERRAIN_NOTICE_FILE, TerrainFileState
} from '../js/terrain_library.js';
import { TER_GENERATOR_VERSION } from '../js/terrain_build.js';
import { COPERNICUS_NOTICE_1 } from '../js/terrain_elevation.js';

const DOCS = 'C:/Users/pilot/Documents';
const DEFAULT_DIR = DOCS + '/INAV Terrain/Default';

// A fake disk (path -> string | Uint8Array) and settings store behind the library's io.
function fakeHost({ settings = {}, files = {}, free = 500e9, buildCell = null } = {}) {
    const disk = new Map(Object.entries(files));
    const store = { ...settings };
    const builds = [];
    const size = value => (typeof value === 'string' ? value.length : value.byteLength);
    const io = {
        available: () => true,
        storeGet: (key, fallback) => (key in store ? store[key] : fallback),
        storeSet: (key, value) => { store[key] = value; },
        documentsDir: () => DOCS,
        listFiles: async (dir) => {
            const out = [];
            for (const [file, value] of disk) {
                if (file.startsWith(dir + '/') && !file.slice(dir.length + 1).includes('/')) {
                    out.push({ name: file.slice(dir.length + 1), size: size(value) });
                }
            }
            return out;
        },
        readText: async (file) => (disk.has(file) && typeof disk.get(file) === 'string' ? disk.get(file) : null),
        writeFileAtomic: async (file, data) => { disk.set(file, data); return false; },
        copyFileAtomic: async (src, dest) => {
            if (!disk.has(src)) return 'ENOENT';
            disk.set(dest, disk.get(src));
            return false;
        },
        diskFree: async () => free,
        buildCell: buildCell || (async (lat, lon, options) => {
            builds.push({ lat, lon });
            if (options.onStage) options.onStage('downloading');
            return { name: 'x', bytes: new Uint8Array([1, 2, 3, 4]), source: 'copernicus' };
        }),
        today: () => '2026-11-20'
    };
    configureTerrainLibrary(io);
    return { disk, store, builds };
}

test('the default folder is used until one is chosen', () => {
    const { store } = fakeHost();
    assert.ok(terrainLibraryAvailable());
    assert.equal(terrainFolderDefaultDir(), DEFAULT_DIR);
    assert.equal(terrainFolderParentDir(), DOCS + '/INAV Terrain');
    assert.equal(terrainFolderDir(), DEFAULT_DIR);
    assert.ok(terrainFolderIsDefault());
    assert.equal(terrainFilePath('N47E008.TER'), DEFAULT_DIR + '/N47E008.TER');
    assert.ok(!(TERRAIN_FOLDER_KEY in store));      // reading it writes nothing
});

test('a Windows path is joined with backslashes', () => {
    fakeHost();
    configureTerrainLibrary({
        available: () => true,
        storeGet: (key, fallback) => fallback,
        storeSet: () => {},
        documentsDir: () => 'C:\\Users\\pilot\\Documents'
    });
    assert.equal(terrainFolderDefaultDir(), 'C:\\Users\\pilot\\Documents\\INAV Terrain\\Default');
    assert.equal(terrainFilePath('N47E008.TER'), 'C:\\Users\\pilot\\Documents\\INAV Terrain\\Default\\N47E008.TER');
});

test('choosing a folder is stored, tells listeners, and "default" goes back', () => {
    const { store } = fakeHost();
    const events = [];
    const off = onTerrainChange(event => events.push(event));
    setTerrainFolder('D:/Terrain/Alps');
    assert.equal(store[TERRAIN_FOLDER_KEY], 'D:/Terrain/Alps');
    assert.equal(terrainFolderDir(), 'D:/Terrain/Alps');
    assert.ok(!terrainFolderIsDefault());
    setTerrainFolder('D:/Terrain/Alps');            // same again: no event
    setTerrainFolder(null);
    assert.equal(store[TERRAIN_FOLDER_KEY], '');
    assert.equal(terrainFolderDir(), DEFAULT_DIR);
    assert.deepEqual(events, [{ type: 'folder', dir: 'D:/Terrain/Alps' }, { type: 'folder', dir: DEFAULT_DIR }]);
    off();
    setTerrainFolder('D:/Terrain/Coast');
    assert.equal(events.length, 2);
});

test('a folder chosen in the planner before the shared setting is taken over once', () => {
    const { store } = fakeHost({ settings: { missionPlannerTerrainFolder: 'E:/' } });
    assert.equal(terrainFolderDir(), 'E:/');
    assert.equal(store[TERRAIN_FOLDER_KEY], 'E:/');
    assert.equal(store.missionPlannerTerrainFolder, 'E:/');     // left for older builds
    setTerrainFolder(null);
    assert.equal(terrainFolderDir(), DEFAULT_DIR);              // "default" is not undone by the old key

    // "Use online data" in the old planner stored '': that is not a folder
    fakeHost({ settings: { missionPlannerTerrainFolder: '' } });
    assert.equal(terrainFolderDir(), DEFAULT_DIR);
});

test('parseTerrainIndex accepts the format and ignores damage', () => {
    assert.deepEqual(parseTerrainIndex(null).files, {});
    assert.deepEqual(parseTerrainIndex('not json').files, {});
    assert.deepEqual(parseTerrainIndex('[1,2]').files, {});
    const index = parseTerrainIndex(JSON.stringify({
        format: 1,
        files: {
            'N47E008.TER': { source: 'copernicus', generator: 1, built: '2026-11-20' },
            'N40E044.TER': { source: 'srtm' },
            'readme.txt': { source: 'copernicus', generator: 1 },
            'N48E008.TER': 'nonsense'
        }
    }));
    assert.deepEqual(index.files, {
        'N47E008.TER': { source: 'copernicus', generator: 1, built: '2026-11-20' },
        'N40E044.TER': { source: 'srtm', generator: 0, built: '' }
    });
    assert.equal(index.format, 1);
});

test('listTerrain labels files from the index and counts the rest', async () => {
    fakeHost({
        files: {
            [DEFAULT_DIR + '/N47E008.TER']: 'aaaa',
            [DEFAULT_DIR + '/n47e009.ter']: 'bb',                   // copied in by hand, lower case
            [DEFAULT_DIR + '/N46E008.TER']: 'c',
            [DEFAULT_DIR + '/N46E008.TER.part']: 'zz',
            [DEFAULT_DIR + '/holiday.jpg']: 'zz',
            [DEFAULT_DIR + '/' + TERRAIN_INDEX_FILE]: JSON.stringify({
                format: 1,
                files: {
                    'N47E008.TER': { source: 'copernicus', generator: TER_GENERATOR_VERSION, built: '2026-11-20' },
                    'N46E008.TER': { source: 'srtm', generator: 0, built: '2026-01-01' },
                    'N10E010.TER': { source: 'copernicus', generator: TER_GENERATOR_VERSION, built: '2026-11-20' }
                }
            })
        }
    });
    assert.equal(terrainFileInfo('N47E008.TER'), null);             // index not read yet
    const listing = await listTerrain();
    assert.equal(listing.dir, DEFAULT_DIR);
    assert.deepEqual([...listing.files.keys()].sort(), ['N46E008.TER', 'N47E008.TER', 'N47E009.TER']);
    assert.equal(listing.count, 3);
    assert.equal(listing.bytes, 7);
    assert.equal(listing.unlabelled, 1);
    assert.equal(listing.outdated, 1);
    assert.deepEqual(listing.files.get('N47E008.TER'), {
        name: 'N47E008.TER', size: 4, source: 'copernicus', generator: TER_GENERATOR_VERSION, built: '2026-11-20',
        state: TerrainFileState.CURRENT
    });
    assert.equal(listing.files.get('N46E008.TER').state, TerrainFileState.OUTDATED);
    assert.equal(listing.files.get('N47E009.TER').state, TerrainFileState.UNLABELLED);
    assert.equal(listing.files.get('N47E009.TER').source, null);
    assert.equal(terrainFileInfo('n47e008.ter').source, 'copernicus');
    assert.equal(terrainFileInfo('N47E009.TER'), null);

    setTerrainFolder('D:/Other');
    assert.equal(terrainFileInfo('N47E008.TER'), null);             // another folder's index does not apply
    assert.equal((await listTerrain()).count, 0);
});

test('terFileBytes matches the sizes a tile has', () => {
    assert.equal(terFileBytes(-34, 150), 35553280);
    assert.equal(terFileBytes(50, 8), 27617280);
});

test('buildTerrain writes the file, the index and the notice, and tells listeners', async () => {
    const { disk, builds } = fakeHost();
    const events = [];
    onTerrainChange(event => events.push(event));
    const progress = [];
    const result = await buildTerrain([{ lat: 47, lon: 8 }], { onProgress: p => progress.push(p.stage) });
    assert.deepEqual(result, {
        built: [{ name: 'N47E008.TER', cell: { lat: 47, lon: 8 }, source: 'copernicus', bytes: 4 }],
        present: [], failed: [], aborted: false
    });
    assert.deepEqual(builds, [{ lat: 47, lon: 8 }]);
    assert.deepEqual([...disk.get(DEFAULT_DIR + '/N47E008.TER')], [1, 2, 3, 4]);
    const index = JSON.parse(disk.get(DEFAULT_DIR + '/' + TERRAIN_INDEX_FILE));
    assert.equal(index.format, 1);
    assert.deepEqual(index.files, {
        'N47E008.TER': { source: 'copernicus', generator: TER_GENERATOR_VERSION, built: '2026-11-20' }
    });
    assert.ok(disk.get(DEFAULT_DIR + '/' + TERRAIN_NOTICE_FILE).includes(COPERNICUS_NOTICE_1));
    assert.equal(disk.get(DEFAULT_DIR + '/' + TERRAIN_NOTICE_FILE), terrainNoticeText());
    assert.deepEqual(events, [{ type: 'file', dir: DEFAULT_DIR, name: 'N47E008.TER', lat: 47, lon: 8 }]);
    assert.deepEqual(progress, ['queued', 'downloading', 'writing']);
    assert.equal(terrainFileInfo('N47E008.TER').source, 'copernicus');
    assert.equal((await listTerrain()).files.get('N47E008.TER').state, TerrainFileState.CURRENT);
});

test('a file already in the folder is not built again unless forced', async () => {
    const { disk, builds } = fakeHost({ files: { [DEFAULT_DIR + '/N47E008.TER']: 'old' } });
    const result = await buildTerrain([{ lat: 47, lon: 8 }, { lat: 47, lon: 9 }]);
    assert.deepEqual(result.present, ['N47E008.TER']);
    assert.deepEqual(result.built.map(b => b.name), ['N47E009.TER']);
    assert.deepEqual(builds, [{ lat: 47, lon: 9 }]);
    assert.equal(disk.get(DEFAULT_DIR + '/N47E008.TER'), 'old');

    const forced = await buildTerrain([{ lat: 47, lon: 8 }], { force: true });
    assert.deepEqual(forced.built.map(b => b.name), ['N47E008.TER']);
    assert.deepEqual([...disk.get(DEFAULT_DIR + '/N47E008.TER')], [1, 2, 3, 4]);
});

test('the index keeps other entries and drops those whose file is gone', async () => {
    const { disk } = fakeHost({
        files: {
            [DEFAULT_DIR + '/N46E008.TER']: 'c',
            [DEFAULT_DIR + '/' + TERRAIN_INDEX_FILE]: JSON.stringify({
                format: 1,
                files: {
                    'N46E008.TER': { source: 'srtm', generator: 1, built: '2026-01-01' },
                    'N10E010.TER': { source: 'copernicus', generator: 1, built: '2026-01-01' }
                }
            })
        }
    });
    await buildTerrain([{ lat: 47, lon: 8 }]);
    const index = JSON.parse(disk.get(DEFAULT_DIR + '/' + TERRAIN_INDEX_FILE));
    assert.deepEqual(Object.keys(index.files), ['N46E008.TER', 'N47E008.TER']);
    assert.equal(index.files['N46E008.TER'].source, 'srtm');
});

test('one cell failing does not stop the others', async () => {
    const { disk } = fakeHost({
        buildCell: async (lat) => {
            if (lat === 48) throw new Error('HTTP 503');
            return { name: 'x', bytes: new Uint8Array([9]), source: 'sea' };
        }
    });
    const result = await buildTerrain([{ lat: 47, lon: 8 }, { lat: 48, lon: 8 }, { lat: 49, lon: 8 }]);
    assert.deepEqual(result.built.map(b => b.name), ['N47E008.TER', 'N49E008.TER']);
    assert.deepEqual(result.failed, [{ name: 'N48E008.TER', cell: { lat: 48, lon: 8 }, error: 'HTTP 503' }]);
    assert.ok(!disk.has(DEFAULT_DIR + '/N48E008.TER'));
    assert.equal(JSON.parse(disk.get(DEFAULT_DIR + '/' + TERRAIN_INDEX_FILE)).files['N49E008.TER'].source, 'sea');
});

test('a full disk fails the cell before anything is downloaded', async () => {
    const { builds } = fakeHost({ free: 10e6 });
    const result = await buildTerrain([{ lat: 47, lon: 8 }]);
    assert.equal(result.built.length, 0);
    assert.match(result.failed[0].error, /disk space/);
    assert.deepEqual(builds, []);
});

test('an abort stops the cell in progress and skips the rest', async () => {
    const controller = new AbortController();
    const started = [];
    const { disk } = fakeHost({
        buildCell: async (lat, lon, options) => {
            started.push(lat);
            controller.abort();
            options.signal.throwIfAborted();
            return { name: 'x', bytes: new Uint8Array([9]), source: 'copernicus' };
        }
    });
    const result = await buildTerrain([{ lat: 47, lon: 8 }, { lat: 48, lon: 8 }], { signal: controller.signal });
    assert.ok(result.aborted);
    assert.deepEqual(result.built, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(started, [47]);
    assert.equal(disk.size, 0);
});

test('two requests for the same cell share one build, and builds run one at a time', async () => {
    let active = 0;
    let peak = 0;
    const order = [];
    fakeHost({
        buildCell: async (lat, lon) => {
            active++;
            peak = Math.max(peak, active);
            order.push(lat + '_' + lon);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return { name: 'x', bytes: new Uint8Array([9]), source: 'copernicus' };
        }
    });
    const first = buildTerrain([{ lat: 47, lon: 8 }, { lat: 47, lon: 9 }]);
    assert.ok(terrainBuildPending(47, 8));
    const second = buildTerrain([{ lat: 47, lon: 8 }, { lat: 46, lon: 8 }]);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(peak, 1);
    assert.deepEqual(order.filter(key => key === '47_8'), ['47_8']);
    assert.deepEqual(a.built.map(x => x.name), ['N47E008.TER', 'N47E009.TER']);
    assert.deepEqual(b.built.map(x => x.name), ['N47E008.TER', 'N46E008.TER']);
    assert.ok(!terrainBuildPending(47, 8));
});

test('a file asked for in one folder lands there after the folder is changed', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { disk } = fakeHost({
        buildCell: async () => {
            await gate;
            return { name: 'x', bytes: new Uint8Array([9]), source: 'copernicus' };
        }
    });
    const events = [];
    onTerrainChange(event => events.push(event));
    const pending = buildTerrain([{ lat: 47, lon: 8 }]);
    setTerrainFolder('D:/Other');
    release();
    await pending;
    assert.ok(disk.has(DEFAULT_DIR + '/N47E008.TER'));
    assert.ok(!disk.has('D:/Other/N47E008.TER'));
    assert.deepEqual(events.map(e => e.type + ':' + e.dir), ['folder:D:/Other', 'file:' + DEFAULT_DIR]);
    assert.equal(terrainFileInfo('N47E008.TER'), null);
});

test('copyTerrainTo copies what is missing or differs, and reports the rest', async () => {
    const { disk } = fakeHost({
        files: {
            [DEFAULT_DIR + '/N47E008.TER']: 'aaaa',
            [DEFAULT_DIR + '/N47E009.TER']: 'bbbb',
            [DEFAULT_DIR + '/N46E008.TER']: 'cccc',
            'E:/N47E008.TER': 'aaaa',       // same size: left alone
            'E:/N47E009.TER': 'bb'          // other size: replaced
        }
    });
    const seen = [];
    const result = await copyTerrainTo(['N47E008.TER', 'N47E009.TER', 'N46E008.TER', 'N10E010.TER'], 'E:',
        { onProgress: p => seen.push(p.name) });
    assert.deepEqual(result.copied, ['N47E009.TER', 'N46E008.TER']);
    assert.deepEqual(result.skipped, ['N47E008.TER']);
    assert.deepEqual(result.failed, [{ name: 'N10E010.TER', error: 'not in the terrain folder' }]);
    assert.equal(disk.get('E:/N47E009.TER'), 'bbbb');
    assert.equal(disk.get('E:/N46E008.TER'), 'cccc');
    assert.equal(seen.length, 4);

    const forced = await copyTerrainTo(['N47E008.TER'], 'E:', { overwrite: true });
    assert.deepEqual(forced.copied, ['N47E008.TER']);
});
