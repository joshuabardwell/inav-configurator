import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    TERRAIN_BLK_SPACE_X,
    TERRAIN_BLK_SPACE_Y,
    TERRAIN_IO_BLOCK,
    TERRAIN_SPACING,
    addOffset,
    buildTerBlock,
    crc16xmodem,
    createTerTile,
    eastBlocks,
    terBlockHeight,
    terBlockOffset,
    terDecodeBlock,
    terFirmwareEastBlocks,
    terGridInfo,
    terHeightFromTile,
    terTileDimensions,
    terTileName,
    terrainCellOfFilename,
    terrainDatFilename,
    terrainPackerSelfTest
} from '../js/terrain_ter.js';

// Rolling ground between about 300 m and 500 m, smooth at the 30 m grid scale.
function hills(latDeg, lonDeg) {
    return Math.round(400 + 60 * Math.sin(latDeg * 900) + 40 * Math.cos(lonDeg * 700));
}

// Position of grid point (north index, east index) of a tile, as the writer places it.
function gridPoint(degLat, degLon, north, east) {
    return addOffset(degLat * 1e7, degLon * 1e7, north * TERRAIN_SPACING, east * TERRAIN_SPACING);
}

describe('.TER writer', () => {
    test('the 10-bit packer keeps the bit order the firmware decodes', () => {
        assert.doesNotThrow(terrainPackerSelfTest);
    });

    test('tile names follow the south-west corner', () => {
        assert.equal(terrainDatFilename(47, 8), 'N47E008.TER');
        assert.equal(terrainDatFilename(-34, -71), 'S34W071.TER');
        assert.equal(terrainDatFilename(0, 0), 'N00E000.TER');
    });

    test('a tile name gives its cell back; anything else gives null', () => {
        for (const cell of [{ lat: 47, lon: 8 }, { lat: -34, lon: -71 }, { lat: 0, lon: 0 }, { lat: -1, lon: -180 }, { lat: 89, lon: 179 }]) {
            assert.deepEqual(terrainCellOfFilename(terrainDatFilename(cell.lat, cell.lon)), cell);
        }
        assert.deepEqual(terrainCellOfFilename('n47e008.ter'), { lat: 47, lon: 8 });
        assert.deepEqual(terrainCellOfFilename('S00W000.TER'), { lat: 0, lon: 0 });
        assert.equal(terrainCellOfFilename('N47E008.DAT'), null);
        assert.equal(terrainCellOfFilename('N47E008.TER.part'), null);
        assert.equal(terrainCellOfFilename('N90E008.TER'), null);
        assert.equal(terrainCellOfFilename('N47E180.TER'), null);
        assert.equal(terrainCellOfFilename('TERINDEX.TXT'), null);
    });

    test('a 47 degree tile has the expected layout', () => {
        const { numX, numY, bytes } = terTileDimensions(47, 8);
        assert.equal(numY, 92);
        assert.ok(numX > 150 && numX < 160, `rows: ${numX}`);
        assert.equal(bytes, numX * numY * TERRAIN_IO_BLOCK);
    });
});

