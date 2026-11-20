// The terrain folder: the one place on disk where the Configurator keeps
// elevation, as the .TER files the flight controller reads. Mission Control and
// the Map Generator both use it through this module. The folder's .TER files
// copy straight to an SD card root.
//
// Besides the .TER files the folder holds two small text files, named to be
// safe on a FAT card (the firmware only opens <cell>.TER):
//   TERINDEX.TXT   which data each file was built from, by which generator
//                  version and when. Safe to delete: files then show as unlabelled.
//   NOTICE.TXT     the attribution the Copernicus licence asks to travel with
//                  the data.
//
// Building a file downloads its elevation data into memory and keeps none of it
// (js/terrain_build.js). One file is built at a time; two requests for the same
// cell share one build.
//
// No DOM. Settings, file access and the builder are injected (defaultIo() uses
// the Electron bridge); tests/terrain-library.test.mjs runs it on a fake folder.

import { buildCellTer, pruneImageCache, TER_GENERATOR_VERSION } from './terrain_build.js';
import { copernicusNoticeText } from './terrain_elevation.js';
import { TERRAIN_IO_BLOCK, terrainDatFilename, terTileDimensions } from './terrain_ter.js';

export const TERRAIN_FOLDER_KEY = 'terrain_folder';
const OLD_PLANNER_FOLDER_KEY = 'missionPlannerTerrainFolder';   // jb/wpterrain; read once, never written
export const TERRAIN_INDEX_FILE = 'TERINDEX.TXT';
export const TERRAIN_NOTICE_FILE = 'NOTICE.TXT';
const INDEX_FORMAT = 1;
const TER_NAME = /^[NS]\d{2}[EW]\d{3}\.TER$/;
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

export const TerrainFileState = Object.freeze({
    CURRENT: 'current',         // built by this generator version
    OUTDATED: 'outdated',       // built by an older generator version
    UNLABELLED: 'unlabelled'    // no index entry: copied in, or the index was deleted
});

function defaultIo() {
    const api = () => globalThis.electronAPI;
    return {
        available: () => !globalThis.__INAV_BROWSER_BUILD__ && typeof api()?.writeFileAtomic === 'function',
        storeGet: (key, fallback) => api().storeGet(key, fallback),
        storeSet: (key, value) => api().storeSet(key, value),
        documentsDir: () => api().appGetPath('documents'),
        listFiles: (dir) => api().listFiles(dir),
        readText: async (file) => {
            const result = await api().readFile(file, 'utf8');
            return result && !result.error && typeof result.data === 'string' ? result.data : null;
        },
        writeFileAtomic: (file, data) => api().writeFileAtomic(file, data),
        copyFileAtomic: (src, dest) => api().copyFileAtomic(src, dest),
        diskFree: (dir) => api().diskFree(dir),
        buildCell: (lat, lon, options) => buildCellTer(lat, lon, options),
        today: () => new Date().toISOString().slice(0, 10)
    };
}

let io = defaultIo();
const listeners = new Set();
const running = new Map();          // file name -> promise of the build in progress or queued
let queue = Promise.resolve();      // builds run one after the other
let indexLock = Promise.resolve();  // index updates run one after the other
let imgCache = {};
let folderMemo = null;              // the active folder, once read from the settings
let knownIndex = { dir: null, files: {} };  // the index as last read, for terrainFileInfo()

/* Replace settings, file access or the builder (tests, other hosts). Omitted members keep their default. */
export function configureTerrainLibrary(overrides = {}) {
    io = { ...defaultIo(), ...overrides };
    listeners.clear();
    running.clear();
    queue = Promise.resolve();
    indexLock = Promise.resolve();
    imgCache = {};
    folderMemo = null;
    knownIndex = { dir: null, files: {} };
}

/* True when this build can keep terrain files (the desktop app; not the web build). */
export function terrainLibraryAvailable() {
    return Boolean(io.available());
}

// ─── The folder setting ───────────────────────────────────────────────────────

/* Joins with the separator the folder's own path uses, so a Windows path is shown
   and handed to the file dialog with backslashes throughout. */
function joinPath(dir, name) {
    const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir + (/[\\/]$/.test(dir) ? '' : separator) + name;
}

