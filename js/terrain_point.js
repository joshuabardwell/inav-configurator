'use strict';

/*
 * Ground height at single points, straight from the elevation sources the Map
 * Generator builds .TER files from (js/terrain_elevation.js): Copernicus GLO-30
 * GeoTIFF tiles and NASA SRTM .hgt grids. The mission planner uses this for
 * points its .TER folder has no tile for.
 *
 * The answers follow the Map Generator's arithmetic - the same 3600-step grid per
 * 1 degree cell, nodes rounded to whole metres, bilinear between four nodes, then
 * truncated and clamped at 0 - so the planner shows what a .TER generated from the
 * same source holds. That includes a Copernicus cell's south-most row and east-most
 * column of nodes, which are the first row and column of the neighbouring tiles: a
 * point within 30 m of those edges opens the neighbour too (a missing neighbour is
 * sea and reads 0 m).
 *
 * No DOM and no direct file or network access of its own: a sampler is built from
 * functions that open a Copernicus tile and load an SRTM grid (see
 * js/elevationProvider.js for the real ones, tests/terrain-point.test.mjs for fakes).
 */

import GeoTIFF, { fromUrl } from 'geotiff';
import { COPERNICUS_GRID, SRTM_GRID, copernicusUrl } from './terrain_elevation.js';

const DEFAULT_MAX_BLOCKS = 12;      // decoded Copernicus blocks kept (1024 x 1024 float32, about 4 MB each)
const DEFAULT_MAX_GRIDS = 3;        // decoded SRTM grids kept (about 26 MB each)
const SRTM_VOID = -32768;
const SRTM_SPIKE = 32767;

/* Integer cell (south-west corner) a point belongs to. */
export function cellOf(lat, lon) {
    return { lat: Math.floor(lat), lon: Math.floor(lon) };
}

// ─── geotiff bindings ─────────────────────────────────────────────────────────

/*
 * Wraps a geotiff image as the plain object the sampler reads:
 *   { width, height, blockWidth, blockHeight, readBlock(bx, by) -> { data, width } }
 * readBlock returns one internal block, clipped at the image's right and bottom edge.
 */
export function copernicusImage(image) {
    const width = image.getWidth();
    const height = image.getHeight();
    const blockWidth = image.getTileWidth();
    const blockHeight = image.getTileHeight();
    return {
        width,
        height,
        blockWidth,
        blockHeight,
        async readBlock(bx, by) {
            const x0 = bx * blockWidth;
            const y0 = by * blockHeight;
            const x1 = Math.min(width, x0 + blockWidth);
            const y1 = Math.min(height, y0 + blockHeight);
            const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
            return { data: rasters[0], width: x1 - x0 };
        }
    };
}

/*
 * Opens a Copernicus tile on the server with HTTP range requests: only the header
 * and the blocks that are read get downloaded. Returns null when the server has no
 * such tile (404); throws on any other failure.
 */
export async function openCopernicusRemote(lat, lon) {
    const url = copernicusUrl(lat, lon);
    try {
        const tiff = await fromUrl(url);
        return copernicusImage(await tiff.getImage());
    } catch (error) {
        // geotiff's error carries no status: ask the server whether the file exists.
        const head = await fetch(url, { method: 'HEAD' });
        if (head.status === 404) return null;
        throw error;
    }
}

/*
 * Opens a Copernicus tile through a function that returns parts of the file:
 * readSlices([{ offset, length }]) -> [ArrayBuffer]. Used for a tile saved in the
 * offline folder, so a 20-40 MB file is not loaded whole to read one block.
 */
export async function openCopernicusSlices(readSlices) {
    const source = {
        fetch: (slices) => readSlices(slices),
        get fileSize() { return null; },
        async close() {}
    };
    const tiff = await GeoTIFF.fromSource(source);
    return copernicusImage(await tiff.getImage());
}

// ─── Sampler ──────────────────────────────────────────────────────────────────

