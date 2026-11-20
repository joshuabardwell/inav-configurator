import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cellOf, createPointSampler } from '../js/terrain_point.js';
import { SRTM_GRID, hgtElevation, makeHgtView } from '../js/terrain_elevation.js';

// A fake Copernicus tile: height 3600, any width, 1024 px blocks, heights from a function.
function fakeImage(width, heightAt, log = { blocks: [] }) {
    const blockWidth = 1024;
    const blockHeight = 1024;
    return {
        width,
        height: 3600,
        blockWidth,
        blockHeight,
        async readBlock(bx, by) {
            log.blocks.push(bx + ',' + by);
            await new Promise(resolve => setTimeout(resolve, 5));
            const x0 = bx * blockWidth;
            const y0 = by * blockHeight;
            const w = Math.min(width, x0 + blockWidth) - x0;
            const h = Math.min(3600, y0 + blockHeight) - y0;
            const data = new Float32Array(w * h);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    data[y * w + x] = heightAt(y0 + y, x0 + x);
                }
            }
            return { data, width: w };
        }
    };
}

function srtmGrid(heightAt) {
    const bytes = new Uint8Array(SRTM_GRID * SRTM_GRID * 2);
    const view = new DataView(bytes.buffer);
    for (let r = 0; r < SRTM_GRID; r++) {
        for (let c = 0; c < SRTM_GRID; c++) {
            view.setInt16((r * SRTM_GRID + c) * 2, heightAt(r, c), false);
        }
    }
    return bytes;
}

describe('cellOf', () => {
    test('uses the south-west corner, also for negative coordinates', () => {
        assert.deepEqual(cellOf(30.38, -102.95), { lat: 30, lon: -103 });
        assert.deepEqual(cellOf(-0.5, 0.5), { lat: -1, lon: 0 });
    });
});

describe('Copernicus points', () => {
    test('a point on a grid node reads that pixel, rounded', async () => {
        const sampler = createPointSampler({
            openCopernicus: async () => fakeImage(3600, (row, x) => 100.4 + row + x * 0.001)
        });
        // row 1800, column 900 of N30W103
        const height = await sampler.copernicusPoint('remote', 31 - 1800 / 3600, -103 + 900 / 3600);
        assert.equal(height, Math.round(100.4 + 1800 + 0.9));
    });

    test('interpolates between four nodes and truncates like the Map Generator', async () => {
        const heightAt = (row, x) => 500 + 3 * row - 2 * x;
        const sampler = createPointSampler({ openCopernicus: async () => fakeImage(3600, heightAt) });
        const lat = 31 - 100.25 / 3600;
        const lon = -103 + 200.5 / 3600;
        const expected = Math.trunc(500 + 3 * 100.25 - 2 * 200.5);
        assert.equal(await sampler.copernicusPoint('remote', lat, lon), expected);
    });

    test('matches hgtElevation on the same grid away from the cell edges', async () => {
        const heightAt = (row, x) => Math.round(800 + 300 * Math.sin(row / 37) + 200 * Math.cos(x / 53));
        const sampler = createPointSampler({ openCopernicus: async () => fakeImage(3600, heightAt) });
        const view = makeHgtView(srtmGrid((r, c) => heightAt(Math.min(r, 3599), Math.min(c, 3599))));
        const cache = { '30_-103': view };
        for (const [lat, lon] of [[30.3891303, -102.9510679], [30.75, -102.25], [30.0101, -102.9899], [30.5, -102.5]]) {
            assert.equal(await sampler.copernicusPoint('remote', lat, lon), hgtElevation(cache, 30, -103, lat, lon));
        }
    });

    test('a narrow tile (north of 50 degrees) is read at the right longitude', async () => {
        // 2400 px wide: pixel x covers 1.5 grid columns. Height = pixel index * 10.
        const sampler = createPointSampler({ openCopernicus: async () => fakeImage(2400, (row, x) => x * 10) });
        // grid column 1800 sits at pixel 1200 exactly
        assert.equal(await sampler.copernicusPoint('remote', 55.5, 10 + 1800 / 3600), 12000);
        // grid column 1801 sits at pixel 1200.667
        assert.equal(await sampler.copernicusPoint('remote', 55.5, 10 + 1801 / 3600), Math.round(12006.67));
    });

    test('the south-most and east-most nodes come from the neighbouring tiles', async () => {
        const opened = [];
        const sampler = createPointSampler({
            // every tile is flat at 1000 + 10 * latitude + longitude of its own cell
            openCopernicus: async (where, lat, lon, neighbour) => {
                opened.push(lat + '_' + lon + (neighbour ? ':neighbour' : ''));
                return lat === 45 && lon === 10 ? null : fakeImage(3600, () => 1000 + 10 * lat + lon);
            }
        });
        // N46E008, half a step from the east edge: half this tile (1468), half N46E009 (1469)
        assert.equal(await sampler.copernicusPoint('remote', 46.5, 9 - 0.5 / 3600), 1468);
        assert.ok(opened.includes('46_9:neighbour'));
        // half a step from the south edge: half this tile (1468), half N45E008 (1458)
        assert.equal(await sampler.copernicusPoint('remote', 46 + 0.5 / 3600, 8.5), 1463);
        // N46E010 over a missing southern neighbour (sea): half 1470, half 0
        assert.equal(await sampler.copernicusPoint('remote', 46 + 0.5 / 3600, 10.5), 735);
        // away from the edges no neighbour is opened
        opened.length = 0;
        await sampler.copernicusPoint('remote', 46.5, 8.5);
        assert.deepEqual(opened, []);
    });

    test('below sea level clamps to 0 and a void reads 0', async () => {
        const sampler = createPointSampler({
            openCopernicus: async (where, lat) => fakeImage(3600, () => (lat === 31 ? NaN : -80))
        });
        assert.equal(await sampler.copernicusPoint('remote', 36.25, -116.8), 0);
        assert.equal(await sampler.copernicusPoint('remote', 31.5, 35.5), 0);
    });

    test('twenty simultaneous lookups open the tile once and read each block once', async () => {
        const log = { blocks: [] };
        let opens = 0;
        const sampler = createPointSampler({
            openCopernicus: async () => {
                opens++;
                await new Promise(resolve => setTimeout(resolve, 10));
                return fakeImage(3600, (row, x) => row + x, log);
            }
        });
        const points = [];
        for (let n = 0; n < 20; n++) {
            points.push(sampler.copernicusPoint('remote', 30.9 - n * 0.001, -102.9 + n * 0.001));
        }
        const heights = await Promise.all(points);
        assert.equal(opens, 1);
        assert.deepEqual(log.blocks, ['0,0']);
        assert.ok(heights.every(Number.isFinite));
    });

    test('keeps no more decoded blocks than its limit', async () => {
        const log = { blocks: [] };
        const sampler = createPointSampler({
            openCopernicus: async () => fakeImage(3600, (row, x) => row + x, log),
            maxBlocks: 2
        });
        const at = (row, col) => sampler.copernicusPoint('remote', 31 - (row + 0.5) / 3600, -103 + (col + 0.5) / 3600);
        await at(10, 10);       // block 0,0
        await at(10, 1500);     // block 1,0
        await at(10, 2500);     // block 2,0 pushes 0,0 out
        await at(10, 10);       // read again
        assert.deepEqual(log.blocks, ['0,0', '1,0', '2,0', '0,0']);
    });

    test('a missing tile and a failed open both answer null, and a failure is retried', async () => {
        let attempts = 0;
        const sampler = createPointSampler({
            openCopernicus: async (where) => {
                if (where === 'saved') return null;
                attempts++;
                if (attempts === 1) throw new Error('offline');
                return fakeImage(3600, () => 250);
            }
        });
        assert.equal(await sampler.copernicusPoint('saved', 30.5, -102.5), null);
        assert.equal(await sampler.copernicusPoint('remote', 30.5, -102.5), null);
        assert.equal(await sampler.copernicusPoint('remote', 30.5, -102.5), 250);
    });

    test('forgetTile makes the next lookup open the tile again', async () => {
        let opens = 0;
        const sampler = createPointSampler({
            openCopernicus: async () => {
                opens++;
                return fakeImage(3600, () => 100);
            }
        });
        await sampler.copernicusPoint('remote', 30.5, -102.5);
        await sampler.copernicusPoint('remote', 30.6, -102.5);
        assert.equal(opens, 1);
        sampler.forgetTile(30, -103);
        await sampler.copernicusPoint('remote', 30.5, -102.5);
        assert.equal(opens, 2);
    });
});

