// Planning for the Map Generator's offline data downloads: which 1° elevation
// cells and which map tiles a box or region needs, what is already in the
// offline folder, and how big and slow the rest will be. DOM-free; tested by
// tests/offline-regions.test.mjs.

import {
    CELL_INDEX_B64, CELL_INDEX_DATE,
    CELL_INDEX_SRTM_FILES, CELL_INDEX_SRTM_BYTES,
    CELL_INDEX_COPERNICUS_FILES, CELL_INDEX_COPERNICUS_BYTES,
} from './terrain_cell_index.js';
import {
    srtmTileName, srtmUrl, srtmLocalPath, copernicusTileStem, copernicusUrl, copernicusLocalPath,
    estimateDatSizeMB,
} from './terrain_elevation.js';

export const SOURCES = ['srtm', 'copernicus'];
const CELLS = 180 * 360;

// ─── Cell index ───────────────────────────────────────────────────────────────

export function decodeCellIndex(b64) {
    const bin = atob(b64);
    if (bin.length !== CELLS * 4) throw new Error('cell index has the wrong size');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const all = new Uint16Array(CELLS * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < all.length; i++) all[i] = dv.getUint16(i * 2, true);
    return { srtm: all.subarray(0, CELLS), copernicus: all.subarray(CELLS) };
}

let bundledIndex = null;
export function cellIndex() {
    if (!bundledIndex) bundledIndex = decodeCellIndex(CELL_INDEX_B64);
    return bundledIndex;
}

export const CELL_INDEX_INFO = {
    date: CELL_INDEX_DATE,
    srtm: { files: CELL_INDEX_SRTM_FILES, bytes: CELL_INDEX_SRTM_BYTES },
    copernicus: { files: CELL_INDEX_COPERNICUS_FILES, bytes: CELL_INDEX_COPERNICUS_BYTES },
};

function cellSlot(lat, lon) {
    return (lat + 90) * 360 + (lon + 180);
}

// Size in bytes (from KB, so within 1 KB) of the source's file for a cell; 0 when
// the source has no file there (sea).
export function cellFileBytes(source, lat, lon, index = cellIndex()) {
    return index[source][cellSlot(lat, lon)] * 1024;
}

export function hasCellFile(source, lat, lon, index = cellIndex()) {
    return index[source][cellSlot(lat, lon)] > 0;
}

// ─── Cells ────────────────────────────────────────────────────────────────────

export function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

export function cellKey(cell) {
    return cell.lat + '_' + cell.lon;
}

// 1° cells (south-west corners) touched by a box, as the Map Generator has
// always picked them: floor() of each edge. Longitudes past ±180 (a map that
// was panned around the world) wrap; a box wider than 360° is the whole band.
export function cellsForBounds(south, west, north, east) {
    const latMin = Math.max(-90, Math.floor(south));
    const latMax = Math.min(89, Math.floor(north));
    let lonMin = Math.floor(west);
    let lonMax = Math.floor(east);
    if (lonMax - lonMin >= 359) { lonMin = -180; lonMax = 179; }
    const cells = [];
    for (let lat = latMin; lat <= latMax; lat++) {
        for (let lon = lonMin; lon <= lonMax; lon++) {
            cells.push({ lat, lon: wrapLon(lon) });
        }
    }
    return cells;
}

// Cells of a region preset or any inclusive cell range.
export function cellsForRange({ lat0, lat1, lon0, lon1 }) {
    const cells = [];
    for (let lat = lat0; lat <= lat1; lat++) {
        for (let lon = lon0; lon <= lon1; lon++) cells.push({ lat, lon });
    }
    return cells;
}

// The cells whose elevation files a set of .TER cells needs: each cell plus its
// E, N and NE neighbours (a .TER file overshoots its square to the north and
// east). Copernicus also needs S and SE: a GeoTIFF has no row for its own south
// edge, so the grid's last row (and the SE corner) is read from the tiles below.
// SRTM .hgt files carry their own edges. No duplicates; order follows the input.
export function withNeighbours(cells, source = 'srtm') {
    const seen = new Set();
    const out = [];
    const add = (lat, lon) => {
        if (lat > 89) return;
        const c = { lat, lon: wrapLon(lon) };
        const k = cellKey(c);
        if (seen.has(k)) return;
        seen.add(k);
        out.push(c);
    };
    for (const c of cells) {
        add(c.lat, c.lon);
        add(c.lat, c.lon + 1);
        add(c.lat + 1, c.lon);
        add(c.lat + 1, c.lon + 1);
        if (source === 'copernicus' && c.lat > -90) {
            add(c.lat - 1, c.lon);
            add(c.lat - 1, c.lon + 1);
        }
    }
    return out;
}

