'use strict';

/*
 * Ground elevation for the mission planner.
 *
 * Sources, tried in this order for every point:
 *   1. a folder of INAV terrain tiles (.TER), read the way the firmware reads
 *      them (js/terrain_ter.js), so the planner sees the ground the flight
 *      controller will see;
 *   2. the source chosen in the planner's settings, for points the folder has
 *      no tile for, or when no folder is chosen:
 *        Copernicus GLO-30  the tile saved in the offline data folder, else the
 *                           tile on the server read with range requests;
 *        NASA SRTM          the tile saved in the offline data folder, else
 *                           opentopodata's srtm30m;
 *        ASTER              opentopodata's aster30m (what the planner always used);
 *   3. ASTER, for points the chosen source could not answer.
 *
 * A Copernicus or SRTM tile that is not in the offline folder can be downloaded
 * into it: the planner is told which tiles a lookup would have used
 * (setTileWantedListener) and answers with downloadTiles() or declineTiles().
 * Lookups never wait for that: they use the server until the file is there.
 *
 * Every answer says which source it came from. The module has no DOM and no
 * direct file access: file reads, downloads and the online fetch are injected,
 * with defaults that use the Electron bridge, js/offline_folder.js,
 * js/terrain_point.js and js/elevationFetch.js.
 */

import elevationFetch from './elevationFetch.js';
import {
    TERRAIN_IO_DATA,
    terBlockHeight,
    terBlockOffset,
    terDecodeBlock,
    terGridInfo,
    terTileName
} from './terrain_ter.js';
import { cellFileBytes, elevationFile } from './offline_regions.js';
import {
    offlineFolderAvailable,
    offlineFolderExists,
    offlineFolderPath,
    offlineFolderRead,
    offlineFolderReadSlices
} from './offline_folder.js';
import { copernicusLocalPath, decompressGz, makeHgtView, srtmLocalPath } from './terrain_elevation.js';
import { cellOf, createPointSampler, openCopernicusRemote, openCopernicusSlices } from './terrain_point.js';

export const ElevationSource = Object.freeze({
    TER: 'ter',                             // local terrain tile
    COPERNICUS: 'copernicus',               // Copernicus tile on the server (range read), or a sea cell
    COPERNICUS_SAVED: 'copernicus-saved',   // Copernicus tile in the offline folder
    SRTM_SAVED: 'srtm-saved',               // SRTM tile in the offline folder
    SRTM_ONLINE: 'srtm-online',             // opentopodata srtm30m
    ASTER: 'aster',                         // opentopodata aster30m, chosen
    ASTER_FALLBACK: 'aster-fallback',       // opentopodata aster30m, because the chosen source had no answer
    NONE: 'none'                            // no data from any source
});

/* What the planner uses for points the terrain folder does not cover. */
export const OnlineSource = Object.freeze({
    COPERNICUS: 'copernicus',
    SRTM: 'srtm',
    ASTER: 'aster'
});

/* What happens when a lookup would use a tile that is not in the offline folder. */
export const TileDownload = Object.freeze({
    ASK: 'ask',         // tell the listener, which asks the user
    ALWAYS: 'always',   // download it without asking
    NEVER: 'never'      // leave it; keep using the server
});

const OPENTOPO_URL = 'https://api.opentopodata.org/v1/';
const ONLINE_BATCH = 100;           // opentopodata accepts at most 100 locations per request
const DEFAULT_ONLINE_LIMIT = 100;   // one request (they are spaced 1.1 s apart) per call unless the caller allows more
const BLOCK_CACHE_LIMIT = 4000;     // decoded .TER blocks kept in memory (about 1.2 kB each)
const ONLINE_CACHE_LIMIT = 5000;
const REMOTE_RETRY_MS = 60000;      // after a Copernicus tile failed to open, leave the server alone this long
// Copernicus has a file for every cell with land, except a few countries it leaves
// out (Armenia, Azerbaijan). A cell without one is sea unless the SRTM file for it
// is this big: sea cells there are about 1 MB, the left-out land 7-13 MB.
const LAND_SRTM_BYTES = 2 * 1024 * 1024;

