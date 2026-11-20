'use strict';

/*
 * Ground elevation for the mission planner.
 *
 * Sources, tried in this order for every point:
 *   1. the terrain folder (js/terrain_library.js): INAV terrain files (.TER), read
 *      the way the firmware reads them (js/terrain_ter.js), so the planner sees
 *      the ground the flight controller will see;
 *   2. for a point whose cell has no file in the folder, by what that file would
 *      be built from (cellBuildEstimate in js/offline_regions.js):
 *        Copernicus GLO-30  the tile on the server, read with range requests;
 *        all sea            0 m, with no request;
 *        land Copernicus leaves out (built from SRTM): nothing here, see 3;
 *   3. ASTER (opentopodata's aster30m) for points still without an answer.
 *
 * A cell with no file in the folder can have one built: the planner is told which
 * files a lookup would have used (setTileWantedListener) and answers with
 * buildTiles() or declineTiles(). Lookups never wait for that: they use the
 * server until the file is there, and read the file from then on.
 *
 * Every answer says which source it came from. The module has no DOM and no
 * direct file access: file reads, the terrain folder and the online fetch are
 * injected, with defaults that use the Electron bridge, js/terrain_library.js,
 * js/terrain_point.js and js/elevationFetch.js.
 */

import elevationFetch from './elevationFetch.js';
import {
    TERRAIN_IO_DATA,
    terBlockHeight,
    terBlockOffset,
    terDecodeBlock,
    terGridInfo,
    terTileName,
    terrainDatFilename
} from './terrain_ter.js';
import { cellBuildEstimate } from './offline_regions.js';
import {
    buildTerrain,
    onTerrainChange,
    terrainBuildPending,
    terrainFolderDir,
    terrainLibraryAvailable
} from './terrain_library.js';
import { cellOf, createPointSampler, openCopernicusRemote } from './terrain_point.js';

export const ElevationSource = Object.freeze({
    TER: 'ter',                 // terrain file in the terrain folder
    COPERNICUS: 'copernicus',   // Copernicus tile on the server (range read), or a sea cell
    ASTER: 'aster',             // opentopodata aster30m
    NONE: 'none'                // no data from any source
});

/* What happens when a lookup would use a terrain file that is not in the folder. */
export const TileDownload = Object.freeze({
    ASK: 'ask',         // tell the listener, which asks the user
    ALWAYS: 'always',   // build it without asking
    NEVER: 'never'      // leave it; keep using the server
});

const OPENTOPO_URL = 'https://api.opentopodata.org/v1/';
const ASTER_DATASET = 'aster30m';
const ONLINE_BATCH = 100;           // opentopodata accepts at most 100 locations per request
const DEFAULT_ONLINE_LIMIT = 100;   // one request (they are spaced 1.1 s apart) per call unless the caller allows more
const BLOCK_CACHE_LIMIT = 4000;     // decoded .TER blocks kept in memory (about 1.2 kB each)
const ONLINE_CACHE_LIMIT = 5000;
const REMOTE_RETRY_MS = 60000;      // after a Copernicus tile failed to open, leave the server alone this long

let io = defaultIo();
let terFolder = null;               // the folder the caches below belong to
let tileDownload = TileDownload.ASK;
let tileWantedListener = null;
let sampler = makeSampler();
let stopListening = null;
const blockCache = new Map();       // "<tile>:<offset>" -> decoded block, or null when the slot holds no usable block
const tileExists = new Map();       // .TER tile name -> boolean
const onlineCache = new Map();      // "lat,lon" (5 decimals) -> metres or null
const tilesUsed = new Set();
const tilesMissing = new Set();
const askedTiles = new Set();       // files the listener was told about, or the user declined, this session
const remoteFailedAt = new Map();   // "<lat>_<lon>" -> time a Copernicus tile failed to open on the server