// ─── Region presets ───────────────────────────────────────────────────────────
// Inclusive 1° cell ranges (south-west corners). Regions overlap at the edges
// on purpose; only cells with land data are downloaded, so the boxes can be
// generous. imageryZoom is the default imagery depth: deep enough to find a
// flying site, shallow enough to stay a few GB.
export const REGIONS = [
    { id: 'globe', name: 'Whole globe', lat0: -90, lat1: 89, lon0: -180, lon1: 179, imageryZoom: 7 },
    { id: 'north_america', name: 'North America (with Greenland)', lat0: 14, lat1: 83, lon0: -180, lon1: -12, imageryZoom: 9 },
    { id: 'usa48', name: 'United States (lower 48)', lat0: 24, lat1: 49, lon0: -125, lon1: -67, imageryZoom: 10 },
    { id: 'central_america', name: 'Central America & Caribbean', lat0: 5, lat1: 26, lon0: -93, lon1: -59, imageryZoom: 10 },
    { id: 'south_america', name: 'South America', lat0: -56, lat1: 13, lon0: -82, lon1: -34, imageryZoom: 9 },
    { id: 'europe', name: 'Europe', lat0: 34, lat1: 71, lon0: -25, lon1: 44, imageryZoom: 9 },
    { id: 'africa', name: 'Africa', lat0: -35, lat1: 37, lon0: -26, lon1: 52, imageryZoom: 9 },
    { id: 'middle_east', name: 'Middle East', lat0: 12, lat1: 42, lon0: 25, lon1: 63, imageryZoom: 9 },
    { id: 'north_asia', name: 'Russia & Central Asia', lat0: 35, lat1: 78, lon0: 44, lon1: 179, imageryZoom: 8 },
    { id: 'south_east_asia', name: 'South & East Asia', lat0: -11, lat1: 54, lon0: 60, lon1: 150, imageryZoom: 9 },
    { id: 'oceania', name: 'Australia, New Zealand & Pacific', lat0: -48, lat1: -1, lon0: 110, lon1: 179, imageryZoom: 9 },
    { id: 'antarctica', name: 'Antarctica', lat0: -90, lat1: -60, lon0: -180, lon1: 179, imageryZoom: 6 },
];

export const BOX_IMAGERY_ZOOM = 12;

export function regionById(id) {
    return REGIONS.find(r => r.id === id) || null;
}

// ─── Map tiles (Web Mercator, as Leaflet and the tile servers number them) ───

const MAX_MERCATOR_LAT = 85.0511287798;

export function lonToTileX(lon, z) {
    const n = 2 ** z;
    return Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
}

export function latToTileY(lat, z) {
    const n = 2 ** z;
    const φ = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2 * n);
    return Math.min(n - 1, Math.max(0, y));
}

// Tile ranges covering a box, one entry per zoom: { z, x0, x1, y0, y1, count }.
// A box crossing the 180° meridian (west > east after wrapping) yields two
// entries for that zoom.
export function tileRanges(south, west, north, east, zMin, zMax) {
    const ranges = [];
    const whole = east - west >= 360;
    const w = whole ? -180 : wrapLon(west);
    const e = whole ? 180 - 1e-9 : wrapLon(east);
    const spans = (!whole && w > e) ? [[w, 180 - 1e-9], [-180, e]] : [[w, e]];
    for (let z = zMin; z <= zMax; z++) {
        const y0 = latToTileY(north, z);
        const y1 = latToTileY(south, z);
        for (const [a, b] of spans) {
            const x0 = lonToTileX(a, z);
            const x1 = lonToTileX(b, z);
            ranges.push({ z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) });
        }
    }
    return ranges;
}

export function* tilesInRanges(ranges) {
    for (const r of ranges) {
        for (let x = r.x0; x <= r.x1; x++) {
            for (let y = r.y0; y <= r.y1; y++) yield { z: r.z, x, y };
        }
    }
}