/* Where terrain files go until the user chooses another folder. */
export function terrainFolderDefaultDir() {
    return joinPath(joinPath(io.documentsDir(), 'INAV Terrain'), 'Default');
}

/* The folder above the default one: where the folder dialog starts, so "New folder" makes a sibling. */
export function terrainFolderParentDir() {
    return joinPath(io.documentsDir(), 'INAV Terrain');
}

/*
 * The active terrain folder. An empty setting means the default folder. A
 * setting that was never written takes over the folder chosen in Mission
 * Control before there was a shared one.
 */
export function terrainFolderDir() {
    // Remembered: every elevation lookup asks, and the settings are read over a
    // blocking call to the main process. Only setTerrainFolder() changes it.
    if (folderMemo === null) {
        folderMemo = readTerrainFolderSetting();
    }
    return folderMemo;
}

function readTerrainFolderSetting() {
    const stored = io.storeGet(TERRAIN_FOLDER_KEY, null);
    if (typeof stored === 'string') {
        return stored || terrainFolderDefaultDir();
    }
    const old = io.storeGet(OLD_PLANNER_FOLDER_KEY, null);
    if (typeof old === 'string' && old) {
        io.storeSet(TERRAIN_FOLDER_KEY, old);
        return old;
    }
    return terrainFolderDefaultDir();
}

export function terrainFolderIsDefault() {
    return terrainFolderDir() === terrainFolderDefaultDir();
}

/* Chooses the active folder; null or '' goes back to the default one. */
export function setTerrainFolder(dir) {
    const before = terrainFolderDir();
    io.storeSet(TERRAIN_FOLDER_KEY, dir ? String(dir) : '');
    folderMemo = null;
    const after = terrainFolderDir();
    if (after !== before) {
        imgCache = {};
        emit({ type: 'folder', dir: after });
    }
}

export function terrainFilePath(name) {
    return joinPath(terrainFolderDir(), name);
}

// ─── Change events ────────────────────────────────────────────────────────────

/*
 * listener(event) is called when the folder is changed
 * ({ type: 'folder', dir }) and when a file was written into it
 * ({ type: 'file', dir, name, lat, lon }). Returns a function that removes it.
 */
export function onTerrainChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function emit(event) {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (error) {
            console.log('Terrain listener failed: ' + (error?.message || error));
        }
    }
}

// ─── Index ────────────────────────────────────────────────────────────────────

function emptyIndex() {
    return {
        about: 'Written by INAV Configurator: what each terrain file was built from. Safe to delete.',
        format: INDEX_FORMAT,
        files: {}
    };
}

/* Parses TERINDEX.TXT; anything unreadable counts as an empty index. */
export function parseTerrainIndex(text) {
    const index = emptyIndex();
    if (typeof text !== 'string' || !text.trim()) return index;
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return index;
    }
    const files = parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {};
    for (const name of Object.keys(files)) {
        const entry = files[name];
        if (!TER_NAME.test(name) || !entry || typeof entry !== 'object') continue;
        index.files[name] = {
            source: typeof entry.source === 'string' ? entry.source : 'unknown',
            generator: Number.isInteger(entry.generator) ? entry.generator : 0,
            built: typeof entry.built === 'string' ? entry.built : ''
        };
    }
    return index;
}

async function readIndex(dir) {
    let text = null;
    try {
        text = await io.readText(joinPath(dir, TERRAIN_INDEX_FILE));
    } catch (error) {
        text = null;
    }
    return parseTerrainIndex(text);
}

async function listTerFiles(dir) {
    let files = [];
    try {
        files = (await io.listFiles(dir)) || [];
    } catch (error) {
        files = [];
    }
    return files;
}

function withIndexLock(task) {
    const run = indexLock.then(task, task);
    indexLock = run.catch(() => {});
    return run;
}

/* Sets one entry; also drops entries whose file is no longer in the folder. */
function recordInIndex(dir, name, entry) {
    return withIndexLock(async () => {
        const index = await readIndex(dir);
        const present = new Set((await listTerFiles(dir)).map(file => file.name.toUpperCase()));
        for (const known of Object.keys(index.files)) {
            if (!present.has(known)) delete index.files[known];
        }
        index.files[name] = entry;
        const sorted = {};
        for (const key of Object.keys(index.files).sort()) sorted[key] = index.files[key];
        index.files = sorted;
        const error = await io.writeFileAtomic(joinPath(dir, TERRAIN_INDEX_FILE), JSON.stringify(index, null, 1) + '\n');
        if (error) throw new Error(error);
        knownIndex = { dir, files: index.files };
    });
}

