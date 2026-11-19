'use strict';

/*
 * INAV terrain tiles (.TER, format version 50): the writer used by the Map
 * Generator tab and a reader that looks a height up the way the firmware does.
 *
 * A tile covers one degree of latitude by one degree of longitude and is named
 * after its south-west corner (N47E008.TER). It is a flat array of 2048-byte
 * slots. Each slot holds one block of 28 x 32 grid points at 30 m spacing;
 * blocks are laid out every 24 points north and 28 points east, so neighbours
 * overlap by four points.
 *
 * The reader ports the firmware's single-precision arithmetic step by step
 * (src/main/terrain/terrain_utils.c, terrain_location.c, terrain_io.c,
 * terrain.c), so that the height the planner shows for a point is the height
 * the flight controller will compute for it from the same file.
 *
 * The module is pure: no DOM, no file access. Callers hand it bytes.
 */

export const TERRAIN_SPACING = 30;
export const TERRAIN_BLK_SIZE_X = 28;
export const TERRAIN_BLK_SIZE_Y = 32;
export const TERRAIN_BLK_SPACE_X = 24;
export const TERRAIN_BLK_SPACE_Y = 28;
export const TERRAIN_IO_BLOCK = 2048;
export const TERRAIN_IO_DATA = 1151;   // bytes covered by the CRC (header + packed heights + trailer)
export const TERRAIN_FORMAT_VERSION = 50;
export const TERRAIN_HEIGHT_STEP_M = 2;
export const LOCATION_SCALING_FACTOR_F32 = Math.fround(0.011131884502145034);
export const LOCATION_SCALING_FACTOR_INV_F32 = Math.fround(89.83204953368922);

const f = Math.fround;
const DEG2RAD_F32 = f(0.01745329252);                    // terrain_location.h
const E7_TO_RAD_F32 = f(f(1.0e-7) * DEG2RAD_F32);        // 1.0e-7f * DEG2RAD
const TERRAIN_LATLON_TOLERANCE = 500;                    // TERRAIN_LATLON_EQUAL

// ─── Writer (moved from tabs/map_generator.js) ────────────────────────────────