// Imagery layers the downloader can fetch. Esri only: OpenStreetMap's tile
// policy forbids bulk downloads, and Google's terms forbid storing tiles.
export const IMAGERY_LAYERS = {
    esri_satellite: {
        provider: 'ESRI', type: 'Satellite', ext: 'jpg', avgBytes: 20 * 1024,
        url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    },
    esri_street: {
        provider: 'ESRI', type: 'Street', ext: 'jpg', avgBytes: 15 * 1024,
        url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
    },
    esri_labels: {
        provider: 'ESRI', type: 'Labels', ext: 'png', avgBytes: 10 * 1024,
        url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
    },
};

export function imageryLocalPath(provider, type, z, x, y, ext) {
    return `imagery/${provider}/${type}/${z}/${x}/${y}.${ext}`;
}

// ─── Elevation files ──────────────────────────────────────────────────────────

export function elevationFile(source, lat, lon) {
    if (source === 'copernicus') {
        return { name: copernicusTileStem(lat, lon), url: copernicusUrl(lat, lon), path: copernicusLocalPath(lat, lon) };
    }
    return { name: srtmTileName(lat, lon), url: srtmUrl(lat, lon), path: srtmLocalPath(lat, lon) };
}

// File name (without folder) of each source's local file, for matching the
// offline folder's listing against cells.
export function elevationFileName(source, lat, lon) {
    const p = elevationFile(source, lat, lon).path;
    return p.slice(p.lastIndexOf('/') + 1);
}

// ─── Plans ────────────────────────────────────────────────────────────────────

const terMBByLat = new Map();
function terBytes(lat) {
    if (!terMBByLat.has(lat)) terMBByLat.set(lat, estimateDatSizeMB(lat));
    return terMBByLat.get(lat) * 1048576;
}

// What a download of `cells` (the .TER cells the user wants) needs.
//   present: { srtm: Set<fileName>, copernicus: Set<fileName> } from the folder
//   imagery: { south, west, north, east, zMax, layers: [layer ids] } or null
//   bytesPerSecond: for the time estimate
// Elevation totals are given for both sources, so the dialog can show the one
// not selected too. Only cells the index lists are counted: the rest are sea
// and need no file. (SRTM has a file for every cell; Copernicus only for land.)
export function planDownload({ cells, present, imagery, bytesPerSecond, index = cellIndex() }) {
    const elevation = {};
    for (const source of SOURCES) {
        const needed = withNeighbours(cells, source);
        const have = present?.[source] || new Set();
        let files = 0, presentCount = 0, missingBytes = 0, totalBytes = 0;
        const missing = [];
        for (const c of needed) {
            const bytes = cellFileBytes(source, c.lat, c.lon, index);
            if (!bytes) continue;
            files++;
            totalBytes += bytes;
            if (have.has(elevationFileName(source, c.lat, c.lon))) {
                presentCount++;
            } else {
                missingBytes += bytes;
                missing.push(c);
            }
        }
        elevation[source] = { cells: needed.length, files, present: presentCount, missing, missingBytes, totalBytes };
    }

    let imageryPlan = null;
    if (imagery && imagery.layers?.length) {
        const ranges = tileRanges(imagery.south, imagery.west, imagery.north, imagery.east, 0, imagery.zMax);
        const tiles = ranges.reduce((s, r) => s + r.count, 0);
        const perTile = imagery.layers.reduce((s, id) => s + IMAGERY_LAYERS[id].avgBytes, 0);
        imageryPlan = { ranges, tiles, files: tiles * imagery.layers.length, bytes: tiles * perTile, zMax: imagery.zMax, layers: imagery.layers };
    }

    // .TER output if every cell were generated. SRTM has a file (sea level over
    // water) for every cell; Copernicus skips cells it has no tile for.
    const terTotal = { srtm: 0, copernicus: 0 };
    for (const c of cells) {
        for (const source of SOURCES) {
            if (cellFileBytes(source, c.lat, c.lon, index)) terTotal[source] += terBytes(c.lat);
        }
    }

    const rate = bytesPerSecond > 0 ? bytesPerSecond : 12.5e6;
    const secondsFor = source => (elevation[source].missingBytes + (imageryPlan?.bytes || 0)) / rate;

    return {
        cells: cells.length,
        elevation,
        imagery: imageryPlan,
        terBytes: terTotal,
        seconds: { srtm: secondsFor('srtm'), copernicus: secondsFor('copernicus') },
    };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatBytes(bytes) {
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
    return bytes + ' B';
}

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 60) return 'under a minute';
    const m = Math.round(seconds / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h ' + (m % 60) + ' min';
    return Math.round(h / 24) + ' days';
}