let io = defaultIo();
let terFolder = null;
let onlineSource = OnlineSource.COPERNICUS;
let tileDownload = TileDownload.ASK;
let tileWantedListener = null;
let sampler = makeSampler();
const blockCache = new Map();       // "<tile>:<offset>" -> decoded block, or null when the slot holds no usable block
const tileExists = new Map();       // .TER tile name -> boolean
const onlineCache = new Map();      // "<dataset>:lat,lon" (5 decimals) -> metres or null
const tilesUsed = new Set();
const tilesMissing = new Set();
const savedTiles = new Set();       // "<source>:<lat>_<lon>" known to be in the offline folder
const askedTiles = new Set();       // tiles the listener was told about, or the user declined, this session
const downloads = new Map();        // tile key -> promise of a running download
const remoteFailedAt = new Map();   // "<lat>_<lon>" -> time a Copernicus tile failed to open on the server

function defaultIo() {
    return {
        readFileRanges: (path, ranges) => globalThis.electronAPI.readFileRanges(path, ranges),
        pathExists: (path) => globalThis.electronAPI.pathExists(path),
        fetchOnline: (url) => elevationFetch(url),
        localAvailable: () => typeof globalThis.electronAPI?.readFileRanges === 'function',

        // The offline data folder and the elevation servers (js/terrain_point.js)
        offlineAvailable: () => offlineFolderAvailable(),
        savedExists: (relPath) => offlineFolderExists(relPath),
        openCopernicus: (where, lat, lon) => (where === 'saved'
            ? openCopernicusSlices(slices => offlineFolderReadSlices(copernicusLocalPath(lat, lon), slices))
            : openCopernicusRemote(lat, lon)),
        loadSrtmGrid: async (lat, lon) => {
            const gz = await offlineFolderRead(srtmLocalPath(lat, lon));
            return gz ? makeHgtView(await decompressGz(gz)) : null;
        },
        downloadFile: (url, relPath) => globalThis.electronAPI.downloadToFile(url, offlineFolderPath(relPath), { skipIfExists: true }),
        cellBytes: (source, lat, lon) => cellFileBytes(source, lat, lon),
        now: () => Date.now()
    };
}

function makeSampler() {
    return createPointSampler({
        openCopernicus: async (asked, lat, lon, neighbour) => {
            const key = lat + '_' + lon;
            // The tile next to the one a point is in is read from the folder when it
            // is there and from the server when not, wherever the point's own tile is.
            let where = asked;
            if (neighbour) {
                if (io.cellBytes(OnlineSource.COPERNICUS, lat, lon) <= 0) return null;
                where = (await tileIsSaved(OnlineSource.COPERNICUS, { lat, lon })) ? 'saved' : 'remote';
            }
            if (where === 'remote' && remoteFailedAt.has(key)) {
                if (io.now() - remoteFailedAt.get(key) < REMOTE_RETRY_MS) {
                    throw new Error('tile ' + key + ' failed to open a moment ago');
                }
                remoteFailedAt.delete(key);
            }
            try {
                return await io.openCopernicus(where, lat, lon);
            } catch (error) {
                if (where === 'remote') remoteFailedAt.set(key, io.now());
                throw error;
            }
        },
        loadSrtmGrid: (lat, lon) => io.loadSrtmGrid(lat, lon)
    });
}

/* Replace the file and network access (tests, other hosts). Omitted members keep their default. */
export function configureElevationProvider(overrides = {}) {
    io = { ...defaultIo(), ...overrides };
    if (overrides.readFileRanges && !overrides.localAvailable) {
        io.localAvailable = () => true;
    }
    resetElevationCaches();
}