function defaultIo() {
    return {
        readFileRanges: (path, ranges) => globalThis.electronAPI.readFileRanges(path, ranges),
        pathExists: (path) => globalThis.electronAPI.pathExists(path),
        fetchOnline: (url) => elevationFetch(url),
        localAvailable: () => typeof globalThis.electronAPI?.readFileRanges === 'function',

        // The terrain folder (js/terrain_library.js)
        terFolder: () => (terrainLibraryAvailable() ? terrainFolderDir() : null),
        canBuild: () => terrainLibraryAvailable(),
        buildTerrain: (cells, options) => buildTerrain(cells, options),
        buildPending: (lat, lon) => terrainBuildPending(lat, lon),
        onTerrainChange: (listener) => onTerrainChange(listener),

        // The elevation servers (js/terrain_point.js) and the bundled cell index
        openCopernicus: (lat, lon) => openCopernicusRemote(lat, lon),
        cellInfo: (lat, lon) => cellBuildEstimate(lat, lon),
        now: () => Date.now()
    };
}

function makeSampler() {
    return createPointSampler({
        openCopernicus: async (lat, lon, neighbour) => {
            const key = lat + '_' + lon;
            // The tile south or east of the one a point is in: none there means sea.
            if (neighbour && io.cellInfo(lat, lon).source !== 'copernicus') return null;
            if (remoteFailedAt.has(key)) {
                if (io.now() - remoteFailedAt.get(key) < REMOTE_RETRY_MS) {
                    throw new Error('tile ' + key + ' failed to open a moment ago');
                }
                remoteFailedAt.delete(key);
            }
            try {
                return await io.openCopernicus(lat, lon);
            } catch (error) {
                remoteFailedAt.set(key, io.now());
                throw error;
            }
        }
    });
}

function listenToFolder() {
    if (stopListening) stopListening();
    stopListening = io.onTerrainChange(event => {
        if (event.type !== 'file' || event.dir !== terFolder) return;
        // A file was written: what was remembered about that cell is out of date.
        forgetTerFile(event.name);
        sampler.forgetTile(event.lat, event.lon);
    }) || null;
}

listenToFolder();

/* Replace the file and network access (tests, other hosts). Omitted members keep their default. */
export function configureElevationProvider(overrides = {}) {
    io = { ...defaultIo(), ...overrides };
    if (overrides.readFileRanges && !overrides.localAvailable) {
        io.localAvailable = () => true;
    }
    terFolder = null;
    resetElevationCaches();
    listenToFolder();
}

export function resetElevationCaches() {
    forgetTerFiles();
    onlineCache.clear();
    askedTiles.clear();
    remoteFailedAt.clear();
    sampler = makeSampler();
}

/*
 * Forgets which files the folder holds and what was read from them. Call it when
 * files may have been copied into or removed from the folder outside the app.
 */
export function forgetTerFiles() {
    blockCache.clear();
    tileExists.clear();
    tilesUsed.clear();
    tilesMissing.clear();
}

/* The active terrain folder; a change of folder drops what was read from the old one. */
function currentFolder() {
    const folder = io.terFolder();
    const next = folder ? String(folder) : null;
    if (next !== terFolder) {
        terFolder = next;
        forgetTerFiles();
    }
    return terFolder;
}

/* Folder holding the .TER files, or null when this build has none. */
export function getTerFolder() {
    return currentFolder();
}

/* True when there is a terrain folder and this build can read files from it. */
export function isLocalTerrainActive() {
    return Boolean(currentFolder()) && io.localAvailable();
}

/* Which files the lookups so far found in the folder and which they did not. */
export function elevationSourceStatus() {
    return {
        folder: currentFolder(),
        localActive: isLocalTerrainActive(),
        tilesUsed: [...tilesUsed].sort(),
        tilesMissing: [...tilesMissing].sort()
    };
}

function forgetTerFile(name) {
    tileExists.delete(name);
    tilesUsed.delete(name);
    tilesMissing.delete(name);
    for (const key of [...blockCache.keys()]) {
        if (key.startsWith(name + ':')) blockCache.delete(key);
    }
}

