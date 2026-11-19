'use strict';

/*
 * Ground elevation for the mission planner.
 *
 * Two sources, tried in this order for every point:
 *   1. a folder of INAV terrain tiles (.TER), read the way the firmware reads
 *      them (js/terrain_ter.js), so the planner sees the ground the flight
 *      controller will see;
 *   2. the online lookup the planner has always used (opentopodata, ASTER 30 m),
 *      for points the folder has no tile for, or when no folder is chosen.
 *
 * Every answer says which source it came from. The module has no DOM and no
 * direct file access: file reads and the online fetch are injected, with
 * defaults that use the Electron bridge and js/elevationFetch.js.
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

export const ElevationSource = Object.freeze({
    TER: 'ter',                     // local terrain tile
    ONLINE: 'online',               // online lookup at this exact point
    ONLINE_COARSE: 'online-coarse', // interpolated between online lookups (too many points to ask for each)
    NONE: 'none'                    // no data from either source
});

const ONLINE_URL = 'https://api.opentopodata.org/v1/aster30m?locations=';
const ONLINE_BATCH = 100;           // opentopodata accepts at most 100 locations per request
const DEFAULT_ONLINE_LIMIT = 100;   // one request (they are spaced 1.1 s apart) per call unless the caller allows more
const BLOCK_CACHE_LIMIT = 4000;     // decoded blocks kept in memory (about 1.2 kB each)
const ONLINE_CACHE_LIMIT = 5000;

let io = defaultIo();
let terFolder = null;
const blockCache = new Map();       // "<tile>:<offset>" -> decoded block, or null when the slot holds no usable block
const tileExists = new Map();       // tile name -> boolean
const onlineCache = new Map();      // "lat,lon" (5 decimals) -> metres or null
const tilesUsed = new Set();
const tilesMissing = new Set();

function defaultIo() {
    return {
        readFileRanges: (path, ranges) => globalThis.electronAPI.readFileRanges(path, ranges),
        pathExists: (path) => globalThis.electronAPI.pathExists(path),
        fetchOnline: (url) => elevationFetch(url),
        localAvailable: () => typeof globalThis.electronAPI?.readFileRanges === 'function'
    };
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
}

/* Folder holding the .TER tiles (an SD card root or a copy of one), or null for online only. */
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

function onlineKey(point) {
    return Number(point.lat).toFixed(5) + ',' + Number(point.lon).toFixed(5);
}

/* Asks the online source for each point (batched); returns metres or null per point. */
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
            const response = await io.fetchOnline(ONLINE_URL + batch.map(entry => entry.key).join('|'));
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
 * Elevation of each point in metres above sea level.
 *
 * points: [{ lat, lon }] in degrees. When more than `onlineLimit` of them need
 * the online source, only that many (evenly spread, first and last included)
 * are asked for and the others are interpolated by position in the list - so
 * pass the points in path order. `online: false` never goes to the network.
 *
 * Returns [{ elevation: number | null, source }], one entry per point.
 */
export async function getElevations(points, { online = true, onlineLimit = DEFAULT_ONLINE_LIMIT } = {}) {
    const heights = new Array(points.length);
    if (isLocalTerrainActive()) {
        await lookUpLocal(points, heights);
    }

    const results = points.map((_, i) => (heights[i] === undefined
        ? { elevation: null, source: ElevationSource.NONE }
        : { elevation: Math.round(heights[i] * 10) / 10, source: ElevationSource.TER }));

    const missing = [];
    results.forEach((result, i) => {
        if (result.source === ElevationSource.NONE && Number.isFinite(Number(points[i].lat)) && Number.isFinite(Number(points[i].lon))) {
            missing.push(i);
        }
    });
    if (!online || missing.length === 0) {
        return results;
    }

    const limit = Math.max(2, Math.floor(onlineLimit));
    if (missing.length <= limit) {
        const answers = await fetchOnlineBatch(missing.map(i => points[i]));
        missing.forEach((index, n) => {
            if (answers[n] !== null) {
                results[index] = { elevation: answers[n], source: ElevationSource.ONLINE };
            }
        });
        return results;
    }

    // Too many points for the rate-limited online source: ask for `limit` of
    // them and fill the gaps in between by straight-line interpolation.
    const picked = [];
    for (let n = 0; n < limit; n++) {
        picked.push(Math.round(n * (missing.length - 1) / (limit - 1)));
    }
    const answers = await fetchOnlineBatch(picked.map(n => points[missing[n]]));
    let left = -1;
    for (let p = 0; p < picked.length; p++) {
        if (answers[p] === null) continue;
        results[missing[picked[p]]] = { elevation: answers[p], source: ElevationSource.ONLINE };
        if (left >= 0) {
            const from = picked[left];
            const to = picked[p];
            for (let n = from + 1; n < to; n++) {
                const t = (n - from) / (to - from);
                results[missing[n]] = {
                    elevation: Math.round((answers[left] + t * (answers[p] - answers[left])) * 10) / 10,
                    source: ElevationSource.ONLINE_COARSE
                };
            }
        }
        left = p;
    }
    return results;
}

/* Elevation of one point: { elevation: number | null, source }. */
export async function getElevation(lat, lon, options) {
    const [result] = await getElevations([{ lat, lon }], options);
    return result;
}

/* Summary of where a set of answers came from, for a label next to the numbers. */
export function summariseSources(results) {
    const counts = { [ElevationSource.TER]: 0, [ElevationSource.ONLINE]: 0, [ElevationSource.ONLINE_COARSE]: 0, [ElevationSource.NONE]: 0 };
    for (const result of results) {
        counts[result.source] = (counts[result.source] || 0) + 1;
    }
    const online = counts[ElevationSource.ONLINE] + counts[ElevationSource.ONLINE_COARSE];
    let overall = ElevationSource.NONE;
    if (counts[ElevationSource.TER] > 0 && online === 0 && counts[ElevationSource.NONE] === 0) {
        overall = ElevationSource.TER;
    } else if (counts[ElevationSource.TER] > 0) {
        overall = 'mixed';
    } else if (online > 0) {
        overall = counts[ElevationSource.ONLINE_COARSE] > 0 ? ElevationSource.ONLINE_COARSE : ElevationSource.ONLINE;
    }
    return { overall, counts };
}
