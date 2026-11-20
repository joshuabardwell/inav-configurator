'use strict';

/*
 * Ground height at single points, straight from the Copernicus GLO-30 GeoTIFF
 * tiles that terrain files (.TER) are built from (js/terrain_elevation.js). The
 * mission planner uses this for points whose cell has no file in the terrain
 * folder yet.
 *
 * The answers follow the builder's arithmetic - the same 3600-step grid per
 * 1 degree cell, nodes rounded to whole metres, bilinear between four nodes, then
 * truncated and clamped at 0 - so the planner shows what a .TER built from the
 * tile holds. That includes a cell's south-most row and east-most column of
 * nodes, which are the first row and column of the neighbouring tiles: a point
 * within 30 m of those edges opens the neighbour too (a missing neighbour is sea
 * and reads 0 m).
 *
 * No DOM and no direct network access of its own: a sampler is built from a
 * function that opens a Copernicus tile (see js/elevationProvider.js for the real
 * one, tests/terrain-point.test.mjs for fakes).
 */

import { fromUrl } from 'geotiff';
import { COPERNICUS_GRID, copernicusUrl } from './terrain_elevation.js';

const DEFAULT_MAX_BLOCKS = 12;      // decoded Copernicus blocks kept (1024 x 1024 float32, about 4 MB each)

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
 *   openCopernicus(lat, lon, neighbour) -> image | null
 *                              null = that tile does not exist. neighbour is true
 *                              for the tile south or east of the one a point is in.
 *
 * Simultaneous lookups in one tile share one open and one read per block.
 */
export function createPointSampler({ openCopernicus, maxBlocks = DEFAULT_MAX_BLOCKS } = {}) {
    const images = promiseCache(64);
    const blocks = promiseCache(maxBlocks);

    function tileKey(cell) {
        return cell.lat + '_' + cell.lon;
    }

    function image(cell, neighbour = false) {
        return images.get(tileKey(cell), () => openCopernicus(cell.lat, cell.lon, neighbour));
    }

    function block(cell, img, bx, by) {
        return blocks.get(tileKey(cell) + ':' + bx + ',' + by, () => img.readBlock(bx, by));
    }

    async function pixel(cell, img, row, x) {
        const bx = Math.floor(x / img.blockWidth);
        const by = Math.floor(row / img.blockHeight);
        const part = await block(cell, img, bx, by);
        return part.data[(row - by * img.blockHeight) * part.width + (x - bx * img.blockWidth)];
    }

    // Grid node (row, col) of the cell's 3601 x 3601 grid. Row 3600 and column 3600
    // belong to the tiles to the south and east. Tiles north of 50 degrees are
    // narrower than 3600 px, so a node sits between two pixels of its row.
    async function copernicusNode(cell, img, row, col) {
        if (row === COPERNICUS_GRID || col === COPERNICUS_GRID) {
            const south = row === COPERNICUS_GRID;
            const east = col === COPERNICUS_GRID;
            if (south && cell.lat <= -90) return 0;
            const other = {
                lat: cell.lat - (south ? 1 : 0),
                lon: east ? (cell.lon + 1 > 179 ? cell.lon + 1 - 360 : cell.lon + 1) : cell.lon
            };
            const neighbour = await image(other, true);
            if (!neighbour) return 0;
            if (neighbour.height !== COPERNICUS_GRID) {
                throw new Error('Unexpected Copernicus tile height ' + neighbour.height);
            }
            return copernicusNode(other, neighbour, south ? 0 : row, east ? 0 : col);
        }
        const x = col * img.width / COPERNICUS_GRID;
        const a = Math.floor(x);
        const weight = x - a;
        const left = await pixel(cell, img, row, a);
        if (weight === 0) return nodeMetres(left);
        const right = await pixel(cell, img, row, Math.min(img.width - 1, a + 1));
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            return nodeMetres(weight < 0.5 ? left : right);
        }
        return nodeMetres(left + (right - left) * weight);
    }

    /*
     * Height in metres at one point from a Copernicus tile, or null when the tile
     * does not exist or could not be read.
     */
    async function copernicusPoint(lat, lon) {
        const cell = cellOf(lat, lon);
        try {
            const img = await image(cell);
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
                copernicusNode(cell, img, r0, c0),
                copernicusNode(cell, img, r0, c1),
                copernicusNode(cell, img, r1, c0),
                copernicusNode(cell, img, r1, c1)
            ]);
            return bilinear(h00, h01, h10, h11, dr, dc);
        } catch (error) {
            console.log('Copernicus lookup failed: ' + (error?.message || error));
            return null;
        }
    }

    /* Drops what is held for one tile, e.g. after its terrain file was built. */
    function forgetTile(lat, lon) {
        const key = lat + '_' + lon;
        images.deleteWhere(held => held === key);
        blocks.deleteWhere(held => held.startsWith(key + ':'));
    }

    function clear() {
        images.clear();
        blocks.clear();
    }

    return { copernicusPoint, forgetTile, clear };
}