/* Promise cache with a size cap: the oldest entry goes first, a failed load is not kept. */
function promiseCache(limit) {
    const entries = new Map();
    return {
        get(key, load) {
            if (entries.has(key)) {
                const hit = entries.get(key);
                entries.delete(key);
                entries.set(key, hit);
                return hit;
            }
            const pending = Promise.resolve().then(load);
            entries.set(key, pending);
            pending.catch(() => {
                if (entries.get(key) === pending) entries.delete(key);
            });
            while (entries.size > limit) {
                entries.delete(entries.keys().next().value);
            }
            return pending;
        },
        deleteWhere(test) {
            for (const key of [...entries.keys()]) {
                if (test(key)) entries.delete(key);
            }
        },
        clear() {
            entries.clear();
        }
    };
}

function nodeMetres(value) {
    if (!Number.isFinite(value)) return 0;      // void reads as sea level, as in the Map Generator
    const rounded = Math.round(value);
    if (rounded > 32767) return 32767;
    if (rounded < -32767) return -32767;
    return rounded;
}

function bilinear(h00, h01, h10, h11, dr, dc) {
    const alt = Math.trunc(
        h00 * (1 - dr) * (1 - dc) +
        h01 * (1 - dr) * dc +
        h10 * dr * (1 - dc) +
        h11 * dr * dc
    );
    return alt < 0 ? 0 : alt;
}

/* Grid position of a point inside its cell: rows count south from the north edge. */
function gridPosition(lat, lon, cell) {
    const rowF = Math.max(0, Math.min(1, cell.lat + 1 - lat)) * COPERNICUS_GRID;
    const colF = Math.max(0, Math.min(1, lon - cell.lon)) * COPERNICUS_GRID;
    return { rowF, colF };
}

/*
 * A sampler holds the open tiles and decoded data of one planner session.
 *
 *   openCopernicus(where, lat, lon, neighbour) -> image | null
 *                                                       where is 'saved' or 'remote';
 *                                                       null = that tile does not exist.
 *                                                       neighbour is true for the tile south
 *                                                       or east of the one a point is in: the
 *                                                       opener may then take it from wherever
 *                                                       it is, whatever `where` says
 *   loadSrtmGrid(lat, lon) -> DataView | null           3601 x 3601 big-endian int16 from the
 *                                                       offline folder; null = not there
 *
 * Simultaneous lookups in one tile share one open and one read per block.
 */