export const TerFileState = Object.freeze({
    PRESENT: 'present',     // the file is in the folder
    BUILDING: 'building',   // it is being built, or waiting its turn
    MISSING: 'missing',     // it is not there and nothing is building it
    NONE: 'none'            // this build keeps no terrain files
});

/*
 * Where the terrain file of the cell holding a point stands right now:
 * { state, name, lat, lon, stale }. The folder is asked each time, not the
 * memory of earlier lookups, so "missing" is only said of a file that is not
 * there. stale is true when the lookups had it the other way round (a file
 * copied in or deleted outside the app): what they remembered about that file
 * is dropped, and the caller should look its heights up again.
 */
export async function terFileState(lat, lon) {
    const cell = cellOf(Number(lat), Number(lon));
    const name = terrainDatFilename(cell.lat, cell.lon);
    const answer = { state: TerFileState.NONE, name, lat: cell.lat, lon: cell.lon, stale: false };
    if (!isLocalTerrainActive()) {
        return answer;
    }
    if (io.buildPending(cell.lat, cell.lon)) {
        answer.state = TerFileState.BUILDING;
        return answer;
    }
    const folder = terFolder;
    let exists = false;
    try {
        exists = Boolean(await io.pathExists(tilePath(name)));
    } catch (error) {
        exists = false;
    }
    if (folder === terFolder && tileExists.has(name) && tileExists.get(name) !== exists) {
        forgetTerFile(name);
        answer.stale = true;
    }
    // A build may have started while the folder was being asked.
    if (!exists && io.buildPending(cell.lat, cell.lon)) {
        answer.state = TerFileState.BUILDING;
        return answer;
    }
    answer.state = exists ? TerFileState.PRESENT : TerFileState.MISSING;
    return answer;
}

/* An unknown value counts as "ask". */
export function setTileDownload(mode) {
    tileDownload = Object.values(TileDownload).includes(mode) ? mode : TileDownload.ASK;
}

export function getTileDownload() {
    return tileDownload;
}

/* True when this build has a terrain folder to build files into. */
export function canBuildTiles() {
    return Boolean(io.canBuild());
}

/*
 * listener(tiles) is called, at most once per file per session, with the terrain
 * files a lookup would have read had they been in the folder:
 * [{ key, name, lat, lon, source, downloadBytes, terBytes }]. source is what the
 * file is built from ('copernicus', 'srtm' or 'sea'). Only in "ask" mode. Null
 * removes it.
 */
export function setTileWantedListener(listener) {
    tileWantedListener = typeof listener === 'function' ? listener : null;
}

function tilePath(name) {
    const separator = /[\\/]$/.test(terFolder) ? '' : '/';
    return terFolder + separator + name;
}

async function hasTile(name) {
    if (!tileExists.has(name)) {
        let exists = false;
        try {
            exists = Boolean(await io.pathExists(tilePath(name)));
        } catch (error) {
            exists = false;
        }
        tileExists.set(name, exists);
        (exists ? tilesUsed : tilesMissing).add(name);
    }
    return tileExists.get(name);
}

function rememberBlock(key, block) {
    if (blockCache.size >= BLOCK_CACHE_LIMIT) {
        blockCache.delete(blockCache.keys().next().value);
    }
    blockCache.set(key, block);
}