function fileState(entry) {
    if (!entry) return TerrainFileState.UNLABELLED;
    return entry.generator >= TER_GENERATOR_VERSION ? TerrainFileState.CURRENT : TerrainFileState.OUTDATED;
}

/*
 * What is in the active folder:
 *   { dir, files: Map(name -> { name, size, source, generator, built, state }),
 *     count, bytes, unlabelled, outdated }
 * source is 'copernicus', 'srtm', 'sea', or null for a file with no index entry.
 */
export async function listTerrain() {
    const dir = terrainFolderDir();
    const [listing, index] = await Promise.all([listTerFiles(dir), readIndex(dir)]);
    knownIndex = { dir, files: index.files };
    const files = new Map();
    let bytes = 0;
    let unlabelled = 0;
    let outdated = 0;
    for (const file of listing) {
        const name = String(file.name).toUpperCase();
        if (!TER_NAME.test(name)) continue;
        const entry = index.files[name] || null;
        const state = fileState(entry);
        if (state === TerrainFileState.UNLABELLED) unlabelled++;
        if (state === TerrainFileState.OUTDATED) outdated++;
        bytes += file.size || 0;
        files.set(name, {
            name,
            size: file.size || 0,
            source: entry ? entry.source : null,
            generator: entry ? entry.generator : null,
            built: entry ? entry.built : null,
            state
        });
    }
    return { dir, files, count: files.size, bytes, unlabelled, outdated };
}

/*
 * The index entry of one file as last read (listTerrain() and every build
 * refresh it): { source, generator, built }, or null when the file has none or
 * the index of the active folder has not been read yet. Not a promise, so a
 * label can use it while drawing.
 */
export function terrainFileInfo(name) {
    if (knownIndex.dir !== terrainFolderDir()) return null;
    return knownIndex.files[String(name).toUpperCase()] || null;
}

// ─── Building ─────────────────────────────────────────────────────────────────

/* Size in bytes of the .TER file of the cell with this south-west corner. */
export function terFileBytes(lat, lon) {
    const { numX, numY } = terTileDimensions(lat, lon);
    return numX * numY * TERRAIN_IO_BLOCK;
}

/* Attribution text kept next to the terrain files. */
export function terrainNoticeText() {
    return copernicusNoticeText() +
        '\r\nCells that Copernicus does not cover are built from NASA SRTM (public domain).\r\n';
}