export function createPointSampler({ openCopernicus, loadSrtmGrid, maxBlocks = DEFAULT_MAX_BLOCKS, maxGrids = DEFAULT_MAX_GRIDS } = {}) {
    const images = promiseCache(64);
    const blocks = promiseCache(maxBlocks);
    const grids = promiseCache(maxGrids);

    function tileKey(where, cell) {
        return where + ':' + cell.lat + '_' + cell.lon;
    }

    function image(where, cell, neighbour = false) {
        return images.get(tileKey(where, cell), () => openCopernicus(where, cell.lat, cell.lon, neighbour));
    }

    function block(where, cell, img, bx, by) {
        return blocks.get(tileKey(where, cell) + ':' + bx + ',' + by, () => img.readBlock(bx, by));
    }

    async function pixel(where, cell, img, row, x) {
        const bx = Math.floor(x / img.blockWidth);
        const by = Math.floor(row / img.blockHeight);
        const part = await block(where, cell, img, bx, by);
        return part.data[(row - by * img.blockHeight) * part.width + (x - bx * img.blockWidth)];
    }

    // Grid node (row, col) of the cell's 3601 x 3601 grid. Row 3600 and column 3600
    // belong to the tiles to the south and east. Tiles north of 50 degrees are
    // narrower than 3600 px, so a node sits between two pixels of its row.
    async function copernicusNode(where, cell, img, row, col) {
        if (row === COPERNICUS_GRID || col === COPERNICUS_GRID) {
            const south = row === COPERNICUS_GRID;
            const east = col === COPERNICUS_GRID;
            if (south && cell.lat <= -90) return 0;
            const other = {
                lat: cell.lat - (south ? 1 : 0),
                lon: east ? (cell.lon + 1 > 179 ? cell.lon + 1 - 360 : cell.lon + 1) : cell.lon
            };
            const neighbour = await image(where, other, true);
            if (!neighbour) return 0;
            if (neighbour.height !== COPERNICUS_GRID) {
                throw new Error('Unexpected Copernicus tile height ' + neighbour.height);
            }
            return copernicusNode(where, other, neighbour, south ? 0 : row, east ? 0 : col);
        }
        const x = col * img.width / COPERNICUS_GRID;
        const a = Math.floor(x);
        const weight = x - a;
        const left = await pixel(where, cell, img, row, a);
        if (weight === 0) return nodeMetres(left);
        const right = await pixel(where, cell, img, row, Math.min(img.width - 1, a + 1));
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            return nodeMetres(weight < 0.5 ? left : right);
        }
        return nodeMetres(left + (right - left) * weight);
    }

    /*
     * Height in metres at one point from a Copernicus tile, or null when the tile
     * does not exist at `where` or could not be read.
     */
    async function copernicusPoint(where, lat, lon) {
        const cell = cellOf(lat, lon);
        try {
            const img = await image(where, cell);
            if (!img) return null;
            if (img.height !== COPERNICUS_GRID) {
                throw new Error('Unexpected Copernicus tile height ' + img.height);
            }
            const { rowF, colF } = gridPosition(lat, lon, cell);
            const last = COPERNICUS_GRID - 1;
            const r0 = Math.min(last, Math.floor(rowF));
            const c0 = Math.min(last, Math.floor(colF));
            const r1 = r0 + 1;
            const c1 = c0 + 1;
            const dr = Math.max(0, Math.min(1, rowF - r0));
            const dc = Math.max(0, Math.min(1, colF - c0));
            const [h00, h01, h10, h11] = await Promise.all([
                copernicusNode(where, cell, img, r0, c0),
                copernicusNode(where, cell, img, r0, c1),
                copernicusNode(where, cell, img, r1, c0),
                copernicusNode(where, cell, img, r1, c1)
            ]);
            return bilinear(h00, h01, h10, h11, dr, dc);
        } catch (error) {
            console.log('Copernicus lookup failed: ' + (error?.message || error));
            return null;
        }
    }

    /*
     * Height in metres at one point from an SRTM grid in the offline folder, or
     * null when the grid is not there, or any of the four nodes around the point
     * is a void (-32768) or a spike (32767): the caller asks another source.
     */
    async function srtmPoint(lat, lon) {
        const cell = cellOf(lat, lon);
        try {
            const view = await grids.get(cell.lat + '_' + cell.lon, () => loadSrtmGrid(cell.lat, cell.lon));
            if (!view) return null;
            const { rowF, colF } = gridPosition(lat, lon, cell);
            const r0 = Math.min(SRTM_GRID - 2, Math.floor(rowF));
            const c0 = Math.min(SRTM_GRID - 2, Math.floor(colF));
            const dr = Math.max(0, Math.min(1, rowF - r0));
            const dc = Math.max(0, Math.min(1, colF - c0));
            const nodes = [];
            for (const [r, c] of [[r0, c0], [r0, c0 + 1], [r0 + 1, c0], [r0 + 1, c0 + 1]]) {
                const value = view.getInt16((r * SRTM_GRID + c) * 2, false);
                if (value === SRTM_VOID || value === SRTM_SPIKE) return null;
                nodes.push(value);
            }
            return bilinear(nodes[0], nodes[1], nodes[2], nodes[3], dr, dc);
        } catch (error) {
            console.log('SRTM lookup failed: ' + (error?.message || error));
            return null;
        }
    }

    /* Drops what is held for one tile, e.g. after its file arrived in the offline folder. */
    function forgetTile(lat, lon) {
        const suffix = ':' + lat + '_' + lon;
        images.deleteWhere(key => key.endsWith(suffix));
        blocks.deleteWhere(key => key.includes(suffix + ':'));
        grids.deleteWhere(key => key === lat + '_' + lon);
    }

    function clear() {
        images.clear();
        blocks.clear();
        grids.clear();
    }

    return { copernicusPoint, srtmPoint, forgetTile, clear };
}
