// Elevation sources for terrain files (.TER): Copernicus GLO-30 (Cloud-Optimized
// GeoTIFF) and NASA SRTM (.hgt.gz from the AWS "skadi" bucket). Both are turned
// into the same 3601x3601 big-endian int16 grid per 1° cell, which
// createDatFromHgt() converts into a .TER file. js/terrain_build.js picks the
// source per cell and drives this.
//
// DOM-free. Everything is downloaded into memory and nothing is kept: the only
// thing written to disk is the finished .TER, by js/terrain_library.js. The
// loaders take an `io` object, every member optional:
//   io.hasFile(source, lat, lon) -> true | false | null
//                                                 bundled cell index; false = the source
//                                                 has no file for that cell (sea)
//   io.signal    AbortSignal                      stops the downloads of a build
// Network access uses globalThis.fetch (geotiff's range reads use it too).

import { fromUrl, fromArrayBuffer } from 'geotiff';
import {
    TERRAIN_SPACING, TERRAIN_BLK_SPACE_X, TERRAIN_IO_BLOCK,
    addOffset, eastBlocks, buildTerBlock, terrainPackerSelfTest
} from './terrain_ter.js';

// A cell that has data (per the index or the server) could not be downloaded.
// The build of that file must stop: carrying on would write a .TER that claims
// sea level where there is land.
export class MissingElevationError extends Error {
    constructor(cellName, cause) {
        super(`${cellName} needs elevation data that could not be downloaded` +
            (cause?.message ? ` (${cause.message})` : ''));
        this.name = 'MissingElevationError';
        this.cellName = cellName;
        this.cause = cause;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

// ─── Elevation grid → .TER conversion engine ──────────────────────────────────
export const SRTM_BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
export const SRTM_GRID = 3601;
export const HGT_GRID_BYTES = SRTM_GRID * SRTM_GRID * 2;

export function makeHgtView(hgtData) {
    const hgtBuf = (hgtData.buffer && hgtData.buffer.byteLength === hgtData.length)
        ? hgtData.buffer : hgtData.buffer.slice(hgtData.byteOffset, hgtData.byteOffset + hgtData.byteLength);
    return new DataView(hgtBuf);
}

export function hgtElevation(hgtCache, degLat, degLon, lat, lon) {
    let tileLat = Math.floor(lat);
    let tileLon = Math.floor(lon);
    let key = tileLat + '_' + tileLon;
    let hgtView = hgtCache[key];
    if (!hgtView) {
        key = degLat + '_' + degLon;
        hgtView = hgtCache[key];
        if (!hgtView) return 0;
        tileLat = degLat;
        tileLon = degLon;
    }
    const fracLat = Math.max(0, Math.min(1, lat - tileLat));
    const fracLon = Math.max(0, Math.min(1, lon - tileLon));
    const rowF = (1 - fracLat) * 3600;
    const colF = fracLon * 3600;
    const r0 = Math.max(0, Math.min(3599, Math.floor(rowF)));
    const c0 = Math.max(0, Math.min(3599, Math.floor(colF)));
    const r1 = Math.min(3600, r0 + 1);
    const c1 = Math.min(3600, c0 + 1);
    const dr = Math.max(0, Math.min(1, rowF - r0));
    const dc = Math.max(0, Math.min(1, colF - c0));
    function getH(r, c) {
        const v = hgtView.getInt16((r * SRTM_GRID + c) * 2, false);
        return v === -32768 ? 0 : v;
    }
    const alt = Math.trunc(
        getH(r0, c0) * (1 - dr) * (1 - dc) +
        getH(r0, c1) * (1 - dr) * dc +
        getH(r1, c0) * dr * (1 - dc) +
        getH(r1, c1) * dr * dc
    );
    return alt < 0 ? 0 : alt;
}

export function srtmTileName(lat, lon) {
    const lp = lat >= 0 ? 'N' : 'S';
    const lnp = lon >= 0 ? 'E' : 'W';
    return lp + String(Math.abs(lat)).padStart(2, '0') + lnp + String(Math.abs(lon)).padStart(3, '0');
}

export function srtmUrl(lat, lon) {
    const name = srtmTileName(lat, lon);
    return SRTM_BASE_URL + '/' + name.substring(0, 3) + '/' + name + '.hgt.gz';
}

export function estimateDatSizeMB(lat) {
    const baseLat = Math.floor(Math.abs(lat)) * (lat >= 0 ? 1 : -1) * 10000000;
    const baseLon = 0;
    let numX = 0;
    while (addOffset(baseLat, baseLon, numX * TERRAIN_BLK_SPACE_X * TERRAIN_SPACING, 0)[0] * 1e-7 - baseLat * 1e-7 < 1.0) numX++;
    const numY = eastBlocks(baseLat, baseLon);
    return (numX * numY * TERRAIN_IO_BLOCK) / 1048576;
}

export async function createDatFromHgt(degLat, degLon, hgtCache, progressCb) {
    terrainPackerSelfTest();
    const baseLat = degLat * 10000000;
    const baseLon = degLon * 10000000;
    let numX = 0;
    while (addOffset(baseLat, baseLon, numX * TERRAIN_BLK_SPACE_X * TERRAIN_SPACING, 0)[0] * 1e-7 - degLat < 1.0) numX++;
    const numY = eastBlocks(baseLat, baseLon);
    const totalBlocks = numX * numY;
    const output = new Uint8Array(totalBlocks * TERRAIN_IO_BLOCK);
    let blockNum = 0;
    for (let ix = 0; ix < numX; ix++) {
        for (let iy = 0; iy < numY; iy++) {
            const block = buildTerBlock(degLat, degLon, ix, iy,
                (lat, lon) => hgtElevation(hgtCache, degLat, degLon, lat, lon));
            output.set(block, blockNum * TERRAIN_IO_BLOCK);
            blockNum++;
            if (blockNum % 200 === 0) {
                if (progressCb) progressCb(blockNum, totalBlocks);
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }
    if (progressCb) progressCb(totalBlocks, totalBlocks);
    return output;
}

export async function decompressGz(arrayBuffer) {
    const ds = new DecompressionStream('gzip');
    const blob = new Blob([arrayBuffer]);
    const decompressed = blob.stream().pipeThrough(ds);
    const reader = decompressed.getReader();
    const chunks = [];
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const data = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) { data.set(chunk, off); off += chunk.length; }
    return data;
}

// One SRTM grid, from memory or the server. Returns null for a cell with no
// file (sea): the index says so, or the server answers 404. Throws
// MissingElevationError when the data exists but can't be downloaded.
async function loadSrtmGrid(lat, lon, runCache, io, statusCb) {
    const key = lat + '_' + lon;
    if (Object.hasOwn(runCache, key)) return runCache[key];
    const name = srtmTileName(lat, lon);

    if (io?.hasFile && io.hasFile('srtm', lat, lon) === false) {
        runCache[key] = null;
        return null;
    }

    if (statusCb) statusCb('connecting');
    let gz;
    try {
        const resp = await fetch(srtmUrl(lat, lon), { signal: io?.signal });
        if (resp.status === 404) {
            runCache[key] = null;
            return null;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        if (statusCb) statusCb('downloading');
        gz = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
        if (isAbort(e)) throw e;
        throw new MissingElevationError(name, e);
    }
    if (statusCb) statusCb('decompressing');
    const hgtData = await decompressGz(gz);
    runCache[key] = makeHgtView(hgtData);
    if (statusCb) statusCb('downloaded', hgtData.length);
    return runCache[key];
}

// Grids createDatFromHgt() needs for one SRTM cell: the cell itself plus its
// E, N and NE neighbours (the .TER block grid overshoots the cell to the north
// and east). They are stored in runCache, which is also what gets passed to
// createDatFromHgt(). A cell or neighbour with no file is sea and is left out.
export async function ensureSrtmCellData(degLat, degLon, runCache, io, statusCb) {
    await loadSrtmGrid(degLat, degLon, runCache, io, statusCb);
    for (const [nLat, nLon] of [[degLat, degLon + 1], [degLat + 1, degLon], [degLat + 1, degLon + 1]]) {
        if (nLat > 89) continue;
        await loadSrtmGrid(nLat, wrapLon(nLon), runCache, io, null);
    }
    return runCache;
}

function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

// ─── Copernicus GLO-30 → HGT-shaped grid ───────────────────────────────
// Copernicus tiles are 1°x1° Cloud-Optimized GeoTIFF (Float32, pixel-is-point,
// always 3600 rows tall). Below 50° latitude they are also 3600 px wide and
// their sample points fall on exactly the same whole arc-second graticule as
// SRTM .hgt, so filling the 3601x3601 grid that hgtElevation()/
// createDatFromHgt() expect is a direct copy. Towards the poles the tiles get
// NARROWER (2400 px at 50–60°, 1800 at 60–70°, 1200 at 70–80°, 720 at 80–85°,
// 360 at 85–90°, mirrored south of the equator), so there the grid columns map
// onto the tile's real width via copernicusColPlan(). The 3601st row/column
// (the tile's south and east edges) belong to the south / east neighbour
// tiles and are copied from them.
export const COPERNICUS_BASE_URL = 'https://copernicus-dem-30m.s3.amazonaws.com';
// Required verbatim by the Copernicus WorldDEM-30 licence (Art. 6). These must
// be reproduced character-for-character wherever the derived .TER files are
// presented or shipped, and imply no endorsement by any of the named parties.
export const COPERNICUS_NOTICE_1 = 'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';
export const COPERNICUS_NOTICE_2 = 'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30';
export const TERRAIN_ATTR_SRTM = 'Elevation data: <a href="https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1">NASA SRTM</a>';
export const TERRAIN_ATTR_COPERNICUS = 'Elevation data: <a href="https://registry.opendata.aws/copernicus-dem/">Copernicus WorldDEM-30</a>';
// Kept next to the terrain files (NOTICE.TXT in the terrain folder) and shipped
// inside the exported ZIP. The WorldDEM-30 licence (Art. 6) ties the notices to
// distribution / communication to the public, so they travel with the files a
// user can pass on.
export function copernicusNoticeText() {
    return 'INAV Terrain elevation data — attribution notice\r\n\r\n' +
        'Elevation source: Copernicus WorldDEM-30 (GLO-30), 30 m\r\n' +
        'https://registry.opendata.aws/copernicus-dem/\r\n\r\n' +
        COPERNICUS_NOTICE_1 + '\r\n\r\n' +
        COPERNICUS_NOTICE_2 + '\r\n\r\n' +
        'This product is not endorsed by or affiliated with the European Union, ESA,\r\n' +
        'Airbus Defence and Space GmbH or DLR e.V.\r\n\r\n' +
        'Elevation data is provided "as is", without any warranty.\r\n' +
        'Always verify terrain clearance before flight.\r\n';
}

export const COPERNICUS_GRID = 3600;
const COPERNICUS_ROW_BAND = 600;      // rows decoded per step, to cap peak memory
const COPERNICUS_MAX_RETRIES = 2;
const REMOTE_READ_CACHE = { blockSize: 65536, cacheSize: 256 };   // up to 16 MB per open tile

// Sampling plan for mapping 3600-grid columns [colFrom..colTo] onto a tile
// that is `width` px wide: each grid column sits at source position
// col*width/3600 and is interpolated linearly between the two neighbouring
// sample columns. The weight is exactly 0 when width == 3600 (below 50°
// latitude), where the plan degenerates to a direct column copy.
export function copernicusColPlan(colFrom, colTo, width) {
    const n = colTo - colFrom + 1;
    const left = new Int32Array(n);       // left sample column, relative to srcFrom
    const right = new Int32Array(n);      // right sample column, relative to srcFrom
    const weight = new Float64Array(n);   // share of the right sample
    const srcFrom = Math.floor(colFrom * width / COPERNICUS_GRID);
    let srcTo = srcFrom;
    for (let k = 0; k < n; k++) {
        const x = (colFrom + k) * width / COPERNICUS_GRID;
        const a = Math.floor(x);
        const b = Math.min(width - 1, a + 1);
        left[k] = a - srcFrom;
        right[k] = b - srcFrom;
        weight[k] = x - a;
        if (b > srcTo) srcTo = b;
    }
    return { srcFrom, srcTo, left, right, weight };
}

// Interpolates one value from a raster row slice using a copernicusColPlan
// entry. The weight-0 shortcut keeps width-3600 output bit-exact. A
// non-finite (void) sample must not bleed into its valid neighbour through
// the interpolation, so it stays local: the nearer pixel wins, matching how
// copernicusToInt16() treats a void on the direct-copy path.
function copernicusSample(data, base, plan, k) {
    const a = data[base + plan.left[k]];
    const w = plan.weight[k];
    if (w === 0) return a;
    const b = data[base + plan.right[k]];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return w < 0.5 ? a : b;
    return a + (b - a) * w;
}

export function copernicusTileStem(lat, lon) {
    const ns = (lat >= 0 ? 'N' : 'S') + String(Math.abs(lat)).padStart(2, '0');
    const ew = (lon >= 0 ? 'E' : 'W') + String(Math.abs(lon)).padStart(3, '0');
    return `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
}

export function copernicusUrl(lat, lon) {
    const stem = copernicusTileStem(lat, lon);
    return `${COPERNICUS_BASE_URL}/${stem}/${stem}.tif`;
}

// Polite retry: back off on transient errors (503 throttling), give up on 404
// (a tile that simply does not exist — ocean or outside coverage).
async function copernicusRetry(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt <= COPERNICUS_MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(500 * (attempt + 1));
        try {
            return await fn();
        } catch (e) {
            if (e?.notFound || isAbort(e)) throw e;
            lastErr = e;
        }
    }
    throw lastErr || new Error('Copernicus request failed');
}

// Opens one Copernicus tile. `full` downloads the whole GeoTIFF in a single
// request (used for the cell being built); without it the file is read remotely
// with HTTP range requests, so a thin neighbour strip only pulls the blocks it
// touches. A tile already downloaded whole in this run (imgCache) is reused for
// either. Returns null when the tile does not exist.
async function openCopernicusImage(lat, lon, imgCache, full, statusCb, io) {
    const key = lat + '_' + lon;
    if (Object.hasOwn(imgCache, key) && (imgCache[key] === null || imgCache[key].full || !full)) {
        return imgCache[key] ? imgCache[key].image : null;
    }
    if (io?.hasFile && io.hasFile('copernicus', lat, lon) === false) {
        imgCache[key] = null;
        return null;
    }
    try {
        const entry = await copernicusRetry(async () => {
            if (full) {
                if (statusCb) statusCb('downloading');
                const resp = await fetch(copernicusUrl(lat, lon), { signal: io?.signal });
                if (resp.status === 404) {           // no file = square is entirely sea
                    const err = new Error('HTTP 404');
                    err.notFound = true;
                    throw err;
                }
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const buf = await resp.arrayBuffer();
                if (statusCb) statusCb('decoding', buf.byteLength);
                const tiff = await fromArrayBuffer(buf);
                return { image: await tiff.getImage(), full: true };
            }
            try {
                // Without a block size geotiff keeps nothing: every strip read
                // fetches its blocks again (measured: 28.6 MB for one east strip,
                // 8.7 MB with the cache).
                const tiff = await fromUrl(copernicusUrl(lat, lon), REMOTE_READ_CACHE, io?.signal);
                return { image: await tiff.getImage(), full: false };
            } catch (e) {
                if (isAbort(e)) throw e;
                // geotiff throws a generic error with no status. Confirm with a
                // HEAD: this bucket returns 404 for 1° squares that are entirely
                // sea (no file) — that is "no data", so the edge stays at sea
                // level. A 403 or anything else is a real access/network problem
                // and must surface, not be silently zeroed into the terrain.
                const head = await fetch(copernicusUrl(lat, lon), { method: 'HEAD' });
                if (head.status === 404) {
                    const err = new Error('HTTP 404');
                    err.notFound = true;
                    throw err;
                }
                throw e;
            }
        });
        imgCache[key] = entry;
        return entry.image;
    } catch (e) {
        // Missing tile is "no data", not a failure — but a network/server
        // problem must surface: the file is not built.
        if (isAbort(e)) throw e;
        if (!e?.notFound) throw new MissingElevationError(copernicusTileStem(lat, lon), e);
        imgCache[key] = null;
        return null;
    }
}

function copernicusToInt16(v) {
    if (!Number.isFinite(v)) return 0;              // void → sea level, as the SRTM path does
    const r = Math.round(v);
    if (r > 32767) return 32767;
    if (r < -32767) return -32767;                  // keep -32768 reserved as the .hgt void marker
    return r;
}

// East edge (grid column 3600) is the west column of the east neighbour.
async function copernicusFillEastEdge(degLat, degLon, rowFrom, rowMainTo, imgCache, view, io) {
    const east = await openCopernicusImage(degLat, wrapLon(degLon + 1), imgCache, false, null, io);
    if (!east) return;
    const [col] = await east.readRasters({ window: [0, rowFrom, 1, rowMainTo + 1] });
    for (let r = rowFrom; r <= rowMainTo; r++) {
        view.setInt16((r * SRTM_GRID + COPERNICUS_GRID) * 2, copernicusToInt16(col[r - rowFrom]), false);
    }
}

// South edge (grid row 3600) is the north row of the south neighbour, which
// can sit in a different width band (e.g. N49 under an N50 tile), so its
// columns map through its OWN width. Also fills the SE corner when asked.
async function copernicusFillSouthEdge(degLat, degLon, colFrom, colMainTo, withCorner, imgCache, view, io) {
    const south = degLat > -90 ? await openCopernicusImage(degLat - 1, degLon, imgCache, false, null, io) : null;
    if (south) {
        const plan = copernicusColPlan(colFrom, colMainTo, south.getWidth());
        const [row] = await south.readRasters({ window: [plan.srcFrom, 0, plan.srcTo + 1, 1] });
        let off = (COPERNICUS_GRID * SRTM_GRID + colFrom) * 2;
        for (let k = 0; k < plan.left.length; k++) {
            view.setInt16(off, copernicusToInt16(copernicusSample(row, 0, plan, k)), false);
            off += 2;
        }
    }
    if (withCorner && degLat > -90) {
        const southEast = await openCopernicusImage(degLat - 1, wrapLon(degLon + 1), imgCache, false, null, io);
        if (southEast) {
            const [px] = await southEast.readRasters({ window: [0, 0, 1, 1] });
            view.setInt16((COPERNICUS_GRID * SRTM_GRID + COPERNICUS_GRID) * 2, copernicusToInt16(px[0]), false);
        }
    }
}

// Fills rows [rowFrom..rowTo] x cols [colFrom..colTo] of a 3601x3601
// big-endian int16 grid for the 1° cell (degLat, degLon). Returns null if the
// cell's own Copernicus tile does not exist.
export async function buildCopernicusGrid(degLat, degLon, rowFrom, rowTo, colFrom, colTo, imgCache, opts) {
    const options = opts || {};
    const statusCb = options.statusCb;
    const io = options.io;
    const primary = await openCopernicusImage(degLat, degLon, imgCache, !!options.full, statusCb, io);
    if (!primary) return null;
    const primaryWidth = primary.getWidth();
    if (primary.getHeight() !== COPERNICUS_GRID) {
        throw new Error('Unexpected Copernicus tile height ' + primary.getHeight() +
            ' for ' + copernicusTileStem(degLat, degLon));
    }

    const bytes = new Uint8Array(HGT_GRID_BYTES);
    const view = new DataView(bytes.buffer);

    const rowMainTo = Math.min(rowTo, COPERNICUS_GRID - 1);
    const colMainTo = Math.min(colTo, COPERNICUS_GRID - 1);
    const bandTotal = Math.max(1, rowMainTo - rowFrom + 1);

    // Body: grid row r == tile pixel row r; grid columns sample the tile at
    // their true positions via copernicusColPlan() — reading past the tile's
    // real width would make geotiff.js silently zero-fill instead of failing.
    const plan = copernicusColPlan(colFrom, colMainTo, primaryWidth);
    const srcWidth = plan.srcTo - plan.srcFrom + 1;
    for (let bandTop = rowFrom; bandTop <= rowMainTo; bandTop += COPERNICUS_ROW_BAND) {
        const bandBottom = Math.min(rowMainTo, bandTop + COPERNICUS_ROW_BAND - 1);
        const [band] = await primary.readRasters({
            window: [plan.srcFrom, bandTop, plan.srcTo + 1, bandBottom + 1],
        });
        for (let r = bandTop; r <= bandBottom; r++) {
            const src = (r - bandTop) * srcWidth;
            let off = (r * SRTM_GRID + colFrom) * 2;
            for (let k = 0; k < plan.left.length; k++) {
                view.setInt16(off, copernicusToInt16(copernicusSample(band, src, plan, k)), false);
                off += 2;
            }
        }
        if (statusCb) statusCb('grid', bandBottom - rowFrom + 1, bandTotal);
        await new Promise(r => setTimeout(r, 0));
    }

    if (colTo >= COPERNICUS_GRID) {
        await copernicusFillEastEdge(degLat, degLon, rowFrom, rowMainTo, imgCache, view, io);
    }
    if (rowTo >= COPERNICUS_GRID) {
        await copernicusFillSouthEdge(degLat, degLon, colFrom, colMainTo, colTo >= COPERNICUS_GRID, imgCache, view, io);
    }

    return view;
}

// The .TER block grid starts at the cell's south-west corner and walks north
// and east, overshooting the 1° square (~370 m north, ~2 km east at 42°N), so
// the north / east / north-east neighbours must supply the samples past the
// edge. Only that thin margin is needed, not the whole neighbour tile.
function copernicusNorthMarginRows() {
    return Math.ceil((1200 / 111320) * COPERNICUS_GRID) + 2;
}

function copernicusEastMarginCols(degLat) {
    const cos = Math.max(0.05, Math.cos((degLat + 0.5) * Math.PI / 180));
    return Math.ceil((2500 / (111320 * cos)) * COPERNICUS_GRID) + 2;
}

// Returns the tile cache createDatFromHgt() needs for one 1° cell: a full grid
// for the cell itself plus N/E/NE edge data. A neighbour comes from runCache as
// a full grid when one is there; otherwise only its strip is built (by range
// reads, or from a tile imgCache holds whole). Partial strips live in a per-cell
// object and are never written to runCache — a strip sits in a zero-filled
// full-size buffer, so reusing one as a complete grid would look like an ocean
// tile.
export async function ensureCopernicusCellData(degLat, degLon, runCache, imgCache, statusCb, io) {
    const primaryKey = degLat + '_' + degLon;

    const cellCache = {};
    if (runCache[primaryKey]) cellCache[primaryKey] = runCache[primaryKey];

    if (!cellCache[primaryKey]) {
        const grid = await buildCopernicusGrid(degLat, degLon, 0, COPERNICUS_GRID, 0, COPERNICUS_GRID,
            imgCache, { full: true, statusCb, io });
        if (!grid) return null;
        runCache[primaryKey] = grid;
        cellCache[primaryKey] = grid;
    }

    const rowStart = COPERNICUS_GRID - copernicusNorthMarginRows();
    const colEnd = Math.min(COPERNICUS_GRID, copernicusEastMarginCols(degLat));
    const eastLon = wrapLon(degLon + 1);
    const neighbors = [
        { lat: degLat, lon: eastLon, rowFrom: 0, rowTo: COPERNICUS_GRID, colFrom: 0, colTo: colEnd },
        { lat: degLat + 1, lon: degLon, rowFrom: rowStart, rowTo: COPERNICUS_GRID, colFrom: 0, colTo: COPERNICUS_GRID },
        { lat: degLat + 1, lon: eastLon, rowFrom: rowStart, rowTo: COPERNICUS_GRID, colFrom: 0, colTo: colEnd },
    ];
    for (const nb of neighbors) {
        if (nb.lat > 89) continue;
        const key = nb.lat + '_' + nb.lon;
        if (runCache[key]) { cellCache[key] = runCache[key]; continue; }
        if (statusCb) statusCb('edges');
        const strip = await buildCopernicusGrid(nb.lat, nb.lon, nb.rowFrom, nb.rowTo, nb.colFrom, nb.colTo,
            imgCache, { full: false, io });
        if (strip) cellCache[key] = strip;   // per-cell only — never cached as a full grid
    }

    return cellCache;
}