export function resetElevationCaches() {
    blockCache.clear();
    tileExists.clear();
    onlineCache.clear();
    tilesUsed.clear();
    tilesMissing.clear();
    savedTiles.clear();
    askedTiles.clear();
    downloads.clear();
    remoteFailedAt.clear();
    sampler = makeSampler();
}

/* Folder holding the .TER tiles (an SD card root or a copy of one), or null for none. */
export function setTerFolder(folder) {
    const next = folder ? String(folder) : null;
    if (next !== terFolder) {
        terFolder = next;
        blockCache.clear();
        tileExists.clear();
        tilesUsed.clear();
        tilesMissing.clear();
    }
}

export function getTerFolder() {
    return terFolder;
}

/* True when a folder is chosen and this build can read files from it. */
export function isLocalTerrainActive() {
    return Boolean(terFolder) && io.localAvailable();
}

/* Which tiles the lookups so far found in the folder and which they did not. */
export function elevationSourceStatus() {
    return {
        folder: terFolder,
        localActive: isLocalTerrainActive(),
        tilesUsed: [...tilesUsed].sort(),
        tilesMissing: [...tilesMissing].sort()
    };
}

/* Source for points the terrain folder does not cover. An unknown value counts as Copernicus. */
export function setOnlineSource(source) {
    onlineSource = Object.values(OnlineSource).includes(source) ? source : OnlineSource.COPERNICUS;
}

export function getOnlineSource() {
    return onlineSource;
}

/* True for Copernicus and SRTM: read from their own tiles they have no request limit,
   so a path is sampled at the tiles' 30 m spacing. */
export function onlineSourceUsesTiles() {
    return onlineSource !== OnlineSource.ASTER;
}

/* An unknown value counts as "ask". */
export function setTileDownload(mode) {
    tileDownload = Object.values(TileDownload).includes(mode) ? mode : TileDownload.ASK;
}

export function getTileDownload() {
    return tileDownload;
}

/* True when this build has an offline data folder to keep tiles in. */
export function canSaveTiles() {
    return Boolean(io.offlineAvailable());
}

/*
 * listener(tiles) is called, at most once per tile per session, with the tiles a
 * lookup would have read from the offline folder had they been there:
 * [{ key, source, lat, lon, name, bytes }]. Only in "ask" mode. Null removes it.
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

/* Fills `heights[i]` for every point the folder has data for; leaves the rest undefined. */
async function lookUpLocal(points, heights) {
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
            if (height !== null) heights[index] = height;
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
                if (height !== null) heights[index] = height;
            }
        });
    }
}

// ─── Tiles in the offline folder ──────────────────────────────────────────────

function tileKey(source, cell) {
    return source + ':' + cell.lat + '_' + cell.lon;
}

function tileInfo(source, cell) {
    const file = elevationFile(source, cell.lat, cell.lon);
    return {
        key: tileKey(source, cell),
        source,
        lat: cell.lat,
        lon: cell.lon,
        name: file.name,
        bytes: io.cellBytes(source, cell.lat, cell.lon),
        url: file.url,
        path: file.path
    };
}

async function tileIsSaved(source, cell) {
    if (!io.offlineAvailable()) return false;
    const key = tileKey(source, cell);
    if (savedTiles.has(key)) return true;
    let exists = false;
    try {
        exists = Boolean(await io.savedExists(elevationFile(source, cell.lat, cell.lon).path));
    } catch (error) {
        exists = false;
    }
    if (exists) savedTiles.add(key);
    return exists;
}

function startDownload(tile) {
    if (downloads.has(tile.key)) return downloads.get(tile.key);
    const run = (async () => {
        try {
            const result = await io.downloadFile(tile.url, tile.path);
            const status = result ? result.status : 'error';
            const ok = status === 'exists' || (typeof status === 'number' && status >= 200 && status < 300);
            if (ok) {
                savedTiles.add(tile.key);
                sampler.forgetTile(tile.lat, tile.lon);
                return { tile, ok: true };
            }
            return { tile, ok: false, error: (result && result.error) || 'HTTP ' + status };
        } catch (error) {
            return { tile, ok: false, error: String(error?.message || error) };
        } finally {
            downloads.delete(tile.key);
        }
    })();
    downloads.set(tile.key, run);
    return run;
}