/* Fills `heights[i]` and `files[i]` for every point the folder has data for; leaves the rest undefined. */
async function lookUpLocal(points, heights, files) {
    const wanted = new Map();   // tile -> Map(offset -> [{ index, info }])

    for (let index = 0; index < points.length; index++) {
        const lat = Number(points[index].lat);
        const lon = Number(points[index].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90 || Math.abs(lon) > 180) {
            continue;
        }
        const info = terGridInfo(Math.round(lat * 1e7), Math.round(lon * 1e7));
        const tile = terTileName(info);
        if (!(await hasTile(tile))) {
            continue;
        }
        const offset = terBlockOffset(info);
        const key = tile + ':' + offset;
        if (blockCache.has(key)) {
            const block = blockCache.get(key);
            const height = block ? terBlockHeight(block, info) : null;
            if (height !== null) {
                heights[index] = height;
                files[index] = tile;
            }
            continue;
        }
        if (!wanted.has(tile)) wanted.set(tile, new Map());
        const blocks = wanted.get(tile);
        if (!blocks.has(offset)) blocks.set(offset, []);
        blocks.get(offset).push({ index, info });
    }

    for (const [tile, blocks] of wanted) {
        const offsets = [...blocks.keys()].sort((a, b) => a - b);
        let chunks = null;
        try {
            const result = await io.readFileRanges(tilePath(tile), offsets.map(offset => [offset, TERRAIN_IO_DATA]));
            chunks = result && !result.error ? result.data : null;
        } catch (error) {
            chunks = null;
        }
        offsets.forEach((offset, i) => {
            const users = blocks.get(offset);
            const bytes = chunks && chunks[i] ? new Uint8Array(chunks[i]) : null;
            const block = bytes ? terDecodeBlock(bytes, users[0].info) : null;
            // A failed read is not remembered: the card may only have been busy.
            if (chunks) rememberBlock(tile + ':' + offset, block);
            if (!block) return;
            for (const { index, info } of users) {
                const height = terBlockHeight(block, info);
                if (height !== null) {
                    heights[index] = height;
                    files[index] = tile;
                }
            }
        });
    }
}

// ─── Terrain files that are not in the folder ─────────────────────────────────

function tileInfo(cell) {
    const name = terrainDatFilename(cell.lat, cell.lon);
    const info = io.cellInfo(cell.lat, cell.lon);
    return {
        key: name,
        name,
        lat: cell.lat,
        lon: cell.lon,
        source: info.source,
        downloadBytes: info.downloadBytes,
        terBytes: info.terBytes
    };
}

function keyOf(tile) {
    return tile.key || terrainDatFilename(tile.lat, tile.lon);
}

/*
 * Builds terrain files into the folder, one after the other. onProgress is called
 * with { done, total, tile, stage, stageDone, stageOf } as each one advances.
 * Resolves to { built: [tile], failed: [{ tile, error }], aborted }. Lookups made
 * after a file was written read it from the folder.
 */
export async function buildTiles(tiles, onProgress, signal) {
    for (const tile of tiles) {
        askedTiles.add(keyOf(tile));
    }
    const outcome = await io.buildTerrain(tiles.map(tile => ({ lat: tile.lat, lon: tile.lon })), {
        signal,
        onProgress: onProgress ? (step) => onProgress({
            done: step.index,
            total: step.total,
            tile: tiles[step.index],
            stage: step.stage,
            stageDone: step.done,
            stageOf: step.of
        }) : null
    });
    const byName = new Map(tiles.map(tile => [keyOf(tile), tile]));
    return {
        // a file that turned out to be there already counts as built
        built: [...outcome.built.map(item => item.name), ...outcome.present].map(name => byName.get(name)).filter(Boolean),
        failed: outcome.failed.map(item => ({ tile: byName.get(item.name), error: item.error })),
        aborted: Boolean(outcome.aborted)
    };
}

/* The user does not want these files: they are not asked about again this session. */
export function declineTiles(tiles) {
    for (const tile of tiles) {
        askedTiles.add(keyOf(tile));
    }
}

/* The listener was told about these files but the user never got to answer (the
   question was withdrawn): a later lookup may ask about them again. */
export function forgetTileQuestions(tiles) {
    for (const tile of tiles) {
        askedTiles.delete(keyOf(tile));
    }
}

// ─── opentopodata (ASTER) ─────────────────────────────────────────────────────

function onlineKey(point) {
    return Number(point.lat).toFixed(5) + ',' + Number(point.lon).toFixed(5);
}