export function crc16xmodem(data, len) {
    let crc = 0;
    for (let i = 0; i < len; i++) {
        crc ^= data[i] << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

export function lonScale(latDeg) {
    return Math.max(Math.fround(Math.cos(Math.fround(latDeg * Math.PI / 180))), 0.01);
}

export function addOffset(latE7, lonE7, ofsNorth, ofsEast) {
    const dlat = Math.trunc(ofsNorth * LOCATION_SCALING_FACTOR_INV_F32);
    const ls = lonScale((latE7 + dlat * 0.5) * 1e-7);
    const dlng = Math.trunc((ofsEast * LOCATION_SCALING_FACTOR_INV_F32) / ls);
    return [latE7 + dlat, lonE7 + dlng];
}

export function eastBlocks(latE7, lonE7) {
    const r = addOffset(latE7, lonE7 + 10000000, 0, 2 * TERRAIN_SPACING * TERRAIN_BLK_SIZE_Y);
    const dlng = r[1] - lonE7;
    const eastDist = dlng * LOCATION_SCALING_FACTOR_F32 * lonScale((latE7 + r[0]) * 0.5 * 1e-7);
    return Math.floor(eastDist / (TERRAIN_SPACING * TERRAIN_BLK_SPACE_Y));
}

// Bit-order sanity check for the 10-bit packer, mirror-verified against the
// firmware decoder: values 0x2AA and 0x155 must serialise to bytes AA 56 05.
// Runs once per generation; a failure means the bit order is wrong and no
// terrain file may be produced.
export function terrainPackerSelfTest() {
    const vals = [0x2AA, 0x155];
    const out = [];
    let acc = 0, accBits = 0;
    for (const val of vals) {
        acc |= val << accBits;
        accBits += 10;
        while (accBits >= 8) { out.push(acc & 0xFF); acc >>>= 8; accBits -= 8; }
    }
    out.push(acc & 0xFF);   // 4 remaining bits
    if (out[0] !== 0xAA || out[1] !== 0x56 || out[2] !== 0x05) {
        throw new Error('Terrain 10-bit packer self-test failed (bit order) — refusing to generate');
    }
}

// Reads packed 10-bit value i back out of the block bytes (independent decode
// used by the per-block self-check).
export function readPacked10(u8, i) {
    const bit = i * 10;
    const byte = 22 + (bit >> 3);
    const word = u8[byte] | (u8[byte + 1] << 8) | (u8[byte + 2] << 16);
    return (word >> (bit & 7)) & 0x3FF;
}

// Packs one 2048-byte terrain block in the version-50 layout: the 896 heights
// are stored as 10-bit offsets in 2 m steps above the block's lowest point
// (heightBase), as one continuous little-endian bitstream. The on-disk block
// size is unchanged — the packing saves space inside the block, not on disk.
export function packTerrainBlock(latE7, lonE7, spacing, heights, idxX, idxY, lonDeg, latDeg) {
    const buf = new ArrayBuffer(TERRAIN_IO_BLOCK);
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);
    v.setBigUint64(0, 0x00FFFFFFFFFFFFFFn, true);
    v.setInt32(8, latE7, true);
    v.setInt32(12, lonE7, true);
    v.setUint16(16, 0, true);
    v.setUint16(18, TERRAIN_FORMAT_VERSION, true);   // format version 50 (10-bit × 2 m)
    v.setUint16(20, spacing, true);

    // The lowest point in the block is the base every height is encoded against.
    let heightBase = heights[0];
    for (let i = 1; i < heights.length; i++) {
        if (heights[i] < heightBase) heightBase = heights[i];
    }

    // 896 values × 10 bits: value i occupies bits [10·i .. 10·i+9] of one
    // little-endian bitstream (fill the accumulator from the low end, emit a
    // byte whenever 8 bits are ready). 8960 bits = exactly 1120 bytes.
    let acc = 0, accBits = 0, off = 22;
    for (let i = 0; i < heights.length; i++) {
        let step = Math.round((heights[i] - heightBase) / 2);
        if (step < 0) step = 0;
        if (step > 1023) step = 1023;
        acc |= step << accBits;
        accBits += 10;
        while (accBits >= 8) {
            u8[off++] = acc & 0xFF;
            acc >>>= 8;
            accBits -= 8;
        }
    }

    v.setInt16(1142, heightBase, true);     // base sits AFTER the packed data
    v.setUint16(1144, idxX, true);
    v.setUint16(1146, idxY, true);
    v.setInt16(1148, lonDeg, true);
    v.setInt8(1150, latDeg);
    const crc = crc16xmodem(u8, TERRAIN_IO_DATA);
    v.setUint16(16, crc, true);

    // Permanent self-check: independently decode the packed bytes and require
    // every point to reconstruct within 1 m of the source height. On mismatch
    // the encoder is broken — refuse to write bad terrain.
    for (let i = 0; i < heights.length; i++) {
        if (Math.abs(heightBase + 2 * readPacked10(u8, i) - heights[i]) > 1) {
            throw new Error(`Terrain block self-check failed at point ${i} (block ${idxX}/${idxY})`);
        }
    }
    return u8;
}

export function terrainDatFilename(lat, lon) {
    const latPrefix = lat >= 0 ? 'N' : 'S';
    const lonPrefix = lon >= 0 ? 'E' : 'W';
    const latStr = String(Math.abs(lat)).padStart(2, '0');
    const lonStr = String(Math.abs(lon)).padStart(3, '0');
    return latPrefix + latStr + lonPrefix + lonStr + '.TER';
}

/* Number of block rows (north) and columns (east) in the tile whose south-west
 * corner is degLat/degLon, as the writer lays them out. */
export function terTileDimensions(degLat, degLon) {
    const baseLat = degLat * 10000000;
    const baseLon = degLon * 10000000;
    let numX = 0;
    while (addOffset(baseLat, baseLon, numX * TERRAIN_BLK_SPACE_X * TERRAIN_SPACING, 0)[0] * 1e-7 - degLat < 1.0) numX++;
    const numY = eastBlocks(baseLat, baseLon);
    return { numX, numY, bytes: numX * numY * TERRAIN_IO_BLOCK };
}

/* Builds block (ix north, iy east) of a tile. heightAt(latDeg, lonDeg) returns
 * the ground height in whole metres at one grid point. */
export function buildTerBlock(degLat, degLon, ix, iy, heightAt) {
    const baseLat = degLat * 10000000;
    const baseLon = degLon * 10000000;
    const blk = addOffset(baseLat, baseLon,
        ix * TERRAIN_BLK_SPACE_X * TERRAIN_SPACING,
        iy * TERRAIN_BLK_SPACE_Y * TERRAIN_SPACING);
    const heights = new Int16Array(TERRAIN_BLK_SIZE_X * TERRAIN_BLK_SIZE_Y);
    for (let gx = 0; gx < TERRAIN_BLK_SIZE_X; gx++) {
        for (let gy = 0; gy < TERRAIN_BLK_SIZE_Y; gy++) {
            const pt = addOffset(baseLat, baseLon,
                (ix * TERRAIN_BLK_SPACE_X + gx) * TERRAIN_SPACING,
                (iy * TERRAIN_BLK_SPACE_Y + gy) * TERRAIN_SPACING);
            heights[gx * TERRAIN_BLK_SIZE_Y + gy] = heightAt(pt[0] * 1e-7, pt[1] * 1e-7);
        }
    }
    return packTerrainBlock(blk[0], blk[1], TERRAIN_SPACING, heights, ix, iy, degLon, degLat);
}

/*
 * Builds a whole tile in memory from a height function. `wantBlock(ix, iy)`
 * limits the work to some blocks; the others stay zero-filled, which the
 * firmware and the reader below both reject as "no data". Intended for tests
 * and fixtures: the Map Generator has its own loop with progress reporting.
 */
export function createTerTile(degLat, degLon, heightAt, { wantBlock = null } = {}) {
    terrainPackerSelfTest();
    const { numX, numY, bytes } = terTileDimensions(degLat, degLon);
    const output = new Uint8Array(bytes);
    for (let ix = 0; ix < numX; ix++) {
        for (let iy = 0; iy < numY; iy++) {
            if (wantBlock && !wantBlock(ix, iy)) continue;
            output.set(buildTerBlock(degLat, degLon, ix, iy, heightAt), (ix * numY + iy) * TERRAIN_IO_BLOCK);
        }
    }
    return output;
}

// ─── Reader (port of the firmware lookup) ─────────────────────────────────────

/* C integer division: truncates toward zero. */
function idiv(a, b) {
    return Math.trunc(a / b);
}

/* terrain_location.c longitudeScale(): cosf(lat * (1.0e-7f * DEG2RAD)), floor 0.01. */
function longitudeScale(latE7) {
    const scale = f(Math.cos(f(f(latE7) * E7_TO_RAD_F32)));
    return Math.max(scale, f(0.01));
}

function diffLongitude(lon1, lon2) {
    if ((lon1 < 0) === (lon2 < 0)) {
        return lon1 - lon2;
    }
    let dlon = lon1 - lon2;
    if (dlon > 1800000000) {
        dlon -= 3600000000;
    } else if (dlon < -1800000000) {
        dlon += 3600000000;
    }
    return dlon;
}

/* terrain_location.c gpsGetDistanceNE(): metres north and east from a to b. */
function distanceNE(aLat, aLon, bLat, bLon) {
    const north = f(f(bLat - aLat) * LOCATION_SCALING_FACTOR_F32);
    const east = f(f(f(diffLongitude(bLon, aLon)) * LOCATION_SCALING_FACTOR_F32) * longitudeScale(idiv(bLat + aLat, 2)));
    return { north, east };
}

/* terrain_location.c offsetLatlng(), without the pole and date-line wrapping
 * (block corners inside one tile never reach either). */
function offsetLatLon(latE7, lonE7, northM, eastM) {
    const dlat = Math.trunc(f(f(northM) * LOCATION_SCALING_FACTOR_INV_F32));
    const dlon = Math.trunc(f(f(f(eastM) * LOCATION_SCALING_FACTOR_INV_F32) / longitudeScale(latE7 + idiv(dlat, 2))));
    return [latE7 + dlat, lonE7 + dlon];
}

/* terrain_utils.c eastBlocks(): block columns per row, as the firmware counts
 * them when it turns a block index into a file offset. */
export function terFirmwareEastBlocks(latDegrees, lonDegrees) {
    const lat = latDegrees * 10000000;
    const lon1 = lonDegrees * 10000000;
    let lon2 = (lonDegrees + 1) * 10000000;

    const eastM = f(2.0 * TERRAIN_SPACING * TERRAIN_BLK_SIZE_Y);
    const latRad = f(f(f(lat) * f(1e-7)) * DEG2RAD_F32);
    const dLonDeg = f(eastM / f(f(111319.5) * f(Math.cos(latRad))));
    lon2 += Math.trunc(f(dLonDeg * f(1e7)));

    const offset = distanceNE(lat, lon1, lat, lon2);
    return Math.trunc(f(offset.east / (TERRAIN_SPACING * TERRAIN_BLK_SPACE_Y)));
}

/*
 * terrain_utils.c calculateGridInfo(): which tile, which block in it, which
 * grid cell in the block, and how far into the cell a position falls.
 * latE7 / lonE7 are degrees x 1e7 as integers.
 */
export function terGridInfo(latE7, lonE7) {
    const latDegrees = idiv(latE7 < 0 ? latE7 - 9999999 : latE7, 10000000);
    const lonDegrees = idiv(lonE7 < 0 ? lonE7 - 9999999 : lonE7, 10000000);
    const refLat = latDegrees * 10000000;
    const refLon = lonDegrees * 10000000;

    const offset = distanceNE(refLat, refLon, latE7, lonE7);
    const idxX = Math.trunc(f(offset.north / TERRAIN_SPACING));
    const idxY = Math.trunc(f(offset.east / TERRAIN_SPACING));

    const gridIdxX = idiv(idxX, TERRAIN_BLK_SPACE_X);
    const gridIdxY = idiv(idxY, TERRAIN_BLK_SPACE_Y);

    const [gridLat, gridLon] = offsetLatLon(refLat, refLon,
        gridIdxX * TERRAIN_BLK_SPACE_X * TERRAIN_SPACING,
        gridIdxY * TERRAIN_BLK_SPACE_Y * TERRAIN_SPACING);

    return {
        latDegrees,
        lonDegrees,
        gridIdxX,
        gridIdxY,
        idxX: idxX % TERRAIN_BLK_SPACE_X,
        idxY: idxY % TERRAIN_BLK_SPACE_Y,
        fracX: f(f(offset.north - f(idxX * TERRAIN_SPACING)) / TERRAIN_SPACING),
        fracY: f(f(offset.east - f(idxY * TERRAIN_SPACING)) / TERRAIN_SPACING),
        gridLat,
        gridLon
    };
}

/* Name of the tile file a grid info belongs to. */
export function terTileName(info) {
    return terrainDatFilename(info.latDegrees, info.lonDegrees);
}

/* terrain_io.c: byte offset of the block's 2048-byte slot inside its tile file. */
export function terBlockOffset(info) {
    const blockNumber = terFirmwareEastBlocks(info.latDegrees, info.lonDegrees) * info.gridIdxX + info.gridIdxY;
    return blockNumber * TERRAIN_IO_BLOCK;
}

/*
 * Validates the bytes read from a block's slot the way terrain_io.c does after
 * a read (block index, CRC, version, spacing), plus the corner match that
 * terrain_utils.c findGridCache() needs before it will serve a cached block.
 * Returns a decoded block, or null when the firmware would not use it.
 */
export function terDecodeBlock(bytes, info) {
    if (!bytes || bytes.length < TERRAIN_IO_DATA) {
        return null;
    }
    const u8 = bytes.subarray(0, TERRAIN_IO_DATA);
    const v = new DataView(u8.buffer, u8.byteOffset, TERRAIN_IO_DATA);

    if (v.getUint16(1144, true) !== info.gridIdxX || v.getUint16(1146, true) !== info.gridIdxY) {
        return null;
    }
    if (v.getUint16(18, true) !== TERRAIN_FORMAT_VERSION || v.getUint16(20, true) !== TERRAIN_SPACING) {
        return null;
    }

    const storedCrc = v.getUint16(16, true);
    const copy = Uint8Array.from(u8);
    copy[16] = 0;
    copy[17] = 0;
    if (crc16xmodem(copy, TERRAIN_IO_DATA) !== storedCrc) {
        return null;
    }

    if (Math.abs(v.getInt32(8, true) - info.gridLat) > TERRAIN_LATLON_TOLERANCE ||
        Math.abs(v.getInt32(12, true) - info.gridLon) > TERRAIN_LATLON_TOLERANCE) {
        return null;
    }

    return {
        u8: copy,
        bitmap: v.getBigUint64(0, true),
        heightBase: v.getInt16(1142, true)
    };
}

/* terrain_utils.c checkBitmap(): one bit per 4 x 4 sub-grid. */
function bitmapHas(block, idxX, idxY) {
    if (idxX > 27 || idxY > 31) {
        return false;
    }
    const bit = BigInt((idxY >> 2) + 8 * (idxX >> 2));
    return ((block.bitmap >> bit) & 1n) === 1n;
}

function gridHeight(block, idxX, idxY) {
    return block.heightBase + TERRAIN_HEIGHT_STEP_M * readPacked10(block.u8, idxX * TERRAIN_BLK_SIZE_Y + idxY);
}

/*
 * terrain.c getHeightAmslMeters(): bilinear interpolation between the four
 * grid points around the position. Returns metres above sea level, or null
 * when the block does not cover the cell.
 */
export function terBlockHeight(block, info) {
    const x = info.idxX;
    const y = info.idxY;
    if (x > TERRAIN_BLK_SIZE_X - 2 || y > TERRAIN_BLK_SIZE_Y - 2) {
        return null;
    }
    if (!bitmapHas(block, x, y) || !bitmapHas(block, x, y + 1) ||
        !bitmapHas(block, x + 1, y) || !bitmapHas(block, x + 1, y + 1)) {
        return null;
    }

    const h00 = gridHeight(block, x, y);
    const h01 = gridHeight(block, x, y + 1);
    const h10 = gridHeight(block, x + 1, y);
    const h11 = gridHeight(block, x + 1, y + 1);

    const avg1 = f(f(f(1 - info.fracX) * h00) + f(info.fracX * h10));
    const avg2 = f(f(f(1 - info.fracX) * h01) + f(info.fracX * h11));
    return f(f(f(1 - info.fracY) * avg1) + f(info.fracY * avg2));
}

/*
 * Height at a position from a whole tile held in memory. Convenience for
 * tests and small tools; the app reads single blocks instead (tiles are tens
 * of megabytes).
 */
export function terHeightFromTile(tileBytes, latE7, lonE7) {
    const info = terGridInfo(latE7, lonE7);
    const offset = terBlockOffset(info);
    if (offset + TERRAIN_IO_DATA > tileBytes.length) {
        return null;
    }
    const block = terDecodeBlock(tileBytes.subarray(offset, offset + TERRAIN_IO_BLOCK), info);
    return block ? terBlockHeight(block, info) : null;
}