/*
 * Downloads tiles into the offline folder, one after the other. onProgress is
 * called before each one with { done, total, tile }. Resolves to
 * { downloaded: [tile], failed: [{ tile, error }] }. Lookups made after a tile
 * arrived read it from the folder.
 */
export async function downloadTiles(tiles, onProgress) {
    const downloaded = [];
    const failed = [];
    for (let n = 0; n < tiles.length; n++) {
        const tile = tiles[n].url ? tiles[n] : tileInfo(tiles[n].source, tiles[n]);
        askedTiles.add(tile.key);
        if (onProgress) onProgress({ done: n, total: tiles.length, tile });
        const result = await startDownload(tile);
        if (result.ok) {
            downloaded.push(tile);
        } else {
            failed.push({ tile, error: result.error });
        }
    }
    if (onProgress) onProgress({ done: tiles.length, total: tiles.length, tile: null });
    return { downloaded, failed };
}

/* The user does not want these tiles: they are not asked about again this session. */
export function declineTiles(tiles) {
    for (const tile of tiles) {
        askedTiles.add(tile.key || tileKey(tile.source, tile));
    }
}

/* The listener was told about these tiles but the user never got to answer (the
   question was withdrawn): a later lookup may ask about them again. */
export function forgetTileQuestions(tiles) {
    for (const tile of tiles) {
        askedTiles.delete(tile.key || tileKey(tile.source, tile));
    }
}

// ─── opentopodata ─────────────────────────────────────────────────────────────

function onlineKey(dataset, point) {
    return dataset + ':' + Number(point.lat).toFixed(5) + ',' + Number(point.lon).toFixed(5);
}