/* Asks opentopodata for each point (batched); returns metres or null per point. */
async function fetchOnlineBatch(points) {
    const answers = new Array(points.length).fill(null);
    const pending = [];
    points.forEach((point, i) => {
        const key = onlineKey(point);
        if (onlineCache.has(key)) {
            answers[i] = onlineCache.get(key);
        } else {
            pending.push({ i, key });
        }
    });

    for (let start = 0; start < pending.length; start += ONLINE_BATCH) {
        const batch = pending.slice(start, start + ONLINE_BATCH);
        try {
            const response = await io.fetchOnline(OPENTOPO_URL + ASTER_DATASET + '?locations=' + batch.map(entry => entry.key).join('|'));
            const body = await response.json();
            if (body.status !== 'OK' || !Array.isArray(body.results)) {
                continue;
            }
            batch.forEach((entry, n) => {
                const value = body.results[n] ? body.results[n].elevation : null;
                const elevation = (value === null || value === undefined) ? null : Number(value);
                answers[entry.i] = elevation;
                if (onlineCache.size >= ONLINE_CACHE_LIMIT) {
                    onlineCache.delete(onlineCache.keys().next().value);
                }
                onlineCache.set(entry.key, elevation);
            });
        } catch (error) {
            console.log('Elevation lookup failed: ' + error.message);
        }
    }
    return answers;
}

/*
 * Fills results[index] for the given indices from ASTER. When there are more than
 * `limit` of them, only that many (evenly spread, first and last included) are
 * asked for and the others are interpolated by position in the list and marked
 * coarse. Indices that got no answer keep what they had.
 */
async function lookUpAster(points, indices, limit, results) {
    const source = ElevationSource.ASTER;
    if (indices.length === 0) return;
    if (indices.length <= limit) {
        const answers = await fetchOnlineBatch(indices.map(i => points[i]));
        indices.forEach((index, n) => {
            if (answers[n] !== null) {
                results[index] = { elevation: answers[n], source };
            }
        });
        return;
    }

    const picked = [];
    for (let n = 0; n < limit; n++) {
        picked.push(Math.round(n * (indices.length - 1) / (limit - 1)));
    }
    const answers = await fetchOnlineBatch(picked.map(n => points[indices[n]]));
    let left = -1;
    for (let p = 0; p < picked.length; p++) {
        if (answers[p] === null) continue;
        results[indices[picked[p]]] = { elevation: answers[p], source };
        if (left >= 0) {
            const from = picked[left];
            const to = picked[p];
            for (let n = from + 1; n < to; n++) {
                const t = (n - from) / (to - from);
                results[indices[n]] = {
                    elevation: Math.round((answers[left] + t * (answers[p] - answers[left])) * 10) / 10,
                    source,
                    coarse: true
                };
            }
        }
        left = p;
    }
}

// ─── Cells without a terrain file ─────────────────────────────────────────────

/*
 * Fills results[index] where the cell's own data can answer: the Copernicus tile
 * on the server, or 0 m for a sea cell. Leaves an index alone otherwise; those go
 * to ASTER afterwards. Returns the terrain files that would have answered had
 * they been in the folder.
 */
async function lookUpCells(points, indices, results, network) {
    const cells = new Map();    // "<lat>_<lon>" -> { cell, indices }
    for (const index of indices) {
        const cell = cellOf(Number(points[index].lat), Number(points[index].lon));
        const key = cell.lat + '_' + cell.lon;
        if (!cells.has(key)) cells.set(key, { cell, indices: [] });
        cells.get(key).indices.push(index);
    }

    const wanted = [];
    const canBuild = isLocalTerrainActive() && io.canBuild();
    for (const { cell, indices: inCell } of cells.values()) {
        if (cell.lat < -90 || cell.lat > 89 || cell.lon < -180 || cell.lon > 179) continue;
        const source = io.cellInfo(cell.lat, cell.lon).source;
        if (source === 'sea') {
            for (const index of inCell) {
                results[index] = { elevation: 0, source: ElevationSource.COPERNICUS };
            }
        }
        if (!network) continue;
        // A file that is there but has no block for these points is not built again.
        if (canBuild && !io.buildPending(cell.lat, cell.lon) &&
            tileExists.get(terrainDatFilename(cell.lat, cell.lon)) !== true) {
            wanted.push(tileInfo(cell));
        }
        if (source === 'copernicus') {
            const heights = await Promise.all(inCell.map(index =>
                sampler.copernicusPoint(Number(points[index].lat), Number(points[index].lon))));
            inCell.forEach((index, n) => {
                if (heights[n] !== null) results[index] = { elevation: heights[n], source: ElevationSource.COPERNICUS };
            });
        }
    }
    return wanted;
}