describe('.TER reader follows the firmware', () => {
    test('counts the same number of block columns as the writer at every latitude', () => {
        for (let lat = -89; lat <= 89; lat++) {
            assert.equal(terFirmwareEastBlocks(lat, 8), eastBlocks(lat * 1e7, 8 * 1e7), `latitude ${lat}`);
        }
    });

    test('floors negative coordinates to the tile south-west of the point', () => {
        const info = terGridInfo(-335000000, -705000000);
        assert.equal(info.latDegrees, -34);
        assert.equal(info.lonDegrees, -71);
        assert.equal(terTileName(info), 'S34W071.TER');

        const edge = terGridInfo(-10000000, -10000000);
        assert.equal(edge.latDegrees, -1);
        assert.equal(edge.lonDegrees, -1);
    });

    test('finds every block the writer produced that lies inside the tile', () => {
        const { numX, numY } = terTileDimensions(47, 8);
        const rows = [0, 1, numX - 2, numX - 1];
        const tile = createTerTile(47, 8, hills, { wantBlock: (ix) => rows.includes(ix) });

        let checked = 0;
        let lastColumn = -1;
        let lastRow = -1;
        for (const ix of rows) {
            for (let iy = 0; iy < numY; iy++) {
                // A point well inside the block, away from the cells its neighbours also cover.
                const [lat, lon] = gridPoint(47, 8, ix * TERRAIN_BLK_SPACE_X + 10.5, iy * TERRAIN_BLK_SPACE_Y + 12.5);
                // The writer adds spare blocks past the tile's north and east edges;
                // positions there belong to the neighbouring tile and are never looked up here.
                if (lat >= 48e7 || lon >= 9e7) continue;

                const info = terGridInfo(lat, lon);
                assert.equal(info.latDegrees, 47);
                assert.equal(info.lonDegrees, 8);
                assert.equal(info.gridIdxX, ix, `block row for ${ix}/${iy}`);
                assert.equal(info.gridIdxY, iy, `block column for ${ix}/${iy}`);
                assert.equal(terBlockOffset(info), (ix * numY + iy) * TERRAIN_IO_BLOCK);
                assert.notEqual(terHeightFromTile(tile, lat, lon), null, `height for block ${ix}/${iy}`);
                checked++;
                lastColumn = Math.max(lastColumn, iy);
                lastRow = Math.max(lastRow, ix);
            }
        }
        assert.ok(checked > 3 * 85, `only ${checked} blocks checked`);
        assert.ok(lastColumn >= numY - 3, `last column checked: ${lastColumn} of ${numY}`);
        assert.ok(lastRow >= numX - 2, `last row checked: ${lastRow} of ${numX}`);
    });

    test('covers the tile right up to its north-east corner', () => {
        const { numX, numY } = terTileDimensions(47, 8);
        const tile = createTerTile(47, 8, hills, { wantBlock: (ix, iy) => ix >= numX - 2 && iy >= numY - 3 });
        // 20 m inside the corner: within one grid cell of both edges.
        const lat = 48e7 - 1800;
        const lon = 9e7 - 2600;
        const height = terHeightFromTile(tile, lat, lon);
        assert.notEqual(height, null);
        assert.ok(Math.abs(height - hills(lat * 1e-7, lon * 1e-7)) <= 3);
    });

    test('returns the written heights within the 2 m packing step', () => {
        const tile = createTerTile(47, 8, hills, { wantBlock: (ix) => ix < 3 });
        let worst = 0;
        let samples = 0;
        // Points exactly on grid nodes: interpolation must not add error there.
        for (let north = 1; north < 3 * TERRAIN_BLK_SPACE_X - 1; north += 7) {
            for (let east = 1; east < 91 * TERRAIN_BLK_SPACE_Y; east += 53) {
                const [lat, lon] = gridPoint(47, 8, north, east);
                if (lon >= 9e7) continue;   // past the tile's east edge
                const height = terHeightFromTile(tile, lat, lon);
                assert.notEqual(height, null, `no height at ${north}/${east}`);
                worst = Math.max(worst, Math.abs(height - hills(lat * 1e-7, lon * 1e-7)));
                samples++;
            }
        }
        assert.ok(samples > 400, `only ${samples} samples`);
        // 1 m from the 2 m step, plus up to one grid cell of slope when float
        // rounding puts a node a hair inside the neighbouring cell.
        assert.ok(worst <= 3, `worst error ${worst} m`);
    });

    test('interpolates linearly between grid points', () => {
        // A plane rising 2 m per grid step to the north and 4 m per step to the east.
        const plane = (latDeg, lonDeg) => {
            const info = terGridInfo(Math.round(latDeg * 1e7), Math.round(lonDeg * 1e7));
            const north = info.gridIdxX * TERRAIN_BLK_SPACE_X + info.idxX + info.fracX;
            const east = info.gridIdxY * TERRAIN_BLK_SPACE_Y + info.idxY + info.fracY;
            return Math.round((200 + 2 * north + 4 * east) / 2) * 2;
        };
        const tile = createTerTile(47, 8, plane, { wantBlock: (ix, iy) => ix === 0 && iy === 0 });

        const [lat, lon] = gridPoint(47, 8, 10.5, 12.5);
        const info = terGridInfo(lat, lon);
        const expected = 200 + 2 * (info.idxX + info.fracX) + 4 * (info.idxY + info.fracY);
        const height = terHeightFromTile(tile, lat, lon);
        assert.ok(Math.abs(height - expected) < 1.5, `got ${height}, expected about ${expected}`);
        assert.ok(info.fracX > 0.2 && info.fracX < 0.8, `fracX ${info.fracX}`);
    });

    test('works in a tile with negative latitude and longitude', () => {
        const tile = createTerTile(-34, -71, hills, { wantBlock: (ix, iy) => ix === 2 && iy === 3 });
        const [lat, lon] = gridPoint(-34, -71, 2 * TERRAIN_BLK_SPACE_X + 9.5, 3 * TERRAIN_BLK_SPACE_Y + 11.5);
        assert.ok(lat < 0 && lon < 0);
        const height = terHeightFromTile(tile, lat, lon);
        assert.notEqual(height, null);
        assert.ok(Math.abs(height - hills(lat * 1e-7, lon * 1e-7)) <= 3);
    });

    test('rejects blocks the firmware would reject', () => {
        const [lat, lon] = gridPoint(47, 8, 10.5, 12.5);
        const info = terGridInfo(lat, lon);
        const good = buildTerBlock(47, 8, 0, 0, hills);
        assert.notEqual(terDecodeBlock(good, info), null);

        assert.equal(terDecodeBlock(new Uint8Array(TERRAIN_IO_BLOCK), info), null, 'empty slot');
        assert.equal(terDecodeBlock(good.subarray(0, 500), info), null, 'short read');

        const flipped = Uint8Array.from(good);
        flipped[600] ^= 0x10;
        assert.equal(terDecodeBlock(flipped, info), null, 'corrupt height data');

        const reversion = (mutate) => {
            const copy = Uint8Array.from(good);
            const view = new DataView(copy.buffer);
            mutate(view);
            view.setUint16(16, 0, true);
            view.setUint16(16, crc16xmodem(copy, 1151), true);
            return copy;
        };
        assert.equal(terDecodeBlock(reversion((v) => v.setUint16(18, 1, true)), info), null, 'old format version');
        assert.equal(terDecodeBlock(reversion((v) => v.setUint16(20, 100, true)), info), null, 'other grid spacing');
        assert.equal(terDecodeBlock(reversion((v) => v.setUint16(1146, 5, true)), info), null, 'block from another column');
        assert.equal(terDecodeBlock(reversion((v) => v.setInt32(8, v.getInt32(8, true) + 5000, true)), info), null,
            'corner in the wrong place');

        // A block whose bitmap says the cell was never filled in.
        const unfilled = reversion((v) => v.setBigUint64(0, 0n, true));
        const block = terDecodeBlock(unfilled, info);
        assert.notEqual(block, null);
        assert.equal(terBlockHeight(block, info), null);
    });

    test('reports no data beyond the end of a truncated tile', () => {
        const tile = createTerTile(47, 8, hills, { wantBlock: (ix) => ix === 0 });
        const firstRowOnly = tile.subarray(0, 92 * TERRAIN_IO_BLOCK);
        const [lat, lon] = gridPoint(47, 8, 5 * TERRAIN_BLK_SPACE_X + 10.5, 12.5);
        assert.equal(terHeightFromTile(firstRowOnly, lat, lon), null);
    });
});