/* Asks opentopodata for each point (batched); returns metres or null per point. */
async function fetchOnlineBatch(dataset, points) {
    const answers = new Array(points.length).fill(null);
    const pending = [];
    points.forEach((point, i) => {
        const key = onlineKey(dataset, point);
        if (onlineCache.has(key)) {
            answers[i] = onlineCache.get(key);
        } else {
            pending.push({ i, key, location: key.slice(dataset.length + 1) });
        }
    });

    for (let start = 0; start < pending.length; start += ONLINE_BATCH) {
        const batch = pending.slice(start, start + ONLINE_BATCH);
        try {
            const response = await io.fetchOnline(OPENTOPO_URL + dataset + '?locations=' + batch.map(entry => entry.location).join('|'));
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
 * Fills results[index] for the given indices from one opentopodata dataset. When
 * there are more than `limit` of them, only that many (evenly spread, first and
 * last included) are asked for and the others are interpolated by position in the
 * list and marked coarse. Indices that got no answer keep what they had.
 */
async function lookUpOpenTopo(dataset, source, points, indices, limit, results) {
    if (indices.length === 0) return;
    if (indices.length <= limit) {
        const answers = await fetchOnlineBatch(dataset, indices.map(i => points[i]));
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
    const answers = await fetchOnlineBatch(dataset, picked.map(n => points[indices[n]]));
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

// ─── Copernicus and SRTM tiles ────────────────────────────────────────────────

/*
 * Fills results[index] from the chosen tile source where it can. Leaves an index
 * alone when the source has no answer for it; those go to ASTER afterwards.
 * Returns the tiles that would have been read from the offline folder had they
 * been there.
 */
async function lookUpTiles(source, points, indices, limit, results, network) {
    const cells = new Map();    // "<lat>_<lon>" -> { cell, indices }
    for (const index of indices) {
        const cell = cellOf(Number(points[index].lat), Number(points[index].lon));
        const key = cell.lat + '_' + cell.lon;
        if (!cells.has(key)) cells.set(key, { cell, indices: [] });
        cells.get(key).indices.push(index);
    }

    const wanted = [];
    const viaOpenTopo = [];
    for (const { cell, indices: inCell } of cells.values()) {
        if (io.cellBytes(source, cell.lat, cell.lon) <= 0) {
            // Copernicus only: no file. Sea reads 0 m; left-out land goes to ASTER.
            if (io.cellBytes('srtm', cell.lat, cell.lon) < LAND_SRTM_BYTES) {
                for (const index of inCell) {
                    results[index] = { elevation: 0, source: ElevationSource.COPERNICUS };
                }
            }
            continue;
        }

        if (await tileIsSaved(source, cell)) {
            const savedSource = source === OnlineSource.COPERNICUS ? ElevationSource.COPERNICUS_SAVED : ElevationSource.SRTM_SAVED;
            const heights = await Promise.all(inCell.map(index => (source === OnlineSource.COPERNICUS
                ? sampler.copernicusPoint('saved', Number(points[index].lat), Number(points[index].lon))
                : sampler.srtmPoint(Number(points[index].lat), Number(points[index].lon)))));
            inCell.forEach((index, n) => {
                if (heights[n] !== null) results[index] = { elevation: heights[n], source: savedSource };
            });
            continue;
        }

        if (!network) continue;
        if (io.offlineAvailable() && !downloads.has(tileKey(source, cell))) {
            wanted.push(tileInfo(source, cell));
        }
        if (source === OnlineSource.COPERNICUS) {
            const heights = await Promise.all(inCell.map(index =>
                sampler.copernicusPoint('remote', Number(points[index].lat), Number(points[index].lon))));
            inCell.forEach((index, n) => {
                if (heights[n] !== null) results[index] = { elevation: heights[n], source: ElevationSource.COPERNICUS };
            });
        } else {
            viaOpenTopo.push(...inCell);
        }
    }

    if (viaOpenTopo.length) {
        viaOpenTopo.sort((a, b) => a - b);      // back into path order for the interpolation
        await lookUpOpenTopo('srtm30m', ElevationSource.SRTM_ONLINE, points, viaOpenTopo, limit, results);
    }
    return wanted;
}

function handleWantedTiles(wanted) {
    if (wanted.length === 0) return;
    if (tileDownload === TileDownload.ALWAYS) {
        for (const tile of wanted) {
            startDownload(tile);
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
 * opentopodata, only that many (evenly spread, first and last included) are
 * asked for and the others are interpolated by position in the list - so pass
 * the points in path order. `online: false` never goes to the network: only the
 * terrain folder and tiles already in the offline folder answer.
 *
 * Returns [{ elevation: number | null, source, coarse? }], one entry per point;
 * coarse marks an interpolated answer.
 */
export async function getElevations(points, { online = true, onlineLimit = DEFAULT_ONLINE_LIMIT } = {}) {
    const heights = new Array(points.length);
    if (isLocalTerrainActive()) {
        await lookUpLocal(points, heights);
    }

    const results = points.map((_, i) => (heights[i] === undefined
        ? { elevation: null, source: ElevationSource.NONE }
        : { elevation: Math.round(heights[i] * 10) / 10, source: ElevationSource.TER }));

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
    const limit = Math.max(2, Math.floor(onlineLimit));

    if (onlineSource === OnlineSource.ASTER) {
        if (online) {
            await lookUpOpenTopo('aster30m', ElevationSource.ASTER, points, missing, limit, results);
        }
        return results;
    }

    const wanted = await lookUpTiles(onlineSource, points, missing, limit, results, online);
    if (!online) {
        return results;
    }
    handleWantedTiles(wanted);

    missing = unanswered();
    if (missing.length) {
        await lookUpOpenTopo('aster30m', ElevationSource.ASTER_FALLBACK, points, missing, limit, results);
    }
    return results;
}

/* Elevation of one point: { elevation: number | null, source, coarse? }. */
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