function handleWantedTiles(wanted) {
    if (wanted.length === 0) return;
    if (tileDownload === TileDownload.ALWAYS) {
        const fresh = wanted.filter(tile => !askedTiles.has(tile.key));
        if (fresh.length) {
            // Asked once per session: a file that failed to build is not retried on every lookup.
            buildTiles(fresh).catch(error => console.log('Terrain build failed: ' + (error?.message || error)));
        }
        return;
    }
    if (tileDownload !== TileDownload.ASK || !tileWantedListener) return;
    const fresh = wanted.filter(tile => !askedTiles.has(tile.key));
    if (fresh.length === 0) return;
    for (const tile of fresh) {
        askedTiles.add(tile.key);
    }
    try {
        tileWantedListener(fresh);
    } catch (error) {
        console.log('Tile listener failed: ' + error.message);
    }
}

/*
 * Elevation of each point in metres above sea level.
 *
 * points: [{ lat, lon }] in degrees. When more than `onlineLimit` of them need
 * ASTER, only that many (evenly spread, first and last included) are asked for
 * and the others are interpolated by position in the list - so pass the points in
 * path order. `online: false` never goes to the network: only the terrain folder
 * answers (and sea cells, which need no request).
 *
 * Returns [{ elevation: number | null, source, file?, coarse? }], one entry per
 * point; file names the terrain file an answer was read from, coarse marks an
 * interpolated answer.
 */
export async function getElevations(points, { online = true, onlineLimit = DEFAULT_ONLINE_LIMIT } = {}) {
    const heights = new Array(points.length);
    const files = new Array(points.length);
    if (isLocalTerrainActive()) {
        await lookUpLocal(points, heights, files);
    }

    const results = points.map((_, i) => (heights[i] === undefined
        ? { elevation: null, source: ElevationSource.NONE }
        : { elevation: Math.round(heights[i] * 10) / 10, source: ElevationSource.TER, file: files[i] }));

    const unanswered = () => {
        const list = [];
        results.forEach((result, i) => {
            if (result.source === ElevationSource.NONE && Number.isFinite(Number(points[i].lat)) && Number.isFinite(Number(points[i].lon))) {
                list.push(i);
            }
        });
        return list;
    };

    let missing = unanswered();
    if (missing.length === 0) {
        return results;
    }

    const wanted = await lookUpCells(points, missing, results, online);
    if (!online) {
        return results;
    }
    handleWantedTiles(wanted);

    missing = unanswered();
    if (missing.length) {
        await lookUpAster(points, missing, Math.max(2, Math.floor(onlineLimit)), results);
    }
    return results;
}

/* Elevation of one point: { elevation: number | null, source, file?, coarse? }. */
export async function getElevation(lat, lon, options) {
    const [result] = await getElevations([{ lat, lon }], options);
    return result;
}

/*
 * Summary of where a set of answers came from, for a label next to the numbers:
 * overall is the one source they share, 'mixed' when there is more than one (or
 * terrain files with gaps), 'none' when nothing answered.
 */
export function summariseSources(results) {
    const counts = {};
    for (const source of Object.values(ElevationSource)) {
        counts[source] = 0;
    }
    let coarse = false;
    for (const result of results) {
        counts[result.source] = (counts[result.source] || 0) + 1;
        if (result.coarse) coarse = true;
    }
    const used = Object.keys(counts).filter(source => source !== ElevationSource.NONE && counts[source] > 0);
    let overall = ElevationSource.NONE;
    if (used.length > 1 || (used[0] === ElevationSource.TER && counts[ElevationSource.NONE] > 0)) {
        overall = 'mixed';
    } else if (used.length === 1) {
        overall = used[0];
    }
    return { overall, counts, coarse };
}