describe('SRTM points', () => {
    const heightAt = (r, c) => Math.round(600 + 250 * Math.sin(r / 41) + 150 * Math.cos(c / 29));

    test('matches hgtElevation', async () => {
        const bytes = srtmGrid(heightAt);
        const sampler = createPointSampler({ loadSrtmGrid: async () => makeHgtView(bytes) });
        const cache = { '44_-72': makeHgtView(bytes) };
        for (const [lat, lon] of [[44.27, -71.3], [44.999, -71.001], [44.0, -72.0], [44.5, -71.5]]) {
            assert.equal(await sampler.srtmPoint(lat, lon), hgtElevation(cache, 44, -72, lat, lon));
        }
    });

    test('a spike or a void next to the point answers null', async () => {
        const bytes = srtmGrid((r, c) => {
            if (r === 1000 && c === 1000) return 32767;
            if (r === 2000 && c === 2000) return -32768;
            return 300;
        });
        const sampler = createPointSampler({ loadSrtmGrid: async () => makeHgtView(bytes) });
        const at = (row, col) => sampler.srtmPoint(45 - row / 3600, -72 + col / 3600);
        assert.equal(await at(999.5, 999.5), null);
        assert.equal(await at(2000.2, 1999.9), null);
        assert.equal(await at(1500.5, 1500.5), 300);
    });

    test('no grid in the folder answers null, and simultaneous lookups load it once', async () => {
        let loads = 0;
        const bytes = srtmGrid(() => 120);
        const sampler = createPointSampler({
            loadSrtmGrid: async (lat) => {
                loads++;
                await new Promise(resolve => setTimeout(resolve, 5));
                return lat === 44 ? makeHgtView(bytes) : null;
            }
        });
        assert.equal(await sampler.srtmPoint(10.5, 10.5), null);
        loads = 0;
        const heights = await Promise.all(Array.from({ length: 20 }, (_, n) => sampler.srtmPoint(44.1 + n * 0.01, -71.5)));
        assert.equal(loads, 1);
        assert.ok(heights.every(height => height === 120));
    });
});