async function writeNoticeIfAbsent(dir, present) {
    if (present.has(TERRAIN_NOTICE_FILE)) return;
    const error = await io.writeFileAtomic(joinPath(dir, TERRAIN_NOTICE_FILE), terrainNoticeText());
    if (error) console.log('Could not write ' + TERRAIN_NOTICE_FILE + ': ' + error);
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

async function buildOne(dir, cell, name, { force, signal, onStage }) {
    if (signal) signal.throwIfAborted();
    const present = new Set((await listTerFiles(dir)).map(file => String(file.name).toUpperCase()));
    if (!force && present.has(name)) {
        return { name, cell, status: 'present' };
    }

    let free = null;
    try {
        free = await io.diskFree(dir);
    } catch (error) {
        free = null;
    }
    const size = terFileBytes(cell.lat, cell.lon);
    if (typeof free === 'number' && free < size + FREE_SPACE_MARGIN) {
        throw new Error('not enough free disk space for ' + name);
    }

    const built = await io.buildCell(cell.lat, cell.lon, { imgCache, signal, onStage });
    pruneImageCache(imgCache);
    if (signal) signal.throwIfAborted();

    // The file goes into the folder that was active when it was asked for, even
    // if another folder has been chosen since.
    if (onStage) onStage('writing');
    const error = await io.writeFileAtomic(joinPath(dir, name), built.bytes);
    if (error) throw new Error(error);
    try {
        await recordInIndex(dir, name, { source: built.source, generator: TER_GENERATOR_VERSION, built: io.today() });
    } catch (indexError) {
        // The file is good; it only shows as unlabelled.
        console.log('Could not update ' + TERRAIN_INDEX_FILE + ': ' + (indexError?.message || indexError));
    }
    await writeNoticeIfAbsent(dir, present);
    emit({ type: 'file', dir, name, lat: cell.lat, lon: cell.lon });
    return { name, cell, status: 'built', source: built.source, bytes: built.bytes.length };
}

function enqueue(dir, cell, name, options) {
    const key = dir + '|' + name;
    if (running.has(key)) return running.get(key);
    const run = queue.then(() => buildOne(dir, cell, name, options));
    queue = run.catch(() => {});
    const tracked = run.finally(() => {
        if (running.get(key) === tracked) running.delete(key);
    });
    tracked.catch(() => {});
    running.set(key, tracked);
    return tracked;
}

/* True while a build of this cell is running or waiting. */
export function terrainBuildPending(lat, lon) {
    return running.has(terrainFolderDir() + '|' + terrainDatFilename(lat, lon));
}

/*
 * Builds the .TER files of `cells` ([{ lat, lon }], south-west corners) into the
 * active folder, one after the other. A cell whose file is already there is
 * left alone unless `force`.
 *
 *   onProgress({ index, total, name, cell, stage, done, of })
 *              before and during each cell; stage is 'queued', a build stage
 *              ('downloading', 'decoding', 'grid', 'edges', 'packing') or 'writing'
 *   signal     AbortSignal: stops the cell in progress and skips the rest
 *
 * Resolves to { built: [{ name, cell, source, bytes }], present: [name],
 * failed: [{ name, cell, error }], aborted }. One cell failing does not stop
 * the others.
 */
export async function buildTerrain(cells, { onProgress = null, signal = null, force = false } = {}) {
    const dir = terrainFolderDir();
    const result = { built: [], present: [], failed: [], aborted: false };
    for (let index = 0; index < cells.length; index++) {
        const cell = { lat: cells[index].lat, lon: cells[index].lon };
        const name = terrainDatFilename(cell.lat, cell.lon);
        if (signal?.aborted) {
            result.aborted = true;
            break;
        }
        const report = (stage, done, of) => {
            if (onProgress) onProgress({ index, total: cells.length, name, cell, stage, done, of });
        };
        report('queued');
        try {
            const outcome = await enqueue(dir, cell, name, { force, signal, onStage: report });
            if (outcome.status === 'built') {
                result.built.push({ name, cell, source: outcome.source, bytes: outcome.bytes });
            } else {
                result.present.push(name);
            }
        } catch (error) {
            if (isAbort(error)) {
                result.aborted = true;
                break;
            }
            result.failed.push({ name, cell, error: String(error?.message || error) });
        }
    }
    return result;
}

// ─── Copying to an SD card ────────────────────────────────────────────────────

/*
 * Copies terrain files from the active folder into destDir (an SD card root).
 * A file already there with the same size is left alone unless `overwrite`.
 * onProgress({ index, total, name }) before each file. Resolves to
 * { copied: [name], skipped: [name], failed: [{ name, error }] }.
 */
export async function copyTerrainTo(names, destDir, { overwrite = false, onProgress = null, signal = null } = {}) {
    const dir = terrainFolderDir();
    const sizes = new Map((await listTerFiles(dir)).map(file => [String(file.name).toUpperCase(), file.size]));
    const there = new Map((await listTerFiles(destDir)).map(file => [String(file.name).toUpperCase(), file.size]));
    const result = { copied: [], skipped: [], failed: [] };
    for (let index = 0; index < names.length; index++) {
        if (signal?.aborted) break;
        const name = names[index];
        if (onProgress) onProgress({ index, total: names.length, name });
        if (!sizes.has(name)) {
            result.failed.push({ name, error: 'not in the terrain folder' });
            continue;
        }
        if (!overwrite && there.has(name) && there.get(name) === sizes.get(name)) {
            result.skipped.push(name);
            continue;
        }
        let error;
        try {
            error = await io.copyFileAtomic(joinPath(dir, name), joinPath(destDir, name));
        } catch (thrown) {
            error = String(thrown?.message || thrown);
        }
        if (error) {
            result.failed.push({ name, error });
        } else {
            result.copied.push(name);
        }
    }
    return result;
}
