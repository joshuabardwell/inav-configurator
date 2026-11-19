import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cellIndex, cellFileBytes, hasCellFile, CELL_INDEX_INFO,
    cellsForBounds, cellsForRange, withNeighbours, wrapLon,
    REGIONS, regionById, lonToTileX, latToTileY, tileRanges, tilesInRanges,
    elevationFile, elevationFileName, imageryLocalPath, planDownload, formatBytes, formatDuration,
} from '../js/offline_regions.js';

const keys = cells => cells.map(c => `${c.lat}_${c.lon}`);

test('bundled cell index matches its recorded totals', () => {
    const index = cellIndex();
    for (const source of ['srtm', 'copernicus']) {
        let files = 0;
        let kb = 0;
        for (const v of index[source]) {
            if (v) { files++; kb += v; }
        }
        assert.equal(files, CELL_INDEX_INFO[source].files, source);
        // Sizes are rounded up to whole KB, so the sum is within 1 KB per file.
        const bytes = CELL_INDEX_INFO[source].bytes;
        assert.ok(kb * 1024 >= bytes && kb * 1024 - bytes < files * 1024, source);
    }
    assert.equal(CELL_INDEX_INFO.copernicus.files, 26450);
});

test('index knows land from sea for Copernicus', () => {
    assert.ok(hasCellFile('copernicus', 42, -72));        // Massachusetts
    assert.ok(!hasCellFile('copernicus', 30, -40));       // mid-Atlantic
    assert.ok(cellFileBytes('copernicus', 42, -72) > 1e6);
    assert.ok(hasCellFile('srtm', 30, -40));              // SRTM has a (sea-level) file everywhere
});

test('cellsForBounds picks floor() cells, across the 0° lines', () => {
    assert.deepEqual(keys(cellsForBounds(-0.5, -0.5, 0.5, 0.5)), ['-1_-1', '-1_0', '0_-1', '0_0']);
    assert.deepEqual(keys(cellsForBounds(42.2, -72.8, 42.9, -72.1)), ['42_-73']);
});

test('cellsForBounds wraps past the 180° meridian', () => {
    assert.deepEqual(keys(cellsForBounds(10.2, 179.5, 10.4, 180.5)), ['10_179', '10_-180']);
    assert.deepEqual(keys(cellsForBounds(10.2, -180.5, 10.4, -179.5)), ['10_179', '10_-180']);
    assert.equal(cellsForBounds(0.1, -400, 0.2, 400).length, 360);
    assert.equal(wrapLon(180), -180);
    assert.equal(wrapLon(-181), 179);
});

test('withNeighbours adds E, N and NE once, wraps east and stops at 89°N', () => {
    assert.deepEqual(keys(withNeighbours([{ lat: 42, lon: -72 }])), ['42_-72', '42_-71', '43_-72', '43_-71']);
    assert.deepEqual(keys(withNeighbours([{ lat: 10, lon: 179 }])), ['10_179', '10_-180', '11_179', '11_-180']);
    assert.deepEqual(keys(withNeighbours([{ lat: 89, lon: 0 }])), ['89_0', '89_1']);
    assert.equal(withNeighbours(cellsForRange({ lat0: 0, lat1: 1, lon0: 0, lon1: 1 })).length, 9);
});

test('Copernicus also needs the S and SE neighbours, except at 90°S', () => {
    assert.deepEqual(keys(withNeighbours([{ lat: 42, lon: -72 }], 'copernicus')),
        ['42_-72', '42_-71', '43_-72', '43_-71', '41_-72', '41_-71']);
    assert.equal(withNeighbours([{ lat: -90, lon: 0 }], 'copernicus').length, 4);
});

test('region presets are valid cell ranges with unique ids', () => {
    const ids = new Set();
    for (const r of REGIONS) {
        assert.ok(!ids.has(r.id));
        ids.add(r.id);
        assert.ok(r.lat0 >= -90 && r.lat1 <= 89 && r.lat0 <= r.lat1, r.id);
        assert.ok(r.lon0 >= -180 && r.lon1 <= 179 && r.lon0 <= r.lon1, r.id);
        assert.ok(r.imageryZoom >= 0 && r.imageryZoom <= 12, r.id);
    }
    assert.equal(regionById('globe').lat0, -90);
    assert.equal(regionById('nope'), null);
});

