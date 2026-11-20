// Builds the .TER file of one 1° cell, in memory. Nothing is read from or
// written to disk here, and the elevation data it downloads is not kept:
// js/terrain_library.js writes the result into the terrain folder.
//
// Source per cell (terSourceForCell in js/offline_regions.js): Copernicus
// GLO-30; NASA SRTM for the land Copernicus leaves out; a cell that is all sea
// gets a sea-level file with no download. DOM-free; tested by
// tests/terrain-build.test.mjs.

import { hasCellFile, terSourceForCell } from './offline_regions.js';
import { createDatFromHgt, ensureCopernicusCellData, ensureSrtmCellData } from './terrain_elevation.js';
import { terrainDatFilename } from './terrain_ter.js';

// Raise this whenever the bytes written for the same source data change (a fix
// to the sampling, the packing or the edge handling). The terrain folder's index
// records it per file, so files from an older generator can be told apart.
export const TER_GENERATOR_VERSION = 1;

export const TerSource = Object.freeze({
    COPERNICUS: 'copernicus',
    SRTM: 'srtm',
    SEA: 'sea'              // no source has land in the cell: all heights are 0
});

const KEEP_WHOLE_TILES = 3;     // downloaded Copernicus tiles kept for the next cells' edges (about 40 MB each)
const KEEP_OPEN_TILES = 6;      // tiles opened for range reads (up to 16 MB of cached blocks each)

function defaultDeps() {
    return {
        sourceForCell: terSourceForCell,
        ensureCopernicus: ensureCopernicusCellData,
        ensureSrtm: ensureSrtmCellData,
        createDat: createDatFromHgt
    };
}

/*
 * Drops the oldest entries of a Copernicus image cache (the imgCache passed to
 * buildCellTer), so a long run does not hold every tile it downloaded. Whole
 * tiles are worth keeping for a few cells: a cell's east, north and north-east
 * edges come from them without another request.
 */
export function pruneImageCache(imgCache, keepWhole = KEEP_WHOLE_TILES, keepOpen = KEEP_OPEN_TILES) {
    const whole = [];
    const open = [];
    for (const key of Object.keys(imgCache)) {
        const entry = imgCache[key];
        if (!entry) continue;                   // null: "no such tile", costs nothing
        (entry.full ? whole : open).push(key);
    }
    for (const key of whole.slice(0, Math.max(0, whole.length - keepWhole))) delete imgCache[key];
    for (const key of open.slice(0, Math.max(0, open.length - keepOpen))) delete imgCache[key];
}

/*
 * Builds one cell's .TER.
 *
 *   imgCache   object shared between the cells of a run (see pruneImageCache)
 *   onStage    (stage, done, total) => void; stages: 'downloading', 'decoding',
 *              'grid', 'edges', 'packing'. done/total only where they are known.
 *   signal     AbortSignal; an aborted build rejects with the signal's AbortError
 *
 * Resolves to { name, bytes, source }: the file name (N47E008.TER), its contents
 * and a TerSource. Rejects with MissingElevationError when data that exists
 * could not be downloaded: writing a file without it would claim sea level
 * where there is land.
 */
export async function buildCellTer(lat, lon, { imgCache = {}, onStage = null, signal = null, deps = {} } = {}) {
    const use = { ...defaultDeps(), ...deps };
    const stage = (name, done, total) => {
        if (signal) signal.throwIfAborted();
        if (onStage) onStage(name, done, total);
    };
    const io = { hasFile: (source, cLat, cLon) => hasCellFile(source, cLat, cLon), signal };
    const status = (name, done, total) => {
        // 'downloaded', 'cached' and the like are loader details: pass on the stages only
        if (name === 'downloading' || name === 'decoding' || name === 'grid' || name === 'edges') {
            stage(name, done, total);
        } else if (signal) {
            signal.throwIfAborted();
        }
    };

    if (signal) signal.throwIfAborted();
    let source = use.sourceForCell(lat, lon);
    let grids = {};
    if (source === TerSource.COPERNICUS) {
        grids = await use.ensureCopernicus(lat, lon, {}, imgCache, status, io);
        if (!grids) {               // the server has no tile after all: sea
            source = null;
            grids = {};
        }
    } else if (source === TerSource.SRTM) {
        grids = await use.ensureSrtm(lat, lon, {}, io, status);
    }
    if (!source) source = TerSource.SEA;

    if (signal) signal.throwIfAborted();
    const bytes = await use.createDat(lat, lon, grids, (done, total) => stage('packing', done, total));
    return { name: terrainDatFilename(lat, lon), bytes, source };
}
