import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCellTer, pruneImageCache, TerSource, TER_GENERATOR_VERSION } from '../js/terrain_build.js';
import { MissingElevationError } from '../js/terrain_elevation.js';
import { terHeightFromTile, terTileDimensions, TERRAIN_IO_BLOCK } from '../js/terrain_ter.js';

// Loaders that record how they were called and hand back a marker "grid".
function fakeDeps(overrides = {}) {
    const calls = [];
    return {
        calls,
        deps: {
            ensureCopernicus: async (lat, lon, runCache, imgCache, statusCb, io) => {
                calls.push({ loader: 'copernicus', lat, lon, imgCache, io });
                statusCb('downloading');
                statusCb('decoding', 1000);
                statusCb('grid', 600, 3600);
                statusCb('edges');
                return { marker: 'copernicus' };
            },
            ensureSrtm: async (lat, lon, runCache, io, statusCb) => {
                calls.push({ loader: 'srtm', lat, lon, io });
                statusCb('connecting');
                statusCb('downloading');
                statusCb('downloaded', 5);
                return { marker: 'srtm' };
            },
            createDat: async (lat, lon, grids, progress) => {
                calls.push({ loader: 'pack', lat, lon, grids });
                progress(1, 2);
                progress(2, 2);
                return new Uint8Array([lat & 0xff, lon & 0xff]);
            },
            ...overrides
        }
    };
}

test('the generator version is a positive whole number', () => {
    assert.ok(Number.isInteger(TER_GENERATOR_VERSION) && TER_GENERATOR_VERSION >= 1);
});

test('a land cell is built from Copernicus and reports its stages', async () => {
    const { calls, deps } = fakeDeps();
    const stages = [];
    const imgCache = {};
    const out = await buildCellTer(47, 8, { imgCache, deps, onStage: (...a) => stages.push(a) });
    assert.equal(out.name, 'N47E008.TER');
    assert.equal(out.source, TerSource.COPERNICUS);
    assert.deepEqual([...out.bytes], [47, 8]);
    assert.deepEqual(calls.map(c => c.loader), ['copernicus', 'pack']);
    assert.equal(calls[0].imgCache, imgCache);
    assert.equal(calls[0].io.hasFile('copernicus', 0, -140), false);
    assert.deepEqual(calls[1].grids, { marker: 'copernicus' });
    assert.deepEqual(stages, [
        ['downloading', undefined, undefined],
        ['decoding', 1000, undefined],
        ['grid', 600, 3600],
        ['edges', undefined, undefined],
        ['packing', 1, 2],
        ['packing', 2, 2]
    ]);
});

test('land Copernicus leaves out is built from SRTM', async () => {
    const { calls, deps } = fakeDeps();
    const stages = [];
    const out = await buildCellTer(40, 44, { deps, onStage: name => stages.push(name) });
    assert.equal(out.name, 'N40E044.TER');
    assert.equal(out.source, TerSource.SRTM);
    assert.deepEqual(calls.map(c => c.loader), ['srtm', 'pack']);
    assert.deepEqual(calls[1].grids, { marker: 'srtm' });
    assert.deepEqual(stages, ['downloading', 'packing', 'packing']);    // loader details are not stages
});

test('an all-sea cell gets a sea-level file with no download', async () => {
    const { calls, deps } = fakeDeps();
    const out = await buildCellTer(0, -140, { deps });
    assert.equal(out.name, 'N00W140.TER');
    assert.equal(out.source, TerSource.SEA);
    assert.deepEqual(calls.map(c => c.loader), ['pack']);
    assert.deepEqual(calls[0].grids, {});
});

test('a real sea-level file is full size and reads 0 m everywhere', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('a sea cell must not download'); };
    try {
        const out = await buildCellTer(80, -140);       // high latitude: a small file
        assert.equal(out.source, TerSource.SEA);
        const { numX, numY } = terTileDimensions(80, -140);
        assert.equal(out.bytes.length, numX * numY * TERRAIN_IO_BLOCK);
        for (const [lat, lon] of [[80.0001, -139.9999], [80.5, -139.5], [80.9999, -139.0001]]) {
            assert.equal(terHeightFromTile(out.bytes, Math.round(lat * 1e7), Math.round(lon * 1e7)), 0);
        }
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a tile the server turns out not to have makes a sea-level file', async () => {
    const { calls, deps } = fakeDeps({ ensureCopernicus: async () => null });
    const out = await buildCellTer(47, 8, { deps });
    assert.equal(out.source, TerSource.SEA);
    assert.deepEqual(calls[0].grids, {});
});

test('data that could not be downloaded fails the build', async () => {
    const { calls, deps } = fakeDeps({
        ensureCopernicus: async () => { throw new MissingElevationError('N47E008', new Error('HTTP 503')); }
    });
    await assert.rejects(buildCellTer(47, 8, { deps }), MissingElevationError);
    assert.deepEqual(calls.map(c => c.loader), []);     // nothing was packed
});

test('an abort stops before, during and after the download', async () => {
    const before = new AbortController();
    before.abort();
    const first = fakeDeps();
    await assert.rejects(buildCellTer(47, 8, { deps: first.deps, signal: before.signal }), { name: 'AbortError' });
    assert.deepEqual(first.calls, []);

    const during = new AbortController();
    const second = fakeDeps();
    await assert.rejects(buildCellTer(47, 8, {
        deps: second.deps,
        signal: during.signal,
        onStage: name => { if (name === 'grid') during.abort(); }
    }), { name: 'AbortError' });
    assert.deepEqual(second.calls.map(c => c.loader), ['copernicus']);
    assert.equal(second.calls[0].io.signal, during.signal);

    const packing = new AbortController();
    const third = fakeDeps();
    await assert.rejects(buildCellTer(47, 8, {
        deps: third.deps,
        signal: packing.signal,
        onStage: (name, done) => { if (name === 'packing' && done === 1) packing.abort(); }
    }), { name: 'AbortError' });
});

test('pruneImageCache keeps the newest whole and open tiles', () => {
    const cache = {
        '47_8': { full: true }, '47_9': { full: false }, '48_8': null,
        '47_7': { full: true }, '46_8': { full: false }, '47_6': { full: true }
    };
    pruneImageCache(cache, 2, 1);
    assert.deepEqual(Object.keys(cache).sort(), ['46_8', '47_6', '47_7', '48_8']);
});