test('whole-globe plan covers every source file', () => {
    const p = planDownload({ cells: cellsForRange(regionById('globe')), present: null, imagery: null });
    assert.equal(p.elevation.copernicus.files, CELL_INDEX_INFO.copernicus.files);
    assert.equal(p.elevation.srtm.files, CELL_INDEX_INFO.srtm.files);
});

test('each preset stays a few GB of imagery at its default depth', () => {
    for (const r of REGIONS) {
        const p = planDownload({
            cells: [], present: null,
            imagery: { south: r.lat0, west: r.lon0, north: r.lat1 + 1, east: r.lon1 + 1, zMax: r.imageryZoom, layers: ['esri_satellite'] },
        });
        assert.ok(p.imagery.bytes < 2e9, `${r.id}: ${formatBytes(p.imagery.bytes)}`);
    }
});

test('Web Mercator tile numbers match known values', () => {
    assert.equal(lonToTileX(-180, 1), 0);
    assert.equal(lonToTileX(0, 1), 1);
    assert.equal(lonToTileX(180, 3), 7);
    assert.equal(latToTileY(0, 1), 1);
    assert.equal(latToTileY(89.9, 4), 0);
    assert.equal(latToTileY(-89.9, 4), 15);
    // Boston, zoom 12
    assert.equal(lonToTileX(-71.06, 12), 1239);
    assert.equal(latToTileY(42.36, 12), 1514);
});

test('tileRanges counts tiles per zoom and splits at the 180° meridian', () => {
    const world = tileRanges(-90, -180, 90, 180, 0, 2);
    assert.deepEqual(world.map(r => r.count), [1, 4, 16]);
    const crossing = tileRanges(-1, 179, 1, 181, 3, 3);
    assert.equal(crossing.length, 2);
    assert.deepEqual(crossing.map(r => [r.x0, r.x1]), [[7, 7], [0, 0]]);
    assert.equal([...tilesInRanges(world)].length, 21);
});

test('file names and folder paths', () => {
    assert.deepEqual(elevationFile('srtm', 42, -72), {
        name: 'N42W072',
        url: 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/N42/N42W072.hgt.gz',
        path: 'elevation/srtm/N42W072.hgt.gz',
    });
    assert.equal(elevationFile('copernicus', -1, 5).path,
        'elevation/copernicus/Copernicus_DSM_COG_10_S01_00_E005_00_DEM.tif');
    assert.equal(elevationFileName('srtm', -34, 151), 'S34E151.hgt.gz');
    assert.equal(imageryLocalPath('ESRI', 'Satellite', 12, 1239, 1514, 'jpg'), 'imagery/ESRI/Satellite/12/1239/1514.jpg');
});

test('planDownload separates present from missing files', () => {
    const cells = [{ lat: 42, lon: -72 }];
    const present = { srtm: new Set(['N42W072.hgt.gz', 'N43W071.hgt.gz']), copernicus: new Set() };
    const p = planDownload({
        cells, present, bytesPerSecond: 1e6,
        imagery: { south: 42, west: -72, north: 43, east: -71, zMax: 0, layers: ['esri_satellite', 'esri_labels'] },
    });
    assert.equal(p.elevation.srtm.cells, 4);
    assert.equal(p.elevation.copernicus.cells, 6);
    assert.equal(p.elevation.srtm.files, 4);
    assert.equal(p.elevation.srtm.present, 2);
    assert.deepEqual(keys(p.elevation.srtm.missing), ['42_-71', '43_-72']);
    assert.equal(p.elevation.srtm.missingBytes,
        cellFileBytes('srtm', 42, -71) + cellFileBytes('srtm', 43, -72));
    assert.equal(p.elevation.copernicus.present, 0);
    assert.equal(p.imagery.tiles, 1);
    assert.equal(p.imagery.files, 2);
    assert.ok(p.terBytes.srtm > 30e6 && p.terBytes.srtm < 33e6);
    const expectSeconds = (p.elevation.srtm.missingBytes + p.imagery.bytes) / 1e6;
    assert.equal(p.seconds.srtm, expectSeconds);
});

test('formatting', () => {
    assert.equal(formatBytes(589.2e9), '589.2 GB');
    assert.equal(formatBytes(1.77e12), '1.77 TB');
    assert.equal(formatBytes(22e6), '22 MB');
    assert.equal(formatDuration(30), 'under a minute');
    assert.equal(formatDuration(3 * 3600 + 5 * 60), '3 h 5 min');
    assert.equal(formatDuration(5 * 86400), '5 days');
});
