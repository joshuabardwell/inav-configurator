import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cellIndex, cellFileBytes, hasCellFile, terSourceForCell, cellBuildEstimate, CELL_INDEX_INFO,
    cellsForBounds, cellsForRange, wrapLon,
    REGIONS, regionById, lonToTileX, latToTileY, tileRanges, tilesInRanges,
    imageryLocalPath, imageryTotalsByZoom, planDownload, formatBytes, formatDuration,
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

test('terSourceForCell: Copernicus for land, SRTM for the land it leaves out, null for sea', () => {
    assert.equal(terSourceForCell(47, 8), 'copernicus');        // Switzerland
    assert.equal(terSourceForCell(-34, 151), 'copernicus');     // Sydney coast
    assert.equal(terSourceForCell(40, 44), 'srtm');             // Yerevan
    assert.equal(terSourceForCell(40, 49), 'srtm');             // Baku
    assert.equal(terSourceForCell(40, 50), 'srtm');             // Absheron peninsula, a small SRTM file
    assert.equal(terSourceForCell(0, -140), null);              // Pacific
    // Open ocean whose SRTM file is large (sea-floor depths), outside the left-out box
    assert.ok(cellFileBytes('srtm', -43, 42) > 5e6);
    assert.equal(terSourceForCell(-43, 42), null);
    // Every cell without a Copernicus file is sea except those in the box
    let srtmCells = 0;
    for (let lat = -90; lat <= 89; lat++) {
        for (let lon = -180; lon <= 179; lon++) {
            if (terSourceForCell(lat, lon) === 'srtm') srtmCells++;
        }
    }
    assert.equal(srtmCells, 25);
});

test('cellBuildEstimate: what a build downloads and how big the file is', () => {
    const land = cellBuildEstimate(47, 8);
    assert.equal(land.source, 'copernicus');
    assert.equal(land.downloadBytes, Math.round(cellFileBytes('copernicus', 47, 8) * 1.5));
    assert.ok(land.terBytes > 27e6 && land.terBytes < 30e6);

    const leftOut = cellBuildEstimate(40, 44);
    assert.equal(leftOut.source, 'srtm');
    assert.equal(leftOut.downloadBytes, cellFileBytes('srtm', 40, 44) + cellFileBytes('srtm', 40, 45) +
        cellFileBytes('srtm', 41, 44) + cellFileBytes('srtm', 41, 45));

    const sea = cellBuildEstimate(0, -140);
    assert.deepEqual([sea.source, sea.downloadBytes], ['sea', 0]);
    assert.ok(sea.terBytes > 42e6 && sea.terBytes < 43e6);      // a sea-level file is full size
    assert.equal(cellBuildEstimate(-34, 150).terBytes, 35553280);
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

test('planDownload counts terrain files, leaves out the ones in the folder, and skips sea unless asked', () => {
    const cells = [{ lat: 47, lon: 8 }, { lat: 47, lon: 9 }, { lat: 40, lon: 44 }, { lat: 0, lon: -140 }];
    const present = new Set(['N47E008.TER']);
    const p = planDownload({
        cells, present, bytesPerSecond: 1e6,
        imagery: { south: 42, west: -72, north: 43, east: -71, zMax: 0, layers: ['esri_satellite', 'esri_labels'] },
    });
    assert.equal(p.cells, 4);
    assert.equal(p.terrain.files, 3);
    assert.equal(p.terrain.present, 1);
    assert.equal(p.terrain.sea, 1);
    assert.deepEqual(keys(p.terrain.missing), ['47_9', '40_44']);
    assert.equal(p.terrain.downloadBytes, cellBuildEstimate(47, 9).downloadBytes + cellBuildEstimate(40, 44).downloadBytes);
    assert.equal(p.terrain.terBytes, cellBuildEstimate(47, 9).terBytes + cellBuildEstimate(40, 44).terBytes);
    assert.equal(p.terrain.totalTerBytes, p.terrain.terBytes + cellBuildEstimate(47, 8).terBytes);
    assert.equal(p.imagery.tiles, 1);
    assert.equal(p.imagery.files, 2);
    assert.equal(p.seconds, (p.terrain.downloadBytes + p.imagery.bytes) / 1e6 + 2 * 6);

    const box = planDownload({ cells, present, includeSea: true, imagery: null });
    assert.equal(box.terrain.files, 4);
    assert.equal(box.terrain.sea, 0);
    assert.deepEqual(keys(box.terrain.missing), ['47_9', '40_44', '0_-140']);
    assert.equal(box.terrain.downloadBytes, p.terrain.downloadBytes);      // the sea file downloads nothing
    assert.equal(box.terrain.terBytes, p.terrain.terBytes + cellBuildEstimate(0, -140).terBytes);
    assert.equal(box.imagery, null);
});

test('whole-globe plan builds a file for every land cell', () => {
    const p = planDownload({ cells: cellsForRange(regionById('globe')), present: null, imagery: null });
    assert.equal(p.terrain.files, CELL_INDEX_INFO.copernicus.files + 25);
    assert.equal(p.terrain.files + p.terrain.sea, 180 * 360);
    assert.equal(p.terrain.missing.length, p.terrain.files);
});

test('imagery folder paths', () => {
    assert.equal(imageryLocalPath('ESRI', 'Satellite', 12, 1239, 1514, 'jpg'), 'imagery/ESRI/Satellite/12/1239/1514.jpg');
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

test('formatting', () => {
    assert.equal(formatBytes(589.2e9), '589.2 GB');
    assert.equal(formatBytes(1.77e12), '1.77 TB');
    assert.equal(formatBytes(22e6), '22 MB');
    assert.equal(formatDuration(30), 'under a minute');
    assert.equal(formatDuration(3 * 3600 + 5 * 60), '3 h 5 min');
    assert.equal(formatDuration(5 * 86400), '5 days');
});

test('imageryTotalsByZoom adds up from zoom 0 and matches planDownload', () => {
    const r = regionById('usa48');
    const bounds = { south: r.lat0, west: r.lon0, north: r.lat1 + 1, east: r.lon1 + 1 };
    const layers = ['esri_satellite', 'esri_labels'];
    const totals = imageryTotalsByZoom(bounds, layers, 12);
    assert.equal(totals.length, 13);
    assert.equal(totals[0].tiles, 1);
    for (let z = 1; z <= 12; z++) assert.ok(totals[z].tiles > totals[z - 1].tiles);
    for (const z of [0, 5, 12]) {
        const p = planDownload({ cells: [], present: null, imagery: { ...bounds, zMax: z, layers } });
        assert.equal(totals[z].tiles, p.imagery.tiles, `z${z}`);
        assert.equal(totals[z].bytes, p.imagery.bytes, `z${z}`);
    }
    // A box across the 180° meridian counts both halves.
    const wrap = imageryTotalsByZoom({ south: -20, west: 170, north: -10, east: 190 }, ['esri_satellite'], 6);
    const p = planDownload({ cells: [], present: null, imagery: { south: -20, west: 170, north: -10, east: 190, zMax: 6, layers: ['esri_satellite'] } });
    assert.equal(wrap[6].tiles, p.imagery.tiles);
    // No layers: tiles are counted, bytes are zero.
    assert.equal(imageryTotalsByZoom(bounds, [], 3)[3].bytes, 0);
});
