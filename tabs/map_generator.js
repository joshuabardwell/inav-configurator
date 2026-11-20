'use strict';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw'; // for L.GeometryUtil.geodesicArea
import 'leaflet-control-geocoder';
import 'leaflet-control-geocoder/dist/Control.Geocoder.css';

import jBox from 'jbox';
import GUI, { TABS } from './../js/gui';
import i18n from './../js/localization';
import store from './../js/store';
import {
    offlineFolderAvailable, offlineFolderDefaultDir, offlineFolderDir, offlineFolderPath,
    offlineFolderRead, offlineFolderWrite
} from './../js/offline_folder.js';
import { globalSettings, UnitType } from './../js/globalSettings';
import JSZip from 'jszip';
import { terrainDatFilename } from './../js/terrain_ter.js';
import {
    srtmTileName, estimateDatSizeMB, createDatFromHgt, ensureSrtmCellData,
    COPERNICUS_NOTICE_1, COPERNICUS_NOTICE_2, TERRAIN_ATTR_SRTM, TERRAIN_ATTR_COPERNICUS,
    copernicusNoticeText, COPERNICUS_CACHE_PREFIX, HGT_GRID_BYTES, ensureCopernicusCellData,
    MissingElevationError,
} from './../js/terrain_elevation.js';
import {
    cellsForBounds, cellsForRange, withNeighbours, cellKey, hasCellFile, cellFileBytes, elevationFile, elevationFileName,
    REGIONS, regionById, BOX_IMAGERY_ZOOM, IMAGERY_LAYERS, imageryLocalPath, tilesInRanges,
    imageryTotalsByZoom, planDownload, formatBytes, formatDuration, CELL_INDEX_INFO,
} from './../js/offline_regions.js';

// Fix Leaflet default marker icon paths (broken by bundlers)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
    iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
    shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

TABS.map_generator = {};

// ─── Tile math ──────────────────────────────────────────────────────────
function lon2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
    return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
}

function calculateTiles(bounds, minZ, maxZ) {
    let total = 0;
    for (let z = minZ; z <= maxZ; z++) {
        const tz = z; // folder number = real slippy zoom (matches the widgets)
        total += (Math.abs(lon2tile(bounds.getWest(), tz) - lon2tile(bounds.getEast(), tz)) + 1) *
                 (Math.abs(lat2tile(bounds.getSouth(), tz) - lat2tile(bounds.getNorth(), tz)) + 1);
    }
    return total;
}

function buildTileList(bounds, minZ, maxZ) {
    const tiles = [];
    for (let z = minZ; z <= maxZ; z++) {
        const tz = z; // folder number = real slippy zoom (matches the widgets)
        const xMin = lon2tile(bounds.getWest(), tz);
        const xMax = lon2tile(bounds.getEast(), tz);
        const yMin = lat2tile(bounds.getNorth(), tz);
        const yMax = lat2tile(bounds.getSouth(), tz);
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                tiles.push({ z, tz, x, y });
            }
        }
    }
    return tiles;
}

function addTileToZip(zip, pathArr, buf) {
    let folder = zip;
    for (let i = 0; i < pathArr.length - 1; i++) {
        folder = folder.folder(pathArr[i]);
    }
    folder.file(pathArr.at(-1), new Uint8Array(buf));
}

async function tileExistsOnSD(fullPath) {
    try {
        const result = await globalThis.electronAPI.readFile(fullPath, null);
        return result && !result.error && result.data && result.data.byteLength > 128;
    } catch (_) {
        // File doesn't exist
        return false;
    }
}

// ─── Unit formatting ────────────────────────────────────────────────────
function formatDistance(meters, unit) {
    switch (unit) {
        case 'km2':
        case 'ha':
            return meters >= 1000 ? (meters / 1000).toFixed(2) + ' km' : Math.round(meters) + ' m';
        case 'mi2':
        case 'acre': {
            const mi = meters / 1609.344;
            return mi >= 1 ? mi.toFixed(2) + ' mi' : Math.round(meters * 3.28084) + ' ft';
        }
        default:
            return meters >= 1000 ? (meters / 1000).toFixed(2) + ' km' : Math.round(meters) + ' m';
    }
}

function formatArea(sqMeters, unit) {
    if (sqMeters === 0) return '0.00 ' + unit;
    switch (unit) {
        case 'km2':  return (sqMeters / 1000000).toFixed(2) + ' km²';
        case 'mi2':  return (sqMeters / 2589988.11).toFixed(2) + ' mi²';
        case 'ha':   return (sqMeters / 10000).toFixed(2) + ' ha';
        case 'acre': return (sqMeters / 4046.86).toFixed(2) + ' acre';
        default:     return sqMeters.toFixed(0) + ' m²';
    }
}

// ─── Tile URL resolution ────────────────────────────────────────────────
// z here is already 0-based (tile server zoom)
function getTileUrl(provider, mapType, z, x, y, maptilerKey = '') {
    if (provider === 'ESRI') {
        return mapType === 'Street'
            ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`
            : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }
    if (provider === 'OSM') {
        return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    }
    if (provider === 'MAPTILER') {
        const styleMap = { 'Satellite': 'satellite', 'Hybrid': 'hybrid', 'Street': 'streets-v2', 'OSM Style': 'openstreetmap', 'Outdoor': 'outdoor-v2', 'Topo': 'topo-v2', 'Winter': 'winter-v4' };
        const style = styleMap[mapType] || 'streets-v2';
        const pngTypes = new Set(['Street', 'OSM Style', 'Outdoor', 'Topo', 'Winter']);
        const ext   = pngTypes.has(mapType) ? 'png' : 'jpg';
        return `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}.${ext}?key=${maptilerKey}`;
    }
    // GOOGLE
    if (mapType === 'Satellite') return `https://mt1.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
    if (mapType === 'Hybrid')    return `https://mt1.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}`;
    return `https://mt1.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${z}`;
}

// ─── Yaapu display name helper ──────────────────────────────────────────
function getYaapuMapName(mapType) {
    if (mapType === 'Satellite') return 'GoogleSatelliteMap';
    if (mapType === 'Hybrid') return 'GoogleHybridMap';
    return 'GoogleMap';
}

// ─── Output path building ───────────────────────────────────────────────
function getTilePath({ target, isZipMode, provider, mapType, z, x, y, subtarget }) {
    const displayZoom = z.toString();

    if (target === 'b14ckyy') {
        const base = isZipMode ? ['ethosmaps', 'maps'] : ['bitmaps', 'ethosmaps', 'maps'];
        if (provider === 'ESRI') {
            return [...base, provider, mapType, displayZoom, `${y}`, `${x}.jpg`];
        }
        return [...base, provider, mapType, displayZoom, `${x}`, `${y}.jpg`];
    }

    // Yaapu — always uses Google-style folder names regardless of provider
    const yaapuMapName = getYaapuMapName(mapType);

    if (isZipMode) {
        // ZIP path is the same for both ETHOS and EdgeTX
        return ['yaapu', 'maps', yaapuMapName, displayZoom, `${y}`, `s_${x}.jpg`];
    }
    // SD path differs: ETHOS uses /bitmaps/, EdgeTX uses /IMAGES/
    const base = subtarget === 'edgetx'
        ? ['IMAGES', 'yaapu', 'maps']
        : ['bitmaps', 'yaapu', 'maps'];
    return [...base, yaapuMapName, displayZoom, `${y}`, `s_${x}.jpg`];
}

// ─── Image loading with timeout ─────────────────────────────────────────
function loadImage(url, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let finished = false;
        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            reject(new Error(`Image load timeout: ${url}`));
        }, timeoutMs);

        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve(img);
        };
        img.onerror = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(new Error(`Image load failed: ${url}`));
        };
        img.src = url;
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Canvas helpers ─────────────────────────────────────────────────────
function createWorkerCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    return { canvas, ctx: canvas.getContext('2d') };
}

function canvasToArrayBuffer(canvas, target) {
    const mimeType = 'image/jpeg';
    const quality = (target === 'b14ckyy') ? 0.7 : 0.8;
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) return reject(new Error('Canvas conversion failed'));
            blob.arrayBuffer().then(resolve).catch(reject);
        }, mimeType, quality);
    });
}

// ─── Tile fetch + resize ────────────────────────────────────────────────
async function fetchResizedTile(provider, mapType, z, x, y, canvas, ctx, target) {
    // Check local cache first
    const cached = await tileCache.get(provider, mapType, z, x, y);
    if (cached) return cached;

    const maptilerKey = store.get('mapgen_maptiler_key', '');
    const img = await loadImage(getTileUrl(provider, mapType, z, x, y, maptilerKey));
    ctx.clearRect(0, 0, 100, 100);
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, 100, 100);

    // ESRI Hybrid: overlay transportation labels
    if (provider === 'ESRI' && mapType === 'Hybrid') {
        try {
            const labelUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`;
            const labelImg = await loadImage(labelUrl);
            ctx.drawImage(labelImg, 0, 0, 256, 256, 0, 0, 100, 100);
        } catch (_) { /* overlay is non-critical, continue without labels */ }
    }

    const buf = await canvasToArrayBuffer(canvas, target);
    if (buf.byteLength < 128) {
        throw new Error('Generated tile too small — likely corrupt');
    }

    // Write to local cache
    tileCache.put(provider, mapType, z, x, y, buf);

    return buf;
}

/* Retry transient tile download failures before declaring a tile lost.
 * Fast-fails (under 1.5s) indicate server rejection (e.g. 403 rate-limit),
 * so retries are skipped to avoid hammering the provider. */
async function fetchResizedTileWithRetry(provider, mapType, z, x, y, canvas, ctx, target) {
    const maxRetries = 2;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const t0 = Date.now();
        try {
            return await fetchResizedTile(provider, mapType, z, x, y, canvas, ctx, target);
        } catch (err) {
            lastError = err;
            const elapsed = Date.now() - t0;
            if (elapsed < 1500) break;
            if (attempt < maxRetries) {
                await sleep(300 * (attempt + 1));
            }
        }
    }
    throw lastError || new Error('Tile fetch failed');
}

// ─── Ensure directory tree exists via electronAPI ───────────────────────
async function ensureDir(basePath, pathSegments) {
    let current = basePath;
    for (const segment of pathSegments) {
        current = current + '/' + segment;
        // writeFile will create parent dirs, but we build the full path
    }
    return current;
}

// ─── Tile cache ─────────────────────────────────────────────────────────
const tileCache = {
    basePath: null,
    enabled: true,
    trackedSizeBytes: 0,
    writeCount: 0,

    init() {
        // writeFile is shimmed onto a real download in the browser build,
        // so a set basePath would trigger one per tile. Leave it unset.
        if (globalThis.__INAV_BROWSER_BUILD__) {
            this.basePath = null;
            return;
        }
        const userData = globalThis.electronAPI.appGetPath('userData');
        this.basePath = userData + '/map_tiles';
        this.enabled = store.get('mapgen_cache_enabled', true);
        this.trackedSizeBytes = store.get('mapgen_cache_size_bytes', 0);
    },

    getCachePath(provider, mapType, z, x, y) {
        return `${this.basePath}/${provider}/${mapType}/${z}/${x}/${y}.jpg`;
    },

    async get(provider, mapType, z, x, y) {
        if (!this.enabled || !this.basePath) return null;
        try {
            const path = this.getCachePath(provider, mapType, z, x, y);
            const result = await globalThis.electronAPI.readFile(path, null);
            if (result && !result.error && result.data && result.data.byteLength > 128) {
                return result.data;
            }
        } catch (_) {
            // Cache miss — tile not in local cache
        }
        return null;
    },

    async put(provider, mapType, z, x, y, buf) {
        if (!this.enabled || !this.basePath) return;
        // Check max cache size
        const maxBytes = (store.get('mapgen_cache_max_mb', 500)) * 1024 * 1024;
        if (this.trackedSizeBytes >= maxBytes) return;
        try {
            const path = this.getCachePath(provider, mapType, z, x, y);
            await globalThis.electronAPI.writeFile(path, new Uint8Array(buf));
            this.trackedSizeBytes += buf.byteLength;
            // Persist every 50 tiles to avoid constant writes
            if (++this.writeCount % 50 === 0) {
                store.set('mapgen_cache_size_bytes', this.trackedSizeBytes);
            }
        } catch (err) {
            console.warn('Cache write failed:', err.message);
        }
    },

    persistSize() {
        store.set('mapgen_cache_size_bytes', this.trackedSizeBytes);
    },

    getFormattedSize() {
        const mb = this.trackedSizeBytes / (1024 * 1024);
        return mb < 1 ? `${(mb * 1024).toFixed(0)} KB` : `${mb.toFixed(1)} MB`;
    },

    async clear() {
        if (!this.basePath) return;
        try {
            await globalThis.electronAPI.rm(this.basePath);
            this.trackedSizeBytes = 0;
            store.set('mapgen_cache_size_bytes', 0);
        } catch (err) {
            console.warn('Cache clear failed:', err.message);
        }
    },
};

// ─── IndexedDB HGT cache (persist downloaded SRTM tiles for resume/reuse) ──
const hgtDb = {
    _instance: null,

    open() {
        if (this._instance) return Promise.resolve(this._instance);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('terrainHgtCache', 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore('hgt');
            req.onsuccess = e => { this._instance = e.target.result; resolve(this._instance); };
            req.onerror = () => reject(req.error);
        });
    },

    async get(key) {
        try {
            const db = await this.open();
            return new Promise(resolve => {
                const req = db.transaction('hgt', 'readonly').objectStore('hgt').get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (_) { return null; }
    },

    async put(key, data) {
        try {
            const db = await this.open();
            return new Promise(resolve => {
                const tx = db.transaction('hgt', 'readwrite');
                tx.objectStore('hgt').put(data, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch (_) { /* ignore */ }
    },

    async cachedSet() {
        try {
            const db = await this.open();
            return new Promise(resolve => {
                const req = db.transaction('hgt', 'readonly').objectStore('hgt').getAllKeys();
                req.onsuccess = () => resolve(new Set(req.result));
                req.onerror = () => resolve(new Set());
            });
        } catch (_) { return new Set(); }
    },

    async clear() {
        try {
            const db = await this.open();
            return new Promise(resolve => {
                const tx = db.transaction('hgt', 'readwrite');
                tx.objectStore('hgt').clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch (_) { /* ignore */ }
    },

    // One-time sweep: grids stored under the pre-width-fix 'cop_' prefix are
    // wrong at |lat| >= 50° and unreachable since the bump to 'cop2_' — drop
    // them so they stop taking up space. ('cop2_' keys do not match.)
    async dropOldCopernicusGrids() {
        try {
            const db = await this.open();
            return new Promise(resolve => {
                const tx = db.transaction('hgt', 'readwrite');
                const store = tx.objectStore('hgt');
                const req = store.getAllKeys();
                req.onsuccess = () => {
                    for (const key of req.result) {
                        if (typeof key === 'string' && key.startsWith('cop_')) store.delete(key);
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch (_) { /* ignore */ }
    },
};

// ─── Offline data folder (elevation originals + map imagery) ───────────────
// Region and box downloads put the files here as downloaded, and generation
// reads them before going to the network. Electron only: the web build has no
// file system, so there the folder is unavailable and generation works as before.
const offlineStore = {
    available() {
        return offlineFolderAvailable();
    },

    defaultDir() {
        return offlineFolderDefaultDir();
    },

    dir() {
        return offlineFolderDir();
    },

    path(rel) {
        return offlineFolderPath(rel);
    },

    read(rel) {
        return offlineFolderRead(rel);
    },

    write(rel, bytes) {
        return offlineFolderWrite(rel, bytes);
    },

    // File names present in elevation/<source>/.
    async elevationNames(source) {
        if (!this.available()) return new Set();
        const files = await globalThis.electronAPI.listFiles(this.path('elevation/' + source));
        return new Set(files.map(f => f.name));
    },
};

// The storage that js/terrain_elevation.js reads and writes during generation.
function makeTerrainIo() {
    const folder = offlineStore.available();
    return {
        hgtDb,
        hasFile: (source, lat, lon) => hasCellFile(source, lat, lon),
        readLocal: folder ? rel => offlineStore.read(rel) : null,
        saveLocal: folder ? (rel, bytes) => offlineStore.write(rel, bytes) : null,
    };
}

// ─── Map tiles from the offline folder ─────────────────────────────────────
// A tile layer that shows imagery/<provider>/<type>/z/x/y.<ext> from the
// offline folder when it is there (region downloads put it there). Otherwise
// it loads the tile from the network and, while the tile cache is enabled,
// saves it (the browse cache), so places looked at online also show offline.
// Tiles saved while browsing count against the tile cache's max size; region
// downloads don't. A server that refuses CORS gets a plain <img>, not saved.
const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png' };

const browseCache = {
    bytes() { return store.get('mapgen_browse_cache_bytes', 0); },
    reset() { store.set('mapgen_browse_cache_bytes', 0); },
    canSave() {
        return store.get('mapgen_cache_enabled', true) &&
            this.bytes() < store.get('mapgen_cache_max_mb', 500) * 1024 * 1024;
    },
    async save(rel, bytes) {
        try {
            await offlineStore.write(rel, bytes);
            store.set('mapgen_browse_cache_bytes', this.bytes() + bytes.length);
        } catch (_) { /* a failed save only costs a re-download later */ }
    },
};

function showTileBytes(tile, bytes, ext) {
    const url = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[ext] || 'image/jpeg' }));
    const revoke = () => URL.revokeObjectURL(url);
    tile.addEventListener('load', revoke, { once: true });
    tile.addEventListener('error', revoke, { once: true });
    tile.src = url;
}

const CachedTileLayer = L.TileLayer.extend({
    // options.offlineKey = { provider, type, ext } names the folder the tiles live in.
    createTile(coords, done) {
        const key = this.options.offlineKey;
        if (!key || !offlineStore.available()) {
            return L.TileLayer.prototype.createTile.call(this, coords, done);
        }
        const tile = document.createElement('img');
        L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
        L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
        tile.alt = '';
        tile.setAttribute('role', 'presentation');

        const url = this.getTileUrl(coords);
        const rel = imageryLocalPath(key.provider, key.type, this._getZoomForUrl(), coords.x, coords.y, key.ext);
        void (async () => {
            const local = await offlineStore.read(rel);
            if (local) {
                showTileBytes(tile, local, key.ext);
                return;
            }
            let bytes = null;
            try {
                const resp = await fetch(url);
                if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
            } catch (_) { /* offline, or no CORS: fall back to a plain <img> */ }
            if (!bytes) {
                if (this.options.crossOrigin || this.options.crossOrigin === '') {
                    tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
                }
                tile.src = url;
                return;
            }
            showTileBytes(tile, bytes, key.ext);
            if (browseCache.canSave()) void browseCache.save(rel, bytes);
        })();
        return tile;
    },
});

function cachedTileLayer(url, options, provider, type, ext) {
    return new CachedTileLayer(url, { ...options, offlineKey: { provider, type, ext } });
}

// Set while the tab is open; cleanup() calls it to stop an offline download.
let stopOfflineDownload = null;

function boundsCells(bounds) {
    return cellsForBounds(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
}

// ─── Tab lifecycle ──────────────────────────────────────────────────────
TABS.map_generator.initialize = function (callback) {
    // Must be the tab object, not its name — GUI.tab_switch_cleanup() calls
    // active_tab.cleanup() when leaving the tab.
    if (GUI.active_tab !== TABS.map_generator) {
        GUI.active_tab = TABS.map_generator;
    }

    void hgtDb.dropOldCopernicusGrids();
    // Ask Chromium not to evict the IndexedDB elevation cache under disk pressure.
    void navigator.storage?.persist?.().catch(() => {});

    loadHtml();

    async function loadHtml() {
        const { default: html } = await import('./map_generator.html?raw');
        GUI.load(html, process_html);
    }

    function process_html() {
        i18n.localize();

        // ── State ───────────────────────────────────────────────────
        let map = null;
        let currentLayer = null;
        let drawnItems = null;
        let sideLabels = { width: null, height: null };
        let sdPath = store.get('mapgen_sd_path', null);
        let syncAborted = false;
        const TILE_CONCURRENCY = 4;
        let terrainGridLayer = null;
        let liveAltEnabled = false;
        let liveAltCache = {};
        let preTerrainZoom = null;
        let terrainFallbackPending = false;
        let offlineJob = null;              // the offline download shown in the modal, if any
        let offlinePresent = { srtm: new Set(), copernicus: new Set() };   // file names in the offline folder
        let offlinePresentGen = 0;          // bumped each time offlinePresent is re-read
        let offlineFree = null;             // free bytes on the offline folder's drive, null if unknown
        let offlineEstimateQueued = false;
        let offlineElevationMemo = { key: null, plan: null };

        // ── Initialize tile cache ───────────────────────────────────
        tileCache.init();

        // ── Populate zoom selectors, respecting per-provider max zoom ──
        const PROVIDER_MAX_ZOOM = { OSM: 19, ESRI: 20, GOOGLE: 20, MAPTILER: 20 };
        const minZSelect = $('#mapgen_min_zoom');
        const maxZSelect = $('#mapgen_max_zoom');
        function rebuildZoomSelectors(maxZ) {
            const prevMin = parseInt(minZSelect.val()) || 8, prevMax = parseInt(maxZSelect.val()) || 14;
            minZSelect.empty(); maxZSelect.empty();
            for (let i = 1; i <= maxZ; i++) {
                minZSelect.append(new Option(i, i));
                maxZSelect.append(new Option(i, i));
            }
            minZSelect.val(Math.min(prevMin, maxZ));
            maxZSelect.val(Math.min(prevMax, maxZ));
        }
        rebuildZoomSelectors(20);

        // ── Restore settings (only if user explicitly saved) ────────
        const settingsSaved = store.get('mapgen_settings_saved', false);
        const savedTarget    = settingsSaved ? store.get('mapgen_target', 'terrain') : 'terrain';
        const savedSubtarget = settingsSaved ? store.get('mapgen_subtarget', 'ethos') : 'ethos';
        const savedProvider    = settingsSaved ? store.get('mapgen_provider', 'OSM') : 'OSM';
        const savedMaptilerKey = store.get('mapgen_maptiler_key', '');
        const savedProject   = settingsSaved ? store.get('mapgen_project_name', 'MyLocalField') : 'MyLocalField';
        const savedMinZoom   = settingsSaved ? store.get('mapgen_min_zoom', 8) : 8;
        const savedMaxZoom   = settingsSaved ? store.get('mapgen_max_zoom', 14) : 14;
        const defaultUnit    = globalSettings.unitType === UnitType.imperial ? 'mi2' : 'km2';
        const savedUnit      = settingsSaved ? store.get('mapgen_area_unit', defaultUnit) : defaultUnit;
        const savedCenter    = settingsSaved ? store.get('mapgen_last_center', [42.6977, 23.3219]) : [42.6977, 23.3219];
        const savedZoom      = settingsSaved ? store.get('mapgen_last_zoom', 12) : 12;

        $('#mapgen_subtarget').val(savedSubtarget);
        $('#mapgen_target').val(savedTarget);
        $('#mapgen_terrain_source').val(settingsSaved ? store.get('mapgen_terrain_source', 'copernicus') : 'copernicus');
        $('#mapgen_provider').val(savedProvider);
        $('#mapgen_maptiler_key').val(savedMaptilerKey);
        $('#mapgen_project_name').val(savedProject);
        $('#mapgen_min_zoom').val(savedMinZoom);
        $('#mapgen_max_zoom').val(savedMaxZoom);
        $('#mapgen_area_unit').val(savedUnit);

        // ── SD path display ─────────────────────────────────────────
        async function updateSdDisplay() {
            if (sdPath && !(await globalThis.electronAPI.pathExists(sdPath))) {
                sdPath = '';
                store.set('mapgen_sd_path', '');
            }
            if (sdPath) {
                $('#mapgen_sd_path').text(sdPath).addClass('linked');
                $('#mapgen_link_sd').text(i18n.getMessage('mapgenChangeSd') || 'Change SD Folder');
                $('#mapgen_eject_sd').show();
            } else {
                $('#mapgen_sd_path').text(i18n.getMessage('mapgenNoSdLinked') || 'No SD card folder selected').removeClass('linked');
                $('#mapgen_link_sd').text(i18n.getMessage('mapgenLinkSD') || 'Select SD Card Folder');
                $('#mapgen_eject_sd').hide();
            }
        }
        updateSdDisplay();
        window.addEventListener('focus', () => updateSdDisplay());

        // ── Provider-dependent map type options ─────────────────────
        function syncMapOptions() {
            const provider = $('#mapgen_provider').val();
            const target   = $('#mapgen_target').val();
            const typeSelect = $('#mapgen_maptype');

            typeSelect.empty();
            if (provider === 'OSM') {
                typeSelect.append(new Option('Street', 'Street', true, true));
            } else if (provider === 'MAPTILER') {
                typeSelect.append(new Option('Satellite', 'Satellite'));
                typeSelect.append(new Option('Street', 'Street', true, true));
                typeSelect.append(new Option('Hybrid', 'Hybrid'));
                typeSelect.append(new Option('OSM Style', 'OSM Style'));
                typeSelect.append(new Option('Outdoor', 'Outdoor'));
                typeSelect.append(new Option('Topo', 'Topo'));
                typeSelect.append(new Option('Winter', 'Winter'));
            } else {
                typeSelect.append(new Option('Satellite', 'Satellite'));
                typeSelect.append(new Option('Street', 'Street', true, true));
                typeSelect.append(new Option('Hybrid', 'Hybrid'));
            }

            // Restore saved map type if still valid
            const savedMapType = store.get('mapgen_map_type', 'Street');
            if (typeSelect.find(`option[value="${savedMapType}"]`).length) {
                typeSelect.val(savedMapType);
            }

            // Warnings / provider-specific UI (all suppressed in terrain mode,
            // which ignores the tile provider entirely)
            const tileMode = target !== 'terrain';
            $('#mapgen_google_warning').toggle(tileMode && provider === 'GOOGLE');
            const osmSelected = provider === 'OSM';
            $('#mapgen_osm_warning').toggle(tileMode && osmSelected);
            $('#mapgen_maptiler_key_row').toggle(tileMode && provider === 'MAPTILER');
            const exportBlocked = tileMode && (osmSelected || (provider === 'MAPTILER' && !$('#mapgen_maptiler_key').val().trim()));
            $('#mapgen_sync_btn a, #mapgen_zip_btn a').toggleClass('disabled', exportBlocked);

            // Show/hide Yaapu sub-target selector
            $('#mapgen_subtarget_wrapper').toggleClass('mapgen-subtarget-hidden', target !== 'yaapu');

            if (target === 'yaapu' && provider !== 'GOOGLE') {
                $('#mapgen_yaapu_warning')
                    .text(`Provider "${provider}" will be mapped to Google-style folder names for Yaapu.`)
                    .show();
            } else {
                $('#mapgen_yaapu_warning').hide();
            }

            rebuildZoomSelectors(PROVIDER_MAX_ZOOM[provider] || 20);
            updateTerrainMode();
        }
        syncMapOptions();

        // ── Initialize Leaflet map ──────────────────────────────────
        map = L.map('mapgen_map', {
            zoomControl: true,
            doubleClickZoom: false,
            scrollWheelZoom: true,
        }).setView(savedCenter, savedZoom);

        // Tile layers
        const osmAttr      = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
        const esriAttr     = '&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Sources: Esri, Maxar, Earthstar Geographics';
        const googleAttr   = 'Map data &copy; <a href="https://www.google.com/intl/en/help/terms_maps/">Google</a>';
        const maptilerAttr = '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

        const osmLayer       = cachedTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: osmAttr }, 'OSM', 'Street', 'png');
        const esriSatellite  = cachedTileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, crossOrigin: true, attribution: esriAttr }, 'ESRI', 'Satellite', 'jpg');
        const esriStreet     = cachedTileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, crossOrigin: true, attribution: esriAttr }, 'ESRI', 'Street', 'jpg');
        const esriLabels     = cachedTileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, crossOrigin: true, pane: 'shadowPane' }, 'ESRI', 'Labels', 'png');
        const googleSatellite = cachedTileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: googleAttr }, 'GOOGLE', 'Satellite', 'jpg');
        const googleStreet   = cachedTileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: googleAttr }, 'GOOGLE', 'Street', 'png');
        const googleHybrid   = cachedTileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: googleAttr }, 'GOOGLE', 'Hybrid', 'jpg');

        function getMaptilerLayer(type) {
            const key   = $('#mapgen_maptiler_key').val().trim();
            const styleMap = { 'Satellite': 'satellite', 'Hybrid': 'hybrid', 'Street': 'streets-v2', 'OSM Style': 'openstreetmap', 'Outdoor': 'outdoor-v2', 'Topo': 'topo-v2', 'Winter': 'winter-v4' };
            const style = styleMap[type] || 'streets-v2';
            const pngTypes = new Set(['Street', 'OSM Style', 'Outdoor', 'Topo', 'Winter']);
            const ext   = pngTypes.has(type) ? 'png' : 'jpg';
            return cachedTileLayer(`https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.${ext}?key=${key}`, { maxZoom: 20, crossOrigin: true, attribution: maptilerAttr }, 'MAPTILER', style, ext);
        }

        currentLayer = osmLayer;
        currentLayer.addTo(map);

        function switchMapLayer() {
            const provider = $('#mapgen_provider').val();
            const type = $('#mapgen_maptype').val();

            if (currentLayer) map.removeLayer(currentLayer);
            if (map.hasLayer(esriLabels)) map.removeLayer(esriLabels);

            if (provider === 'MAPTILER') {
                currentLayer = getMaptilerLayer(type);
                currentLayer.addTo(map);
                return;
            }

            const layerMap = {
                'Satellite_ESRI': esriSatellite,
                'Satellite_GOOGLE': googleSatellite,
                'Hybrid_ESRI': esriSatellite,
                'Hybrid_GOOGLE': googleHybrid,
                'Street_OSM': osmLayer,
                'Street_ESRI': esriStreet,
                'Street_GOOGLE': googleStreet,
            };
            currentLayer = layerMap[`${type}_${provider}`] || osmLayer;

            if (type === 'Hybrid' && provider === 'ESRI') {
                esriLabels.addTo(map);
            }

            currentLayer.addTo(map);
        }

        // Restore saved map type after syncMapOptions populated the dropdown
        const restoredMapType = store.get('mapgen_map_type', 'Street');
        if ($('#mapgen_maptype').find(`option[value="${restoredMapType}"]`).length) {
            $('#mapgen_maptype').val(restoredMapType);
        }
        switchMapLayer();

        // ── Leaflet controls ────────────────────────────────────────
        // Search / geocoder
        L.Control.geocoder({
            defaultMarkGeocode: false,
            position: 'topleft',
            placeholder: 'Search...',
        }).on('markgeocode', e => map.fitBounds(e.geocode.bbox)).addTo(map);

        // Scale — store reference so we can swap metric/imperial
        let scaleControl = L.control.scale({ imperial: false, metric: true, position: 'bottomleft' });
        scaleControl.addTo(map);

        function refreshScale() {
            const unit = $('#mapgen_area_unit').val() || 'km2';
            const useImperial = (unit === 'mi2' || unit === 'acre');
            map.removeControl(scaleControl);
            scaleControl = L.control.scale({
                imperial: useImperial,
                metric: !useImperial,
                position: 'bottomleft',
            });
            scaleControl.addTo(map);
        }

        // Rectangle drawing layer
        drawnItems = new L.FeatureGroup();
        map.addLayer(drawnItems);

        // ── Custom drag-to-draw rectangle (hold left mouse) ─────────
        let isDrawing = false;
        let drawStartLatLng = null;
        let drawRect = null;
        const rectStyle = { color: '#ff0000', weight: 2, fillOpacity: 0.1 };

        function startDraw(e) {
            if (e.originalEvent.button !== 0) return; // only left mouse
            isDrawing = true;
            drawStartLatLng = e.latlng;
            map.dragging.disable();
        }

        function moveDraw(e) {
            if (!isDrawing || !drawStartLatLng) return;
            const bounds = L.latLngBounds(drawStartLatLng, e.latlng);
            if (drawRect) {
                drawRect.setBounds(bounds);
            } else {
                drawRect = L.rectangle(bounds, rectStyle).addTo(map);
            }
        }

        function endDraw(e) {
            if (!isDrawing) return;
            isDrawing = false;
            map.dragging.enable();

            if (!drawStartLatLng) return;
            const bounds = L.latLngBounds(drawStartLatLng, e.latlng);

            // Only accept if the rectangle has meaningful size
            if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
                if (drawRect) { map.removeLayer(drawRect); drawRect = null; }
                drawStartLatLng = null;
                return;
            }

            // Remove temp preview rect
            if (drawRect) { map.removeLayer(drawRect); drawRect = null; }
            drawStartLatLng = null;

            // Create final rectangle
            drawnItems.clearLayers();
            if (sideLabels.width) {
                map.removeLayer(sideLabels.width);
                map.removeLayer(sideLabels.height);
                sideLabels = { width: null, height: null };
            }
            const rect = L.rectangle(bounds, rectStyle);
            drawnItems.addLayer(rect);
            updateSideLabels(rect);
            if (isTerrainMode()) {
                updateTerrainGrid();
                updateTerrainStatus();
            }
        }

        function enableDrawMode() {
            map.on('mousedown', startDraw);
            map.on('mousemove', moveDraw);
            map.on('mouseup', endDraw);
            map.getContainer().style.cursor = 'crosshair';
            drawModeActive = true;
        }

        function disableDrawMode() {
            map.off('mousedown', startDraw);
            map.off('mousemove', moveDraw);
            map.off('mouseup', endDraw);
            if (drawRect) { map.removeLayer(drawRect); drawRect = null; }
            isDrawing = false;
            drawStartLatLng = null;
            map.dragging.enable();
            map.getContainer().style.cursor = '';
            drawModeActive = false;
        }

        let drawModeActive = false;
        let editMode = false;
        function onLayerEdit() { triggerUpdate(); }
        function onEditMouseMove() {
            if (editMode && drawnItems.getLayers().length > 0) {
                updateSideLabels(drawnItems.getLayers()[0]);
            }
        }
        function disableEditMode() {
            if (!editMode) return;
            editMode = false;
            map.off('mousemove', onEditMouseMove);
            $('#mapgen_edit_btn').css({ backgroundColor: '', color: '' });
            drawnItems.eachLayer(l => {
                l.off('edit', onLayerEdit);
                if (l.editing) l.editing.disable();
            });
            triggerUpdate();
        }

        // Do NOT start in draw mode — user picks it manually

        // ── Toolbar click handlers ──────────────────────────────────
        function handleDrawClick(e) {
            L.DomEvent.preventDefault(e);
            const drawBtn = document.getElementById('mapgen_draw_btn');
            if (drawModeActive) {
                disableDrawMode();
                drawBtn.style.backgroundColor = '';
                drawBtn.style.color = '';
            } else {
                enableDrawMode();
                drawBtn.style.backgroundColor = '#87b025';
                drawBtn.style.color = '#fff';
            }
        }

        function handleEditClick(e) {
            L.DomEvent.preventDefault(e);
            const editBtn = document.getElementById('mapgen_edit_btn');
            if (editMode) {
                disableEditMode();
            } else {
                if (drawnItems.getLayers().length === 0) return;
                editMode = true;
                if (drawModeActive) {
                    disableDrawMode();
                    $('#mapgen_draw_btn').css({ backgroundColor: '', color: '' });
                }
                editBtn.style.backgroundColor = '#87b025';
                editBtn.style.color = '#fff';
                drawnItems.eachLayer(l => {
                    if (l.editing) l.editing.enable();
                    l.on('edit', onLayerEdit);
                });
                map.on('mousemove', onEditMouseMove);
            }
        }

        function handleDeleteClick(e) {
            L.DomEvent.preventDefault(e);
            drawnItems.clearLayers();
            if (sideLabels.width) {
                map.removeLayer(sideLabels.width);
                map.removeLayer(sideLabels.height);
                sideLabels = { width: null, height: null };
            }
            $('#mapgen_status').text(i18n.getMessage('mapgenStatusDefault') || 'Draw a rectangle on the map to select your area.');
            if (isTerrainMode()) updateTerrainGrid();
        }

        function handleMeasureClick(e) {
            L.DomEvent.preventDefault(e);
            const measureBtn = document.getElementById('mapgen_measure_btn');
            if (measureActive) {
                disengageMeasure();
            } else {
                measureActive = true;
                if (drawModeActive) {
                    disableDrawMode();
                    $('#mapgen_draw_btn').css({ backgroundColor: '', color: '' });
                }
                measureStart = map.getCenter();
                $('#mapgen_measure_popup').text('0m / 0ft').show();
                map.on('move', onMapMove);
                measureBtn.style.backgroundColor = '#87b025';
                measureBtn.style.color = '#fff';
            }
        }

        function handleFullscreenClick(e) {
            L.DomEvent.preventDefault(e);
            const sidebar = document.querySelector('.mapgen-sidebar');
            const fsBtn = e.target;
            if (sidebar.style.display === 'none') {
                sidebar.style.display = '';
                fsBtn.innerHTML = '⛶';
            } else {
                sidebar.style.display = 'none';
                fsBtn.innerHTML = '⧉';
            }
            setTimeout(() => map.invalidateSize(), 100);
        }

        // ── Left toolbar: Draw + Edit layer buttons ─────────────────
        const LeftToolbar = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar');

                const drawBtn = L.DomUtil.create('a', 'mapgen-toolbar-btn', container);
                drawBtn.innerHTML = '⬜';
                drawBtn.href = '#';
                drawBtn.title = 'Draw rectangle (hold left mouse to drag)';
                drawBtn.id = 'mapgen_draw_btn';
                L.DomEvent.disableClickPropagation(drawBtn);
                L.DomEvent.on(drawBtn, 'click', handleDrawClick);

                const editBtn = L.DomUtil.create('a', 'mapgen-toolbar-btn', container);
                editBtn.innerHTML = '✎';
                editBtn.href = '#';
                editBtn.title = 'Edit / move drawn rectangle';
                editBtn.id = 'mapgen_edit_btn';
                L.DomEvent.disableClickPropagation(editBtn);
                L.DomEvent.on(editBtn, 'click', handleEditClick);

                const delBtn = L.DomUtil.create('a', 'mapgen-toolbar-btn', container);
                delBtn.innerHTML = '🗑';
                delBtn.href = '#';
                delBtn.title = 'Delete drawn rectangle';
                L.DomEvent.disableClickPropagation(delBtn);
                L.DomEvent.on(delBtn, 'click', handleDeleteClick);

                return container;
            },
        });
        new LeftToolbar().addTo(map);

        // ── Measure state (outer scope for contextmenu access) ────
        let measureActive = false;
        let measureStart = null;
        let measureLine = null;

        function clearMeasure() {
            measureStart = null;
            if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
            $('#mapgen_measure_popup').hide().text('');
        }

        function onMapMove() {
            if (!measureActive || !measureStart) return;
            const currentCenter = map.getCenter();
            const distM = measureStart.distanceTo(currentCenter);
            const combined = `${Math.round(distM)}m / ${Math.round(distM * 3.28084)}ft`;
            $('#mapgen_measure_popup').text(combined).show();
            if (measureLine) map.removeLayer(measureLine);
            measureLine = L.polyline([measureStart, currentCenter], {
                color: '#87b025', weight: 3, dashArray: '5,5',
            }).addTo(map);
        }

        function disengageMeasure() {
            if (!measureActive) return;
            measureActive = false;
            map.off('move', onMapMove);
            clearMeasure();
            const btn = document.getElementById('mapgen_measure_btn');
            if (btn) { btn.style.backgroundColor = ''; btn.style.color = ''; }
        }

        // ── Right toolbar: Measure + Fullscreen ─────────────────────
        const RightToolbar = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar mapgen-right-toolbar');

                const measureBtn = L.DomUtil.create('a', 'mapgen-toolbar-btn', container);
                measureBtn.innerHTML = '📏';
                measureBtn.href = '#';
                measureBtn.title = 'Measure distance (click points, click button again to clear)';
                measureBtn.id = 'mapgen_measure_btn';
                L.DomEvent.disableClickPropagation(measureBtn);
                L.DomEvent.on(measureBtn, 'click', handleMeasureClick);

                const fsBtn = L.DomUtil.create('a', 'mapgen-toolbar-btn mapgen-fullscreen-btn', container);
                fsBtn.innerHTML = '⛶';
                fsBtn.href = '#';
                fsBtn.title = 'Toggle fullscreen map';
                L.DomEvent.disableClickPropagation(fsBtn);
                L.DomEvent.on(fsBtn, 'click', handleFullscreenClick);

                return container;
            },
        });
        new RightToolbar().addTo(map);

        // Override Leaflet Draw area formatter to respect selected unit
        L.GeometryUtil.readableArea = function (area) {
            const unit = $('#mapgen_area_unit').val() || 'km2';
            return formatArea(area, unit);
        };

        // ── Side labels & status ────────────────────────────────────
        function updateSideLabels(layer) {
            const unit = $('#mapgen_area_unit').val();
            const latlngs = layer.getLatLngs()[0];
            const bounds = layer.getBounds();
            const minZ = Number.parseInt($('#mapgen_min_zoom').val(), 10);
            const maxZ = Number.parseInt($('#mapgen_max_zoom').val(), 10);
            const area = L.GeometryUtil.geodesicArea(latlngs);
            const tiles = calculateTiles(bounds, minZ, maxZ);

            const wM = latlngs[0].distanceTo(latlngs[1]);
            const hM = latlngs[1].distanceTo(latlngs[2]);
            const wS = formatDistance(wM, unit);
            const hS = formatDistance(hM, unit);

            const midT = L.latLng((latlngs[0].lat + latlngs[1].lat) / 2, (latlngs[0].lng + latlngs[1].lng) / 2);
            const midL = L.latLng((latlngs[1].lat + latlngs[2].lat) / 2, (latlngs[1].lng + latlngs[2].lng) / 2);

            if (sideLabels.width) {
                sideLabels.width.setLatLng(midT).setIcon(L.divIcon({ className: 'mapgen-side-label', html: wS }));
                sideLabels.height.setLatLng(midL).setIcon(L.divIcon({ className: 'mapgen-side-label', html: hS }));
            } else {
                sideLabels.width  = L.marker(midT, { icon: L.divIcon({ className: 'mapgen-side-label', html: wS }) }).addTo(map);
                sideLabels.height = L.marker(midL, { icon: L.divIcon({ className: 'mapgen-side-label', html: hS }) }).addTo(map);
            }

            // In terrain mode, updateTerrainStatus() sets the status area
            if (isTerrainMode()) {
                updateOfflineEstimate();   // the box may have moved (drawn or edited)
                return;
            }

            const maxZoomTiles = calculateTiles(bounds, maxZ, maxZ);
            let statusHtml =
                `<span class="mapgen-area">Area: ${formatArea(area, unit)}</span><br>` +
                `<span class="mapgen-tiles">Total Tiles (100x100 JPEG): ${tiles.toLocaleString()}</span>`;
            if (maxZoomTiles < 64) {
                statusHtml += `<br><span style="color:#c62828;">&#9888;&#65039; Low tile coverage at max zoom (${maxZoomTiles} tiles). Consider increasing max zoom.</span>`;
            }
            $('#mapgen_status').html(statusHtml);
        }

        function triggerUpdate() {
            if (drawnItems.getLayers().length > 0) {
                updateSideLabels(drawnItems.getLayers()[0]);
                if (isTerrainMode()) updateTerrainStatus();
            }
            $('#mapgen_zoom_display').text('Zoom: ' + map.getZoom());
        }

        // ── Map events ──────────────────────────────────────────────

        map.on('zoomend moveend', () => {
            triggerUpdate();
            if (isTerrainMode()) updateTerrainGrid();
        });

        map.on('mousemove', e => {
            $('#mapgen_coords_output').text(`Lat: ${e.latlng.lat.toFixed(4)}, Lng: ${e.latlng.lng.toFixed(4)}`);
            if (liveAltEnabled) {
                const alt = getAltFromCache(e.latlng.lat, e.latlng.lng);
                $('#mapgen_alt_output').text(alt !== null ? 'Alt: ' + alt + 'm' : 'Alt: \u2014');
            }
        });

        map.on('zoomend', () => {
            $('#mapgen_zoom_display').text('Zoom: ' + map.getZoom());
        });

        // Map position is now saved only via the Save Settings button

        // Right-click: disengage measure, edit mode, delete rectangle, or disengage draw mode
        map.on('contextmenu', (e) => {
            L.DomEvent.stop(e);
            // If measure tool is active, disengage it first
            if (measureActive) {
                disengageMeasure();
                return;
            }
            // If edit mode is active, disengage it
            if (editMode) {
                disableEditMode();
                return;
            }
            // If there's a drawn rectangle, delete it first
            if (drawnItems.getLayers().length > 0) {
                drawnItems.clearLayers();
                if (sideLabels.width) {
                    map.removeLayer(sideLabels.width);
                    map.removeLayer(sideLabels.height);
                    sideLabels = { width: null, height: null };
                }
                $('#mapgen_status').text(i18n.getMessage('mapgenStatusDefault') || 'Draw a rectangle on the map to select your area.');
                if (isTerrainMode()) updateTerrainGrid();
                return; // stop here — next right-click will disengage
            }
            // No rectangle → disengage draw mode if active
            if (drawModeActive) {
                disableDrawMode();
                $('#mapgen_draw_btn').css({ backgroundColor: '', color: '' });
            }
        });

        // ── Settings persistence ────────────────────────────────────
        function saveSettings() {
            store.set('mapgen_target', $('#mapgen_target').val());
            store.set('mapgen_terrain_source', $('#mapgen_terrain_source').val());
            store.set('mapgen_subtarget', $('#mapgen_subtarget').val());
            store.set('mapgen_provider', $('#mapgen_provider').val());
            store.set('mapgen_map_type', $('#mapgen_maptype').val());
            store.set('mapgen_project_name', $('#mapgen_project_name').val());
            store.set('mapgen_min_zoom', Number.parseInt($('#mapgen_min_zoom').val(), 10));
            store.set('mapgen_max_zoom', Number.parseInt($('#mapgen_max_zoom').val(), 10));
            store.set('mapgen_area_unit', $('#mapgen_area_unit').val());
            const c = map.getCenter();
            store.set('mapgen_last_center', [c.lat, c.lng]);
            store.set('mapgen_last_zoom', map.getZoom());
            store.set('mapgen_settings_saved', true);
        }

        function restoreDefaults() {
            store.delete('mapgen_settings_saved');
            store.delete('mapgen_target');
            store.delete('mapgen_subtarget');
            store.delete('mapgen_provider');
            store.delete('mapgen_map_type');
            store.delete('mapgen_project_name');
            store.delete('mapgen_min_zoom');
            store.delete('mapgen_max_zoom');
            store.delete('mapgen_area_unit');
            store.delete('mapgen_last_center');
            store.delete('mapgen_last_zoom');
            store.delete('mapgen_terrain_source');
            // Note: mapgen_maptiler_key is intentionally NOT deleted on restore defaults
            // Reset UI to defaults
            $('#mapgen_target').val('terrain');
            $('#mapgen_terrain_source').val('copernicus');
            $('#mapgen_subtarget').val('ethos');
            $('#mapgen_provider').val('OSM');
            $('#mapgen_project_name').val('MyLocalField');
            $('#mapgen_min_zoom').val(8);
            $('#mapgen_max_zoom').val(14);
            $('#mapgen_area_unit').val(globalSettings.unitType === UnitType.imperial ? 'mi2' : 'km2');
            syncMapOptions();
            switchMapLayer();
            map.setView([42.6977, 23.3219], 12);
            triggerUpdate();
            refreshScale();
        }

        // ── Control event bindings ──────────────────────────────────
        $('#mapgen_target').on('change', () => { syncMapOptions(); triggerUpdate(); });
        $('#mapgen_terrain_source').on('change', () => {
            store.set('mapgen_terrain_source', $('#mapgen_terrain_source').val());
            updateTerrainSourceUI();
            triggerUpdate();
            if (isTerrainMode()) updateTerrainGrid();
        });
        $('#mapgen_provider').on('change', () => { syncMapOptions(); switchMapLayer(); });
        $('#mapgen_maptype').on('change', () => { switchMapLayer(); });
        $('#mapgen_maptiler_key').on('input', () => {
            store.set('mapgen_maptiler_key', $('#mapgen_maptiler_key').val().trim());
            syncMapOptions();
            if ($('#mapgen_provider').val() === 'MAPTILER') switchMapLayer();
        });
        $('#mapgen_min_zoom, #mapgen_max_zoom').on('change', () => { triggerUpdate(); });
        $('#mapgen_area_unit').on('change', () => { triggerUpdate(); refreshScale(); });

        // ── Save / Restore buttons ──────────────────────────────────
        $('#mapgen_save_settings_btn a').on('click', (e) => {
            e.preventDefault();
            saveSettings();
        });
        $('#mapgen_restore_settings_btn a').on('click', (e) => {
            e.preventDefault();
            restoreDefaults();
        });

        // ── SD card linking ─────────────────────────────────────────
        $('#mapgen_link_sd').on('click', async () => {
            const result = await globalThis.electronAPI.showOpenDialog({
                title: 'Select SD Card Root Folder',
                properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                sdPath = result.filePaths[0];
                store.set('mapgen_sd_path', sdPath);
                updateSdDisplay();
            }
        });

        $('#mapgen_eject_sd').on('click', async () => {
            if (!sdPath) return;
            // Extract drive letter from path (e.g. "D:\..." → "D")
            const driveLetter = sdPath.match(/^([a-zA-Z]):/);
            if (!driveLetter) {
                $('#mapgen_status').text('Cannot determine drive letter from SD path.');
                return;
            }
            const err = await globalThis.electronAPI.ejectDrive(driveLetter[1]);
            if (err) {
                // Drive likely already ejected or not found — clear the link
                sdPath = '';
                store.set('mapgen_sd_path', '');
                updateSdDisplay();
                $('#mapgen_status').text('SD card unlinked. (Drive may already be ejected.)');
            } else {
                sdPath = '';
                store.set('mapgen_sd_path', '');
                updateSdDisplay();
                $('#mapgen_status').text('SD card ejected safely.');
            }
        });

        // ── Tile cache UI ───────────────────────────────────────────
        function updateCacheSizeDisplay() {
            $('#mapgen_cache_size').text(tileCache.getFormattedSize());
        }

        // Restore saved cache settings
        $('#mapgen_cache_enabled').prop('checked', tileCache.enabled);
        $('#mapgen_cache_max').val(store.get('mapgen_cache_max_mb', 500));
        updateCacheSizeDisplay();

        $('#mapgen_cache_enabled').on('change', function () {
            tileCache.enabled = $(this).is(':checked');
            store.set('mapgen_cache_enabled', tileCache.enabled);
        });

        $('#mapgen_cache_max').on('change', function () {
            store.set('mapgen_cache_max_mb', Number.parseInt($(this).val(), 10));
        });

        $('#mapgen_clear_cache').on('click', async () => {
            if (!globalThis.electronAPI.confirmDialog('Clear all cached map tiles?')) return;
            await tileCache.clear();
            updateCacheSizeDisplay();
        });

        // ── Sync pipeline ───────────────────────────────────────────
        function showModal() { $('#mapgen_sync_overlay').addClass('open'); }
        function hideModal() { $('#mapgen_sync_overlay').removeClass('open'); }

        function updateProgress(processed, total, startTime, failedCount) {
            const progress = total > 0 ? (processed / total * 100) : 100;
            $('#mapgen_progress_fill').css('width', progress + '%');
            if (processed <= 0) {
                $('#mapgen_download_status').text(`Syncing: 0 / ${total}`);
                return;
            }
            const elapsed = Date.now() - startTime;
            const avgPerTile = elapsed / processed;
            const remainingMs = Math.max(0, (total - processed) * avgPerTile);
            const mins = Math.floor(remainingMs / 60000);
            const secs = Math.ceil((remainingMs % 60000) / 1000);
            const failSuffix = failedCount > 0 ? ` | Failed: ${failedCount}` : '';
            $('#mapgen_download_status').text(`Syncing: ${processed} / ${total}${failSuffix} (${mins}:${secs.toString().padStart(2, '0')} remaining)`);
        }

        function buildExamplePath(target, zipMode, provider, mapType, displayMapType, subtarget) {
            if (target === 'b14ckyy') {
                const base = zipMode ? 'ethosmaps/maps' : '/bitmaps/ethosmaps/maps';
                return provider === 'ESRI'
                    ? `${base}/${provider}/${mapType}/[Z]/[Y]/[X].jpg`
                    : `${base}/${provider}/${mapType}/[Z]/[X]/[Y].jpg`;
            }
            let base = 'yaapu/maps';
            if (!zipMode) {
                base = subtarget === 'edgetx' ? '/IMAGES/yaapu/maps' : '/bitmaps/yaapu/maps';
            }
            return `${base}/${displayMapType}/[Z]/[Y]/s_[X].jpg`;
        }

        function buildTargetLabel(target, subtarget) {
            if (target === 'b14ckyy') return 'b14ckyy ETHOS';
            return `Yaapu ${subtarget === 'edgetx' ? 'EdgeTX' : 'ETHOS'}`;
        }

        let isZipMode = false;

        function showSyncModal(zipMode) {
            const layer = drawnItems.getLayers()[0];
            const projectName = $('#mapgen_project_name').val().trim();

            if (!projectName) {
                $('#mapgen_status').text('Error: Please enter a Project Folder Name.');
                $('#mapgen_project_name').focus();
                return;
            }
            if (!layer) {
                $('#mapgen_status').text('Error: Please draw a rectangle to select an area for sync.');
                return;
            }
            if (!zipMode && !sdPath) {
                $('#mapgen_status').text('Error: Please select an SD card folder first.');
                return;
            }

            isZipMode = zipMode;
            syncAborted = false;

            // Build summary
            const target   = $('#mapgen_target').val();
            const subtarget = $('#mapgen_subtarget').val();
            const provider = $('#mapgen_provider').val();
            const mapType  = $('#mapgen_maptype').val();
            const bounds   = layer.getBounds();
            const minZ     = Number.parseInt($('#mapgen_min_zoom').val(), 10);
            const maxZ     = Number.parseInt($('#mapgen_max_zoom').val(), 10);
            const unit     = $('#mapgen_area_unit').val();
            const areaVal  = formatArea(L.GeometryUtil.geodesicArea(layer.getLatLngs()[0]), unit);
            const tileCount = calculateTiles(bounds, minZ, maxZ);

            // Display name for Yaapu target
            const displayMapType = target === 'yaapu' ? getYaapuMapName(mapType) : mapType;

            // Example path
            const examplePath = buildExamplePath(target, zipMode, provider, mapType, displayMapType, subtarget);

            const targetLabel = buildTargetLabel(target, subtarget);
            const modeLabel = zipMode ? 'ZIP Export' : 'SD Card Sync';

            let infoHtml = `
                <div class="mapgen-info-row"><span>Mode:</span><span>${modeLabel}</span></div>
                <div class="mapgen-info-row"><span>Target:</span><span>${targetLabel}</span></div>
                <div class="mapgen-info-row"><span>Total Tiles:</span><span>${tileCount.toLocaleString()}</span></div>
                <div class="mapgen-info-row"><span>Project:</span><span>${$('<span>').text(projectName).html()}</span></div>
                <div class="mapgen-info-row"><span>Zoom:</span><span>${minZ} – ${maxZ}</span></div>
                <div class="mapgen-info-row"><span>Area:</span><span>${areaVal}</span></div>
            `;
            if (!zipMode) {
                infoHtml += `<div class="mapgen-info-row"><span>SD Path:</span><span style="font-size:11px;">${$('<span>').text(sdPath).html()}</span></div>`;
            }
            infoHtml += `<div class="mapgen-info-row"><span>Example:</span><span style="font-size:10px;">${examplePath}</span></div>`;

            $('#mapgen_sync_info').html(infoHtml);
            $('#mapgen_modal_header').text(zipMode ? 'Export as ZIP' : 'Syncing to SD Card');

            $('#mapgen_progress_section').hide();
            $('#mapgen_modal_actions').show();
            $('#mapgen_modal_confirm').show().text(zipMode ? 'Export ZIP' : (i18n.getMessage('mapgenConfirmSync') || 'Confirm Sync'));
            $('#mapgen_modal_cancel').text('Cancel');
            showModal();
        }

        $('#mapgen_sync_btn').on('click', () => {
            if (isTerrainMode()) {
                showTerrainSyncModal();
                return;
            }
            const provider = $('#mapgen_provider').val();
            if (provider === 'OSM') return;
            if (provider === 'MAPTILER' && !$('#mapgen_maptiler_key').val().trim()) return;
            showSyncModal(false);
        });
        $('#mapgen_zip_btn').on('click', () => {
            if (isTerrainMode()) {
                showTerrainSyncModal();
                return;
            }
            const provider = $('#mapgen_provider').val();
            if (provider === 'OSM') return;
            if (provider === 'MAPTILER' && !$('#mapgen_maptiler_key').val().trim()) return;
            showSyncModal(true);
        });

        $('#mapgen_modal_cancel').on('click', (e) => {
            e.preventDefault();
            if (offlineJob) {
                offlineCancelClicked();
                return;
            }
            syncAborted = true;
            hideModal();
        });

        $('#mapgen_modal_confirm').on('click', async (e) => {
            e.preventDefault();
            if (offlineJob) {
                await offlineConfirmClicked();
                return;
            }
            // Confirming the "Copernicus unavailable" prompt is the user's
            // explicit consent to switch elevation source for this generation.
            if (terrainFallbackPending) {
                terrainFallbackPending = false;
                $('#mapgen_terrain_source').val('srtm');
                store.set('mapgen_terrain_source', 'srtm');
                updateTerrainSourceUI();
            }
            if (isTerrainMode()) {
                await terrainGenerateAndSync();
            } else {
                await runSync();
            }
        });

        async function runSync() {
            syncAborted = false;

            const target   = $('#mapgen_target').val();
            const subtarget = $('#mapgen_subtarget').val();
            const provider = $('#mapgen_provider').val();
            const mapType  = $('#mapgen_maptype').val();
            const layer    = drawnItems.getLayers()[0];
            const bounds   = layer.getBounds();
            const minZ     = Number.parseInt($('#mapgen_min_zoom').val(), 10);
            const maxZ     = Number.parseInt($('#mapgen_max_zoom').val(), 10);
            const forceOverwrite = $('#mapgen_overwrite').is(':checked');

            const zip = isZipMode ? new JSZip() : null;
            const tiles = buildTileList(bounds, minZ, maxZ);

            const total = tiles.length;
            let processed = 0;
            let failedCount = 0;
            const startTime = Date.now();

            // Switch to progress view
            $('#mapgen_modal_confirm').hide();
            $('#mapgen_modal_cancel').text('Abort');
            $('#mapgen_progress_section').show();
            $('#mapgen_progress_fill').css('width', '0%');
            updateProgress(0, total, startTime, 0);

            let nextTileIndex = 0, consecutiveErrors = 0;
            const failedTiles = [];
            const workerCount = Math.max(1, Math.min(TILE_CONCURRENCY, tiles.length));

            const workers = Array.from({ length: workerCount }, async () => {
                const { canvas, ctx } = createWorkerCanvas();
                while (!syncAborted) {
                    if (consecutiveErrors >= 5) await sleep(1500);
                    else if (consecutiveErrors >= 2) await sleep(500);
                    const currentIndex = nextTileIndex++;
                    if (currentIndex >= tiles.length) break;

                    const { z, tz, x, y } = tiles[currentIndex];
                    try {
                        const pathArr = getTilePath({ target, isZipMode, provider, mapType, z, x, y, subtarget });

                        if (isZipMode) {
                            const buf = await fetchResizedTileWithRetry(provider, mapType, tz, x, y, canvas, ctx, target);
                            addTileToZip(zip, pathArr, buf);
                        } else {
                            const fullPath = sdPath + '/' + pathArr.join('/');

                            if (!forceOverwrite && await tileExistsOnSD(fullPath)) {
                                processed++;
                                updateProgress(processed, total, startTime, failedCount);
                                continue;
                            }

                            const buf = await fetchResizedTileWithRetry(provider, mapType, tz, x, y, canvas, ctx, target);
                            await globalThis.electronAPI.writeFile(fullPath, new Uint8Array(buf));
                        }
                        consecutiveErrors = 0;
                    } catch (err) {
                        failedCount++;
                        consecutiveErrors++;
                        failedTiles.push({ z, tz, x, y });
                        console.warn(`Tile failed z${z} x${x} y${y}:`, err.message);
                    } finally {
                        processed++;
                        updateProgress(processed, total, startTime, failedCount);
                    }
                }
            });

            await Promise.all(workers);

            /* Auto-retry failed tiles after cooldown — rate limits likely expired by now. */
            if (failedTiles.length > 0 && !syncAborted) {
                const retryCount = failedTiles.length;
                console.log(`Retrying ${retryCount} failed tile(s) after cooldown...`);
                $('#mapgen_download_status').text('Cooling down before retry...');
                await sleep(3000);

                let retryRecovered = 0, retryIndex = 0;
                const retryWorkers = Array.from({ length: Math.max(1, Math.min(2, retryCount)) }, async () => {
                    const { canvas, ctx } = createWorkerCanvas();
                    while (!syncAborted) {
                        const ci = retryIndex++;
                        if (ci >= failedTiles.length) break;
                        await sleep(400);

                        const { z, tz, x, y } = failedTiles[ci];
                        try {
                            const pathArr = getTilePath({ target, isZipMode, provider, mapType, z, x, y, subtarget });
                            if (isZipMode) {
                                const buf = await fetchResizedTileWithRetry(provider, mapType, tz, x, y, canvas, ctx, target);
                                addTileToZip(zip, pathArr, buf);
                            } else {
                                const fullPath = sdPath + '/' + pathArr.join('/');
                                const buf = await fetchResizedTileWithRetry(provider, mapType, tz, x, y, canvas, ctx, target);
                                await globalThis.electronAPI.writeFile(fullPath, new Uint8Array(buf));
                            }
                            retryRecovered++;
                            failedCount--;
                            console.log(`Recovered: z${z} x${x} y${y}`);
                        } catch (e) {
                            console.warn(`Retry failed: z${z} x${x} y${y}`);
                        }
                        $('#mapgen_download_status').text(`Retrying: ${ci + 1} / ${retryCount} (recovered: ${retryRecovered})`);
                    }
                });
                await Promise.all(retryWorkers);
                if (retryRecovered > 0) console.log(`Retry recovered ${retryRecovered} of ${retryCount} tile(s).`);
            }

            tileCache.persistSize();
            updateCacheSizeDisplay();

            if (syncAborted) return;

            if (isZipMode && zip) {
                await saveZipToFile(zip, target, subtarget);
            }

            // Show completion
            updateProgress(total, total, startTime, failedCount);

            if (failedCount > 0) {
                $('#mapgen_download_status').text(`Completed with ${failedCount} failed tile(s). Retry with Force Overwrite.`);
            } else {
                const modeMsg = isZipMode ? 'ZIP exported successfully!' : 'All tiles exported to SD successfully.';
                $('#mapgen_download_status').text(`Sync complete! ${modeMsg}`);
            }

            $('#mapgen_modal_cancel').text('Close');
        }

        async function saveZipToFile(zip, target, subtarget) {
            $('#mapgen_download_status').text('Generating ZIP file...');
            try {
                const blob = await zip.generateAsync({ type: 'arraybuffer' });
                // Name the download after the user's Project Folder Name (sanitized for use as a filename)
                const projectName = $('#mapgen_project_name').val().trim().replace(/[<>:"\/\\|?*]/g, '_');
                const zipName = target === 'yaapu' ? `${projectName}_yaapu_${subtarget}.zip` : `${projectName}_${target}.zip`;
                const result = await globalThis.electronAPI.showSaveDialog({
                    title: 'Save Map Tiles ZIP',
                    defaultPath: zipName,
                    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
                });
                if (!result.canceled && result.filePath) {
                    await globalThis.electronAPI.writeFile(result.filePath, new Uint8Array(blob));
                }
            } catch (err) {
                console.error('ZIP save failed:', err);
                $('#mapgen_download_status').text('Error: ZIP generation failed.');
            }
        }

        // Force map to recalculate size after DOM insertion
        setTimeout(() => {
            if (map) map.invalidateSize();
        }, 200);

        // Apply the initial target mode now that the map, base layers and draw group
        // exist. The cold-start syncMapOptions() above ran before map init, so its
        // updateTerrainMode() call bailed on the `if (!map) return` guard. Without this,
        // defaulting to (or restoring) the terrain target leaves the tab in tile-mode UI.
        // No-op for tile targets.
        initOfflinePanel();
        updateTerrainMode();

        // ── Terrain helper functions ────────────────────────────────
        function isTerrainMode() {
            return $('#mapgen_target').val() === 'terrain';
        }

        // Anything other than an explicit 'srtm' means Copernicus, so a missing
        // or unreadable setting still lands on the more accurate source.
        function getTerrainSource() {
            return $('#mapgen_terrain_source').val() === 'srtm' ? 'srtm' : 'copernicus';
        }

        function terrainSourceLabel() {
            return getTerrainSource() === 'srtm' ? 'Terrain — SRTM1 (30m)' : 'Terrain — Copernicus GLO-30';
        }

        function updateTerrainSourceUI() {
            const isTerrain = isTerrainMode();
            const copernicus = getTerrainSource() === 'copernicus';
            map.attributionControl.removeAttribution(TERRAIN_ATTR_SRTM);
            map.attributionControl.removeAttribution(TERRAIN_ATTR_COPERNICUS);
            if (isTerrain) {
                map.attributionControl.addAttribution(copernicus ? TERRAIN_ATTR_COPERNICUS : TERRAIN_ATTR_SRTM);
            }
            if (copernicus) {
                $('#mapgen_terrain_source_note').html(
                    'Global coverage incl. &gt;60°N.' +
                    '<div style="font-size:9px; color:#666; margin-top:3px;">' +
                    $('<span>').text(COPERNICUS_NOTICE_1).html() + '. ' +
                    $('<span>').text(COPERNICUS_NOTICE_2).html() + '.</div>');
                $('#mapgen_hint_terrain').text('Hint: One .TER file per 1°×1° grid square (~111 km). Data: Copernicus GLO-30 at 30m resolution. Ocean depths are clamped to 0m.');
            } else {
                $('#mapgen_terrain_source_note').html('Real SRTM between 60°N and 56°S. Beyond that the server only has coarse fill data (errors of tens to hundreds of metres) — use Copernicus there.');
                $('#mapgen_hint_terrain').text('Hint: One .TER file per 1°×1° grid square (~111 km). Data: NASA SRTM1 at 30m resolution. Ocean depths are clamped to 0m.');
            }
        }

        // Copernicus is fetched from a public bucket — if it cannot be reached,
        // ask before falling back to SRTM. Never switch elevation source
        // silently: the user must know which source produced the files.
        function showCopernicusFallbackPrompt(err) {
            $('#mapgen_download_status').text('Copernicus server unavailable.');
            $('#mapgen_progress_section').hide();
            $('#mapgen_modal_actions').show();
            $('#mapgen_sync_info').html(
                '<div style="color:#aaa; font-size:13px; line-height:1.6; margin:8px 0;">' +
                '<b style="color:#ff9800;">Copernicus GLO-30 is unavailable</b> (server unreachable or throttling).<br>' +
                (err ? $('<span>').text(err.message).html() + '.<br>' : '') + '<br>' +
                'You can switch this generation to the <b>NASA SRTM1</b> fallback source (real SRTM between 60°N and 56°S, coarse fill data beyond), ' +
                'or close and try Copernicus again later.</div>');
            terrainFallbackPending = true;
            $('#mapgen_modal_confirm').show().text('Switch to SRTM & Retry');
            $('#mapgen_modal_cancel').text('Close');
        }

        function getTargetCategory() {
            return isTerrainMode() ? 'fc' : 'radio';
        }

        function updateTerrainGrid() {
            if (terrainGridLayer) {
                map.removeLayer(terrainGridLayer);
                terrainGridLayer = null;
            }
            if (!isTerrainMode()) return;

            terrainGridLayer = L.layerGroup();
            const mapBounds = map.getBounds();
            const latMin = Math.floor(mapBounds.getSouth()) - 1;
            const latMax = Math.ceil(mapBounds.getNorth()) + 1;
            const lonMin = Math.floor(mapBounds.getWest()) - 1;
            const lonMax = Math.ceil(mapBounds.getEast()) + 1;

            for (let lat = latMin; lat <= latMax; lat++) {
                L.polyline([[lat, lonMin - 1], [lat, lonMax + 1]], {
                    color: '#ff6600', weight: 1, opacity: 0.5, dashArray: '6,4', interactive: false,
                }).addTo(terrainGridLayer);
            }
            for (let lon = lonMin; lon <= lonMax; lon++) {
                L.polyline([[latMin - 1, lon], [latMax + 1, lon]], {
                    color: '#ff6600', weight: 1, opacity: 0.5, dashArray: '6,4', interactive: false,
                }).addTo(terrainGridLayer);
            }

            // Shade cells whose elevation data (with edge neighbours) is in
            // the offline folder. Skipped when zoomed far out: too many cells.
            if (offlineStore.available() && (latMax - latMin) * (lonMax - lonMin) <= 4000) {
                const source = getTerrainSource();
                const readyStyle = { color: '#00e676', weight: 1, opacity: 0.8, fillColor: '#00e676', fillOpacity: 0.22, interactive: false };
                for (let lat = Math.max(latMin, -90); lat < Math.min(latMax, 90); lat++) {
                    for (let lon = lonMin; lon < lonMax; lon++) {
                        const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
                        if (cellReadyOffline(source, lat, wrapped)) {
                            L.rectangle([[lat, lon], [lat + 1, lon + 1]], readyStyle).addTo(terrainGridLayer);
                        }
                    }
                }
            }

            const selLayer = drawnItems.getLayers()[0];
            if (selLayer) {
                const sb = selLayer.getBounds();
                const sLatMin = Math.floor(sb.getSouth());
                const sLatMax = Math.floor(sb.getNorth());
                const sLonMin = Math.floor(sb.getWest());
                const sLonMax = Math.floor(sb.getEast());
                const selLats = new Set();
                const selLons = new Set();
                for (let lat = sLatMin; lat <= sLatMax + 1; lat++) selLats.add(lat);
                for (let lon = sLonMin; lon <= sLonMax + 1; lon++) selLons.add(lon);
                const solidStyle = { color: '#ff6600', weight: 2.5, opacity: 0.9, interactive: false };
                selLats.forEach(lat => {
                    L.polyline([[lat, sLonMin], [lat, sLonMax + 1]], solidStyle).addTo(terrainGridLayer);
                });
                selLons.forEach(lon => {
                    L.polyline([[sLatMin, lon], [sLatMax + 1, lon]], solidStyle).addTo(terrainGridLayer);
                });
            }

            const zoom = map.getZoom();
            if (zoom >= 6) {
                const lbl = zoom >= 8 ? { fs: 11, pad: '2px 5px', w: 80, h: 16, bg: 0.8 }
                          : zoom >= 7 ? { fs: 10, pad: '2px 4px', w: 74, h: 14, bg: 0.7 }
                                       : { fs: 9, pad: '1px 3px', w: 64, h: 13, bg: 0.55 };
                for (let lat = latMin; lat < latMax; lat++) {
                    for (let lon = lonMin; lon < lonMax; lon++) {
                        if (lat >= -90 && lat < 90 && lon >= -180 && lon < 180) {
                            L.marker([lat + 0.5, lon + 0.5], {
                                icon: L.divIcon({
                                    className: 'terrain-grid-label',
                                    html: `<span style="font-size:${lbl.fs}px;padding:${lbl.pad};background:rgba(255,102,0,${lbl.bg})">${terrainDatFilename(lat, lon)}</span>`,
                                    iconSize: [lbl.w, lbl.h],
                                    iconAnchor: [lbl.w / 2, lbl.h / 2],
                                }),
                                interactive: false,
                            }).addTo(terrainGridLayer);
                        }
                    }
                }
            }

            terrainGridLayer.addTo(map);
            updateOfflineEstimate();   // box deleted, source changed or folder re-read
        }

        function updateTerrainStatus() {
            if (!isTerrainMode()) return;
            const layer = drawnItems.getLayers()[0];
            if (!layer) {
                $('#mapgen_status').html('<span style="color:#ffb300;">Draw a rectangle to select terrain area...</span>');
                return;
            }
            const bounds = layer.getBounds();
            const latlngs = layer.getLatLngs()[0];
            const area = L.GeometryUtil.geodesicArea(latlngs);
            const unit = $('#mapgen_area_unit').val();
            const tiles = boundsCells(bounds);
            const estSizeMB = tiles.reduce((s, t) => s + estimateDatSizeMB(t.lat), 0).toFixed(0);
            const fileList = tiles.map(t => terrainDatFilename(t.lat, t.lon));
            const midLat = (bounds.getNorth() + bounds.getSouth()) / 2;
            const tileKmNS = 111.0;
            const tileKmEW = 111.0 * Math.cos(midLat * Math.PI / 180);
            const gridAreaSqM = tiles.length * tileKmNS * tileKmEW * 1e6;

            let statusHtml =
                `<span class="mapgen-area">Selected Area: ${formatArea(area, unit)}</span><br>` +
                `<span class="mapgen-area">Grid Coverage: ${tiles.length} tile(s) \u00b7 ${formatArea(gridAreaSqM, unit)}</span><br>` +
                `<span class="mapgen-tiles">Est. Size: ~${estSizeMB} MB</span><br>` +
                `<span style="color:#888; font-size:11px;">${fileList.join(', ')}</span>`;
            // Copernicus publishes no tiles north of 84\u00b0N. The SRTM fallback's
            // server answers everywhere, but outside the SRTM mission's
            // 60\u00b0N\u201356\u00b0S band it only holds coarse 2016 fill data (GMTED /
            // ETOPO1 \u2014 measured errors reach hundreds of metres), so it gets
            // a warning of its own there.
            if (getTerrainSource() === 'copernicus') {
                if (bounds.getNorth() > 84) {
                    statusHtml += `<br><span style="color:#c62828; font-size:11px;">&#9888;&#65039; Selection extends beyond Copernicus coverage (84\u00b0N). Tiles beyond will have no elevation data.</span>`;
                }
            } else if (bounds.getNorth() > 60 || bounds.getSouth() < -56) {
                statusHtml += `<br><span style="color:#c62828; font-size:11px;">&#9888;&#65039; Selection extends beyond real SRTM coverage (60\u00b0N\u201356\u00b0S). This source only has coarse fill data there \u2014 errors reach hundreds of metres. Use Copernicus instead.</span>`;
            }
            $('#mapgen_status').html(statusHtml);
        }

        function updateTerrainMode() {
            if (!map) return; // called before map init from syncMapOptions
            const isTerrain = isTerrainMode();

            // Elevation source picker (terrain only) and its attribution
            $('#mapgen_terrain_source_wrapper').toggle(isTerrain);
            $('#mapgen_terrain_source_note').toggle(isTerrain);
            updateTerrainSourceUI();

            // Zoom to terrain-friendly level
            if (isTerrain && preTerrainZoom === null) {
                preTerrainZoom = map.getZoom();
                map.setZoom(8);
            } else if (!isTerrain && preTerrainZoom !== null) {
                map.setZoom(preTerrainZoom);
                preTerrainZoom = null;
            }

            // Hide tile-specific controls in terrain mode
            // Provider, map type, project name, zoom row — always visible when not terrain
            // Provider and map type stay visible: in terrain mode they pick the map imagery.
            $('#mapgen_project_name').closest('.number').toggle(!isTerrain);
            $('.mapgen-zoom-row').toggle(!isTerrain);
            // Warnings and subtarget: only force-hide in terrain mode
            // syncMapOptions() handles their conditional visibility otherwise
            if (isTerrain) {
                $('#mapgen_subtarget_wrapper').addClass('mapgen-subtarget-hidden');
                $('#mapgen_google_warning').hide();
                $('#mapgen_yaapu_warning').hide();
                $('#mapgen_osm_warning').hide();
            }
            // Hints
            $('#mapgen_hint_tiles').toggle(!isTerrain);
            $('#mapgen_hint_terrain').toggle(isTerrain);
            // Terrain altitude controls
            $('#mapgen_terrain_alt_row').toggle(isTerrain);
            if (!isTerrain) {
                $('#mapgen_terrain_alt_toggle').prop('checked', false);
                toggleLiveAlt();
            }
            // The map keeps the chosen provider and type in terrain mode too, so
            // imagery downloaded for offline use (Esri) can be shown.
            switchMapLayer();
            // SD card label
            updateSdLabel();

            updateTerrainGrid();
            if (drawnItems.getLayers().length > 0) {
                updateSideLabels(drawnItems.getLayers()[0]);
            }
            if (isTerrain) {
                updateTerrainStatus();
                updateHgtCacheInfo();
            } else {
                $('#mapgen_clear_hgt_cache').hide();
            }
            // Offline data panel: terrain mode, desktop app only (needs a folder)
            const showOffline = isTerrain && offlineStore.available();
            $('#mapgen_offline_box').toggle(showOffline);
            if (showOffline) void refreshOfflineView();

            // Toggle cache UI: tile cache controls for map targets, HGT button for terrain
            $('.mapgen-cache-row').toggle(!isTerrain);
            $('#mapgen_cache_enabled').closest('.checkbox').toggle(!isTerrain);
            $('#mapgen_clear_cache').toggle(!isTerrain);
        }

        function updateSdLabel() {
            const isFc = getTargetCategory() === 'fc';
            if (sdPath) {
                const label = isFc ? 'Change FC SD Folder' : (i18n.getMessage('mapgenChangeSd') || 'Change SD Folder');
                $('#mapgen_link_sd').text(label);
            } else {
                const label = isFc ? 'Select FC SD Card Folder' : (i18n.getMessage('mapgenLinkSD') || 'Select SD Card Folder');
                $('#mapgen_link_sd').text(label);
            }
        }

        // ── Live altitude readout ───────────────────────────────────
        function toggleLiveAlt() {
            liveAltEnabled = $('#mapgen_terrain_alt_toggle').is(':checked');
            $('#mapgen_alt_output').toggle(liveAltEnabled);
            $('#mapgen_terrain_alt_hint').toggle(liveAltEnabled);
            if (!liveAltEnabled) $('#mapgen_alt_output').text('Alt: \u2014');
        }

        function getAltFromCache(lat, lon) {
            const tileLat = Math.floor(lat);
            const tileLon = Math.floor(lon);
            const key = tileLat + '_' + tileLon;
            const hgtView = liveAltCache[key];
            if (!hgtView) return null;
            const fracLat = Math.max(0, Math.min(1, lat - tileLat));
            const fracLon = Math.max(0, Math.min(1, lon - tileLon));
            const row = Math.max(0, Math.min(3600, Math.round((1 - fracLat) * 3600)));
            const col = Math.max(0, Math.min(3600, Math.round(fracLon * 3600)));
            const v = hgtView.getInt16((row * 3601 + col) * 2, false);
            if (v === -32768) return 0;
            return v < 0 ? 0 : v;
        }

        $('#mapgen_terrain_alt_toggle').on('change', toggleLiveAlt);

        // ── HGT cache UI ────────────────────────────────────────────
        async function updateHgtCacheInfo() {
            try {
                const cached = await hgtDb.cachedSet();
                if (cached.size > 0 && isTerrainMode()) {
                    $('#mapgen_clear_hgt_cache').text(`Clear Elevation Cache (${cached.size} tile${cached.size > 1 ? 's' : ''}, ~${formatBytes(cached.size * HGT_GRID_BYTES)})`).show();
                } else {
                    $('#mapgen_clear_hgt_cache').hide();
                }
            } catch (_) {
                $('#mapgen_clear_hgt_cache').hide();
            }
        }

        $('#mapgen_clear_hgt_cache').on('click', async () => {
            const cached = await hgtDb.cachedSet();
            if (cached.size === 0) return;
            if (!await globalThis.electronAPI.confirmDialog(`Clear ${cached.size} cached elevation tile(s) (~${formatBytes(cached.size * HGT_GRID_BYTES)})?`)) return;
            await hgtDb.clear();
            liveAltCache = {};
            updateHgtCacheInfo();
        });

        // ── Offline data panel ──────────────────────────────────────
        // Downloads elevation originals and Esri imagery into the offline
        // folder (offlineStore). Files already there are skipped, so running
        // the same download again resumes an interrupted one.
        const OFFLINE_ELEVATION_CONCURRENCY = 2;
        const OFFLINE_IMAGERY_CONCURRENCY = 4;

        function initOfflinePanel() {
            const $region = $('#mapgen_offline_region').empty();
            $region.append($('<option>').val('box').text('Drawn box'));
            for (const r of REGIONS) $region.append($('<option>').val(r.id).text(r.name));
            const savedRegion = store.get('mapgen_offline_region', 'box');
            $region.val(regionById(savedRegion) ? savedRegion : 'box');

            const $zoom = $('#mapgen_offline_zoom').empty();
            $zoom.append($('<option>').val('-1').text('No imagery'));
            for (let z = 0; z <= BOX_IMAGERY_ZOOM; z++) $zoom.append($('<option>').val(String(z)).text(String(z)));
            setOfflineDefaultZoom();
            updateOfflineDirLabel();
        }

        function setOfflineDefaultZoom() {
            const r = regionById($('#mapgen_offline_region').val());
            $('#mapgen_offline_zoom').val(String(r ? r.imageryZoom : BOX_IMAGERY_ZOOM));
        }

        function updateOfflineDirLabel() {
            if (!offlineStore.available()) return;
            $('#mapgen_offline_dir').text(offlineStore.dir());
        }

        async function refreshOfflinePresent() {
            if (!offlineStore.available()) return;
            offlinePresent = {
                srtm: await offlineStore.elevationNames('srtm'),
                copernicus: await offlineStore.elevationNames('copernicus'),
            };
            offlinePresentGen++;
        }

        // A cell is ready offline when its own file and the E/N/NE neighbour
        // files its edges are filled from are all in the folder.
        function cellReadyOffline(source, lat, lon) {
            if (!hasCellFile(source, lat, lon)) return false;
            return withNeighbours([{ lat, lon }], source).every(c =>
                !hasCellFile(source, c.lat, c.lon) || offlinePresent[source].has(elevationFileName(source, c.lat, c.lon)));
        }

        async function updateOfflineSizes() {
            if (!offlineStore.available()) return;
            const parts = [
                ['elevation/copernicus', 'Copernicus'],
                ['elevation/srtm', 'SRTM'],
                ['imagery', 'Imagery'],
            ];
            const rows = [];
            for (const [rel, label] of parts) {
                const s = await globalThis.electronAPI.dirSize(offlineStore.path(rel));
                if (!s?.files) continue;
                rows.push(`<div>${label}: ${s.files.toLocaleString()} file${s.files > 1 ? 's' : ''}, ${formatBytes(s.bytes)}` +
                    `<a href="#" class="mapgen-offline-clear" data-rel="${rel}" data-label="${label}">Clear</a></div>`);
            }
            $('#mapgen_offline_sizes').html(rows.length
                ? '<div class="mapgen-offline-estimate-title">Already in the folder</div>' + rows.join('')
                : 'The folder has no offline data yet.');
        }

        async function refreshOfflineView() {
            await refreshOfflinePresent();
            offlineFree = await globalThis.electronAPI.diskFree(offlineStore.dir()) ?? null;
            if (isTerrainMode()) updateTerrainGrid();
            updateOfflineEstimate();
            await updateOfflineSizes();
        }

        // ── Live size estimate ──────────────────────────────────────
        // Shown in the panel and updated as the region, box, zoom, layers or
        // elevation source change, so the size is known before Download.
        // Coalesced to one render per 50 ms: dragging a box edge calls this on
        // every mouse move. A timer, not requestAnimationFrame, which stops
        // while the window is hidden.
        function updateOfflineEstimate() {
            if (offlineEstimateQueued) return;
            offlineEstimateQueued = true;
            setTimeout(() => {
                offlineEstimateQueued = false;
                renderOfflineEstimate();
            }, 50);
        }

        // The elevation part of the plan, cached: for a big region it walks
        // tens of thousands of cells (~100 ms for the globe), and it only
        // changes with the area, the source or the folder's contents.
        function offlineElevationPlan(area) {
            const key = JSON.stringify([area.bounds, offlinePresentGen]);
            if (offlineElevationMemo.key !== key) {
                offlineElevationMemo = { key, plan: planDownload({ cells: area.cells, present: offlinePresent, imagery: null }) };
            }
            return offlineElevationMemo.plan;
        }

        // Each zoom choice shows how big the imagery would be, for the current
        // area and layers, so the depth can be picked by size.
        function updateOfflineZoomLabels(area, layers) {
            const totals = area && layers.length ? imageryTotalsByZoom(area.bounds, layers, BOX_IMAGERY_ZOOM) : null;
            $('#mapgen_offline_zoom option').each((_, opt) => {
                const z = Number.parseInt(opt.value, 10);
                if (z < 0) return;
                opt.textContent = totals ? `${z} — ${formatBytes(totals[z].bytes)}` : String(z);
            });
        }

        function renderOfflineEstimate() {
            const $est = $('#mapgen_offline_estimate');
            if (!offlineStore.available() || !$('#mapgen_offline_box').is(':visible')) return;
            const area = offlineArea();
            const layers = offlineLayers();
            updateOfflineZoomLabels(area, layers);
            if (!area) {
                $est.html('<div class="mapgen-offline-note">Draw a box on the map, or pick a region, to see the download size.</div>');
                return;
            }

            const source = getTerrainSource();
            const sourceName = { srtm: 'SRTM', copernicus: 'Copernicus' }[source];
            const zMax = Number.parseInt($('#mapgen_offline_zoom').val(), 10);
            const imagery = zMax >= 0 && layers.length ? imageryTotalsByZoom(area.bounds, layers, zMax)[zMax] : null;
            const plan = offlineElevationPlan(area);
            const el = plan.elevation[source];
            const imageryBytes = imagery?.bytes || 0;
            const needBytes = el.missingBytes + imageryBytes;
            const tooBig = offlineFree !== null && offlineFree < needBytes;

            const row = (label, value, cls = '') => `<div class="mapgen-offline-estimate-row ${cls}"><span>${label}</span><span>${value}</span></div>`;
            let html = '<div class="mapgen-offline-estimate-title">This download</div>';
            html += row(`Elevation (${sourceName}):`, el.files === 0
                ? 'none needed (sea)'
                : el.missing.length === 0
                    ? `all ${el.files.toLocaleString()} files in folder`
                    : `${formatBytes(el.missingBytes)}, ${el.missing.length.toLocaleString()} of ${el.files.toLocaleString()} files`);
            html += row('Imagery:', imagery
                ? `up to ${formatBytes(imageryBytes)}, ${(imagery.tiles * layers.length).toLocaleString()} tiles`
                : 'none');
            html += row('Total:', `up to ${formatBytes(needBytes)}`, 'mapgen-offline-estimate-total');
            if (offlineFree !== null) {
                html += row('Free space:', formatBytes(offlineFree), tooBig ? 'mapgen-offline-warn' : '');
            }
            html += row('Time at 100 Mbit/s:', needBytes > 0 ? formatDuration(needBytes / 12.5e6) : '—');
            html += row('.TER on SD card:', formatBytes(plan.terBytes[source]));
            $est.html(html);
        }

        function offlineLayers() {
            const ids = [];
            if ($('#mapgen_offline_sat').is(':checked')) ids.push('esri_satellite');
            if ($('#mapgen_offline_street').is(':checked')) ids.push('esri_street');
            if ($('#mapgen_offline_labels').is(':checked')) ids.push('esri_labels');
            return ids;
        }

        // The cells and imagery bounds of the chosen region or the drawn box.
        function offlineArea() {
            const r = regionById($('#mapgen_offline_region').val());
            if (r) {
                return {
                    name: r.name, cells: cellsForRange(r),
                    bounds: { south: r.lat0, west: r.lon0, north: r.lat1 + 1, east: r.lon1 + 1 },
                };
            }
            const layer = drawnItems.getLayers()[0];
            if (!layer) return null;
            const b = layer.getBounds();
            return {
                name: 'Drawn box', cells: boundsCells(b),
                bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
            };
        }

        function offlineInfoRow(label, value) {
            return `<div class="mapgen-info-row"><span>${label}</span><span>${value}</span></div>`;
        }

        async function showOfflineConfirm() {
            const area = offlineArea();
            if (!area) {
                $('#mapgen_status').text('Draw a rectangle first, or pick a region in Offline Data.');
                return;
            }
            const source = getTerrainSource();
            const other = source === 'srtm' ? 'copernicus' : 'srtm';
            const sourceName = { srtm: 'NASA SRTM1', copernicus: 'Copernicus GLO-30' };
            const zMax = Number.parseInt($('#mapgen_offline_zoom').val(), 10);
            const layers = zMax >= 0 ? offlineLayers() : [];

            await refreshOfflinePresent();
            const plan = planDownload({
                cells: area.cells,
                present: offlinePresent,
                imagery: layers.length ? { ...area.bounds, zMax, layers } : null,
            });
            const el = plan.elevation[source];
            const elOther = plan.elevation[other];
            const imageryBytes = plan.imagery?.bytes || 0;
            const needBytes = el.missingBytes + imageryBytes;
            const free = await globalThis.electronAPI.diskFree(offlineStore.dir());
            const tooBig = free !== null && free !== undefined && free < needBytes;

            const esc = s => $('<span>').text(s).html();
            let html =
                offlineInfoRow('Region:', esc(area.name)) +
                offlineInfoRow('Folder:', `<span style="font-size:11px;">${esc(offlineStore.dir())}</span>`) +
                offlineInfoRow('Elevation source:', sourceName[source]) +
                offlineInfoRow('1° cells:', `${plan.cells.toLocaleString()} (${el.cells.toLocaleString()} with edge neighbours)`) +
                offlineInfoRow('Elevation files:', `${el.files.toLocaleString()} · ${el.present.toLocaleString()} already in folder · ${el.missing.length.toLocaleString()} to download`) +
                offlineInfoRow('Elevation download:', `${formatBytes(el.missingBytes)} (all files: ${formatBytes(el.totalBytes)})`) +
                offlineInfoRow(`${sourceName[other]} instead:`, `${formatBytes(elOther.totalBytes)} for ${elOther.files.toLocaleString()} files`);
            if (plan.imagery) {
                const names = { esri_satellite: 'satellite', esri_street: 'street', esri_labels: 'labels' };
                html += offlineInfoRow('Imagery:', `Esri ${plan.imagery.layers.map(id => names[id]).join(' + ')}, zoom 0–${plan.imagery.zMax}`) +
                    offlineInfoRow('Imagery tiles:', `${plan.imagery.files.toLocaleString()} files, about ${formatBytes(imageryBytes)} (tiles already saved are skipped)`);
            } else {
                html += offlineInfoRow('Imagery:', 'none');
            }
            html += offlineInfoRow('Total download:', `up to ${formatBytes(needBytes)}`) +
                offlineInfoRow('Free space:', free === null || free === undefined ? 'unknown'
                    : (tooBig ? `<span class="mapgen-offline-warn">${formatBytes(free)} — not enough</span>` : formatBytes(free))) +
                offlineInfoRow('Time at 100 Mbit/s:', needBytes > 0 ? formatDuration(plan.seconds[source]) : '—') +
                offlineInfoRow('.TER files if generated:', `${formatBytes(plan.terBytes[source])} (on the SD card, not in this folder)`);

            const notes = [];
            notes.push(source === 'copernicus'
                ? esc(COPERNICUS_NOTICE_1) + '. ' + esc(COPERNICUS_NOTICE_2) + '.'
                : 'NASA SRTM data is public domain. Outside 60°N–56°S this server only has coarse fill data.');
            if (plan.imagery) {
                notes.push('Esri tiles are saved for your own offline use only; don\'t share or publish them.');
            }
            notes.push(`Elevation data comes from public AWS buckets (index of ${CELL_INDEX_INFO.date}). Files download ${OFFLINE_ELEVATION_CONCURRENCY} at a time, imagery ${OFFLINE_IMAGERY_CONCURRENCY} at a time. Abort at any time; running the same download again picks up where it stopped.`);
            html += `<div class="mapgen-offline-note">${notes.join('<br>')}</div>`;

            const nothingToDo = el.missing.length === 0 && !plan.imagery;
            if (nothingToDo) {
                html += '<div class="mapgen-offline-note"><b>Everything for this area is already in the folder.</b></div>';
            } else if (tooBig) {
                html += '<div class="mapgen-offline-note mapgen-offline-warn">Not enough free space on that drive. Pick a smaller area, lower the imagery zoom, or choose another folder.</div>';
            }

            offlineJob = { state: 'confirm', source, plan };
            $('#mapgen_sync_info').html(html);
            $('#mapgen_modal_header').text('Download for Offline Use');
            $('#mapgen_progress_section').hide();
            $('#mapgen_modal_actions').show();
            $('#mapgen_modal_confirm').text('Download').toggle(!nothingToDo && !tooBig);
            $('#mapgen_modal_cancel').text(nothingToDo || tooBig ? 'Close' : 'Cancel');
            showModal();
        }

        function* offlineImageryItems(imagery) {
            for (const t of tilesInRanges(imagery.ranges)) {
                for (const id of imagery.layers) {
                    const layer = IMAGERY_LAYERS[id];
                    yield {
                        kind: 'imagery',
                        url: layer.url(t.z, t.x, t.y),
                        path: imageryLocalPath(layer.provider, layer.type, t.z, t.x, t.y, layer.ext),
                        estBytes: layer.avgBytes,
                    };
                }
            }
        }

        function offlineElevationItems(source, cells) {
            return cells.map(c => {
                const f = elevationFile(source, c.lat, c.lon);
                return { kind: 'elevation', url: f.url, path: f.path, estBytes: cellFileBytes(source, c.lat, c.lon) };
            });
        }

        // Runs `workers` downloads at a time from a shared iterator.
        async function runOfflineQueue(iter, workers, job) {
            await Promise.all(Array.from({ length: workers }, async () => {
                for (;;) {
                    while (job.paused && !job.aborted) await new Promise(r => setTimeout(r, 250));
                    if (job.aborted) return;
                    const next = iter.next();
                    if (next.done) return;
                    const item = next.value;
                    const res = await globalThis.electronAPI.downloadToFile(item.url, offlineStore.path(item.path), { skipIfExists: true });
                    if (job.aborted && res.status === 'error') return;   // cut off by Abort, not a failure
                    job.done++;
                    job.leftBytes = Math.max(0, job.leftBytes - item.estBytes);
                    if (res.status === 'exists') {
                        job.skipped++;
                    } else if (res.status === 404) {
                        job.notFound++;
                    } else if (typeof res.status === 'number' && res.status >= 200 && res.status < 300) {
                        job.bytes += res.bytes;
                        job.downloaded++;
                    } else {
                        item.error = res.error || `HTTP ${res.status}`;
                        job.failed.push(item);
                    }
                }
            }));
        }

        function renderOfflineProgress(job) {
            const now = Date.now();
            job.samples.push([now, job.bytes]);
            while (job.samples.length > 2 && now - job.samples[0][0] > 10000) job.samples.shift();
            const [t0, b0] = job.samples[0];
            const speed = now > t0 ? (job.bytes - b0) / ((now - t0) / 1000) : 0;
            const pct = job.total > 0 ? job.done / job.total * 100 : 100;
            $('#mapgen_progress_fill').css('width', pct + '%');
            let text = `${job.done.toLocaleString()} / ${job.total.toLocaleString()} files · ${formatBytes(job.bytes)} downloaded`;
            if (job.paused) {
                text += ' · Paused (files in progress finish first)';
            } else if (speed > 0) {
                text += ` · ${formatBytes(speed)}/s · ${formatDuration(job.leftBytes / speed)} left`;
            }
            if (job.failed.length) text += ` · Failed: ${job.failed.length}`;
            $('#mapgen_download_status').text(text);
        }

        async function runOfflineDownload(elevationItems, imageryIter, imageryCount) {
            const job = offlineJob;
            Object.assign(job, {
                state: 'running', paused: false, aborted: false,
                total: elevationItems.length + imageryCount,
                leftBytes: elevationItems.reduce((s, i) => s + i.estBytes, 0) + (imageryCount ? job.plan.imagery.bytes / job.plan.imagery.files * imageryCount : 0),
                done: 0, downloaded: 0, skipped: 0, notFound: 0, bytes: 0, failed: [],
                samples: [],
            });

            $('#mapgen_progress_section').show();
            $('#mapgen_progress_fill').css('width', '0%');
            $('#mapgen_modal_confirm').show().text('Pause');
            $('#mapgen_modal_cancel').text('Abort');
            renderOfflineProgress(job);
            const timer = setInterval(() => renderOfflineProgress(job), 500);
            try {
                await Promise.all([
                    runOfflineQueue(elevationItems[Symbol.iterator](), OFFLINE_ELEVATION_CONCURRENCY, job),
                    runOfflineQueue(imageryIter, OFFLINE_IMAGERY_CONCURRENCY, job),
                ]);
            } finally {
                clearInterval(timer);
            }
            renderOfflineProgress(job);

            job.state = 'done';
            let summary = job.aborted ? 'Stopped. ' : 'Finished. ';
            summary += `${job.downloaded.toLocaleString()} downloaded (${formatBytes(job.bytes)}), ${job.skipped.toLocaleString()} already in folder`;
            if (job.notFound) summary += `, ${job.notFound.toLocaleString()} not on the server`;
            if (job.failed.length) summary += `, ${job.failed.length.toLocaleString()} failed (first: ${job.failed[0].error})`;
            summary += '.';
            if (job.aborted) summary += ' Run the same download again to resume.';
            $('#mapgen_download_status').text(summary);
            $('#mapgen_modal_confirm').text('Retry Failed').toggle(job.failed.length > 0 && !job.aborted);
            $('#mapgen_modal_cancel').text('Close');
            await refreshOfflineView();
        }

        async function offlineConfirmClicked() {
            const job = offlineJob;
            if (job.state === 'confirm') {
                const plan = job.plan;
                const elevation = offlineElevationItems(job.source, plan.elevation[job.source].missing);
                const imageryIter = plan.imagery ? offlineImageryItems(plan.imagery) : [][Symbol.iterator]();
                await runOfflineDownload(elevation, imageryIter, plan.imagery?.files || 0);
            } else if (job.state === 'running') {
                job.paused = !job.paused;
                $('#mapgen_modal_confirm').text(job.paused ? 'Resume' : 'Pause');
                renderOfflineProgress(job);
            } else if (job.state === 'done' && job.failed.length) {
                const failed = job.failed;
                const elevation = failed.filter(i => i.kind === 'elevation');
                const imagery = failed.filter(i => i.kind === 'imagery');
                await runOfflineDownload(elevation, imagery[Symbol.iterator](), imagery.length);
            }
        }

        function offlineCancelClicked() {
            const job = offlineJob;
            if (job.state === 'running') {
                stopOfflineDownload();
                $('#mapgen_download_status').text('Stopping…');
                return;
            }
            offlineJob = null;
            hideModal();
        }

        stopOfflineDownload = () => {
            if (offlineJob?.state !== 'running') return;
            offlineJob.aborted = true;
            offlineJob.paused = false;
            void globalThis.electronAPI.abortDownloads();
        };

        $('#mapgen_offline_region').on('change', () => {
            store.set('mapgen_offline_region', $('#mapgen_offline_region').val());
            setOfflineDefaultZoom();
            updateOfflineEstimate();
        });

        $('#mapgen_offline_zoom, #mapgen_offline_sat, #mapgen_offline_street, #mapgen_offline_labels')
            .on('change', () => updateOfflineEstimate());

        $('#mapgen_offline_change').on('click', async (e) => {
            e.preventDefault();
            const result = await globalThis.electronAPI.showOpenDialog({
                title: 'Select Offline Data Folder',
                defaultPath: offlineStore.dir(),
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || !result.filePaths?.length) return;
            store.set('mapgen_offline_dir', result.filePaths[0]);
            updateOfflineDirLabel();
            await refreshOfflineView();
        });

        $('#mapgen_offline_download').on('click', (e) => {
            e.preventDefault();
            void showOfflineConfirm();
        });

        $('#mapgen_offline_sizes').on('click', '.mapgen-offline-clear', async (e) => {
            e.preventDefault();
            const rel = $(e.currentTarget).data('rel');
            const label = $(e.currentTarget).data('label');
            if (!await globalThis.electronAPI.confirmDialog(`Delete all ${label} files from the offline folder?\n${offlineStore.path(rel)}`)) return;
            const err = await globalThis.electronAPI.rm(offlineStore.path(rel));
            if (err) $('#mapgen_status').text('Could not clear: ' + err);
            if (rel === 'imagery') browseCache.reset();
            await refreshOfflineView();
        });

        // ── Terrain sync pipeline ───────────────────────────────────
        async function showTerrainSyncModal() {
            const layer = drawnItems.getLayers()[0];
            if (!layer) {
                $('#mapgen_status').text('Error: Please draw a rectangle to select terrain area.');
                return;
            }

            syncAborted = false;
            const bounds = layer.getBounds();
            const tiles = boundsCells(bounds);
            const fileList = tiles.map(t => terrainDatFilename(t.lat, t.lon));
            const totalSizeMB = tiles.reduce((s, t) => s + estimateDatSizeMB(t.lat), 0).toFixed(0);

            // Every land cell the run reads (each cell plus its E/N/NE
            // neighbours), and how many are already in the IndexedDB cache or
            // the offline folder. Sea cells need no data.
            const copernicus = getTerrainSource() === 'copernicus';
            const source = copernicus ? 'copernicus' : 'srtm';
            const landCells = withNeighbours(tiles, source).filter(c => hasCellFile(source, c.lat, c.lon));
            const cachedSetKeys = await hgtDb.cachedSet();
            const folderNames = await offlineStore.elevationNames(source);
            const cachePrefix = copernicus ? COPERNICUS_CACHE_PREFIX : '';
            let cachedCount = 0;
            landCells.forEach(c => {
                if (cachedSetKeys.has(cachePrefix + cellKey(c)) || folderNames.has(elevationFileName(source, c.lat, c.lon))) {
                    cachedCount++;
                }
            });
            const plan = planDownload({ cells: tiles, present: { [source]: folderNames } });
            const sourceUnit = copernicus ? 'GLO-30 tiles' : 'HGT tiles';
            const totalHgt = landCells.length;
            const cacheInfo = totalHgt === 0
                ? 'None needed (sea)'
                : cachedCount === totalHgt
                    ? `<span style="color:#87b025;">Offline ready: all ${totalHgt} ${sourceUnit} cached \u2014 no download needed</span>`
                    : `${cachedCount} of ${totalHgt} ${sourceUnit} cached; the rest needs internet ` +
                      `(up to ${formatBytes(plan.elevation[source].missingBytes)})`;

            const hasSD = !!sdPath;
            let infoHtml = `
                <div class="mapgen-info-row"><span>Target:</span><span>${terrainSourceLabel()}</span></div>
                <div class="mapgen-info-row"><span>Terrain Files:</span><span>${tiles.length} .TER file(s)</span></div>
                <div class="mapgen-info-row"><span>Est. Output:</span><span>~${totalSizeMB} MB</span></div>
                <div class="mapgen-info-row"><span>Elevation Download:</span><span>${cacheInfo}</span></div>
                <div class="mapgen-info-row"><span>Files:</span><span style="font-size:10px;">${fileList.join(', ')}</span></div>
            `;
            if (hasSD) {
                infoHtml += `<div class="mapgen-info-row"><span>SD Path:</span><span style="font-size:11px;">${$('<span>').text(sdPath).html()}</span></div>`;
                infoHtml += `<div style="margin:6px 0; font-size:11px; color:#888;">\u26a0\ufe0f FREESPAC.E will be auto-deleted from SD card during sync. INAV will recreate it on next boot.</div>`;
            } else {
                infoHtml += `<div style="margin:6px 0; font-size:11px; color:#888;">\u26a0\ufe0f Delete FREESPAC.E from the SD card before copying. INAV will recreate it on next boot.</div>`;
            }
            infoHtml += copernicus
                ? `<div style="font-size:12px; color:#888; line-height:1.5;">Source: Copernicus GLO-30 (WorldDEM-30), 30m<br>` +
                  `<span style="font-size:9px; color:#777;">${$('<span>').text(COPERNICUS_NOTICE_1).html()}. ${$('<span>').text(COPERNICUS_NOTICE_2).html()}.</span></div>`
                : `<div style="font-size:12px; color:#888; line-height:1.5;">Source: NASA SRTM 30m elevation data (public domain)</div>`;

            $('#mapgen_sync_info').html(infoHtml);
            $('#mapgen_modal_header').text('INAV Terrain Generator');
            $('#mapgen_progress_section').hide();
            $('#mapgen_modal_actions').show();
            $('#mapgen_modal_confirm').show().text(hasSD ? 'Generate & Sync' : 'Generate & Download ZIP');
            $('#mapgen_modal_cancel').text('Cancel');
            showModal();
        }

        // Ends a generation run that hit an error before anything was written.
        function stopTerrainRun(err) {
            $('#mapgen_download_status').text(`❌ ${err.message}. Generation stopped — no files were written.`);
            $('#mapgen_modal_cancel').text('Close');
            $('#mapgen_modal_confirm').hide();
        }

        async function terrainGenerateAndSync() {
            const layer = drawnItems.getLayers()[0];
            if (!layer) return;

            syncAborted = false;
            const bounds = layer.getBounds();
            const tiles = boundsCells(bounds);
            const totalTiles = tiles.length;
            let completed = 0;
            const datFiles = [];
            const terrainIo = makeTerrainIo();
            const hgtCache = {};
            const copernicusImages = {};
            const startTime = Date.now();
            const hasSD = !!sdPath;
            const forceOverwrite = $('#mapgen_overwrite').is(':checked');

            // Switch to progress view
            $('#mapgen_modal_header').text('Generating Terrain Files...');
            $('#mapgen_modal_confirm').hide();
            $('#mapgen_modal_cancel').text('Abort');
            $('#mapgen_progress_section').show();
            $('#mapgen_progress_fill').css('width', '0%');
            $('#mapgen_download_status').text('Starting...');

            for (let ti = 0; ti < tiles.length; ti++) {
                if (syncAborted) break;
                const tile = tiles[ti];
                const name = srtmTileName(tile.lat, tile.lon);
                const prefix = `Tile ${completed + 1}/${totalTiles}: `;
                const primaryKey = tile.lat + '_' + tile.lon;
                let cellCache = hgtCache;
                const isCopernicus = getTerrainSource() === 'copernicus';

                if (isCopernicus) {
                    try {
                        cellCache = await ensureCopernicusCellData(tile.lat, tile.lon, hgtCache, copernicusImages, (stage, a, b) => {
                            const msg = stage === 'downloading' ? `⬇️ Downloading ${name} (Copernicus)...`
                                : stage === 'decoding' ? `📦 Decoding ${name} (${(a / 1048576).toFixed(1)} MB)...`
                                    : stage === 'edges' ? `🧩 Fetching ${name} edge data...`
                                        : `🧮 Building ${name} grid (${Math.round(a / b * 100)}%)`;
                            $('#mapgen_download_status').text(prefix + msg);
                        }, terrainIo);
                    } catch (e) {
                        if (syncAborted) break;
                        console.warn(`Copernicus fetch failed for ${name}:`, e.message);
                        if (e instanceof MissingElevationError) {
                            showCopernicusFallbackPrompt(e);
                        } else {
                            stopTerrainRun(e);
                        }
                        return;
                    }
                    if (!cellCache) {
                        $('#mapgen_download_status').text(prefix + `⚠️ No Copernicus data for ${name} (outside coverage). Skipping.`);
                        completed++;
                        continue;
                    }
                }

                // SRTM: the cell and its E/N/NE neighbours, from the caches, the
                // offline folder or the server. Data that exists but can't be had
                // stops the run: a missing grid would come out as sea level.
                if (!isCopernicus) {
                    try {
                        await ensureSrtmCellData(tile.lat, tile.lon, hgtCache, terrainIo, stage => {
                            const msg = stage === 'cached' ? '✅ Cached ' + name
                                : stage === 'local' ? '✅ From offline folder: ' + name
                                    : stage === 'connecting' ? '⬇️ Connecting to SRTM server...'
                                        : stage === 'downloading' ? `⬇️ Downloading ${name}.hgt.gz...`
                                            : stage === 'downloaded' ? `✅ Downloaded ${name}`
                                                : `📦 Decompressing ${name}...`;
                            $('#mapgen_download_status').text(prefix + msg);
                        });
                    } catch (e) {
                        if (syncAborted) break;
                        console.warn(`SRTM data missing for ${name}:`, e.message);
                        stopTerrainRun(e);
                        return;
                    }
                }

                // Convert elevation grid → .TER
                $('#mapgen_download_status').text(prefix + `\u2699\ufe0f Converting ${name} to .TER...`);
                try {
                    const datData = await createDatFromHgt(tile.lat, tile.lon, cellCache, (done, total) => {
                        const pct = ((completed + done / total) / totalTiles * 100).toFixed(0);
                        $('#mapgen_progress_fill').css('width', pct + '%');
                        $('#mapgen_download_status').text(prefix + `\u2699\ufe0f Converting ${name} (${Math.round(done / total * 100)}%)`);
                    });
                    datFiles.push({ name: terrainDatFilename(tile.lat, tile.lon), data: datData });
                    $('#mapgen_download_status').text(prefix + `\u2705 ${terrainDatFilename(tile.lat, tile.lon)} (${(datData.length / 1048576).toFixed(1)} MB)`);
                } catch (e) {
                    // A conversion failure (e.g. the packer's self-check) stops the
                    // whole run. Writing an incomplete tile set and reporting success
                    // would silently leave the FC without terrain for that square.
                    console.warn(`Conversion failed for ${name}:`, e.message);
                    $('#mapgen_download_status').text(
                        `❌ ${terrainDatFilename(tile.lat, tile.lon)} could not be generated: ${e.message}. ` +
                        'Generation stopped — no files were written.');
                    $('#mapgen_modal_cancel').text('Close');
                    $('#mapgen_modal_confirm').hide();
                    return;
                }
                completed++;
            }

            // Share downloaded HGT tiles with live altitude readout
            Object.keys(hgtCache).forEach(k => { liveAltCache[k] = hgtCache[k]; });
            updateHgtCacheInfo();

            if (syncAborted || datFiles.length === 0) {
                if (datFiles.length === 0) {
                    $('#mapgen_download_status').text('No files generated.');
                    $('#mapgen_modal_cancel').text('Close');
                    $('#mapgen_modal_confirm').hide();
                }
                return;
            }

            // Write to SD or download as ZIP
            if (hasSD) {
                await writeTerrainToSD(datFiles, forceOverwrite);
            } else {
                await downloadTerrainZip(datFiles);
            }
        }

        async function writeTerrainToSD(datFiles, forceOverwrite) {
            $('#mapgen_modal_header').text('Writing to SD Card...');
            $('#mapgen_download_status').text('Writing to SD card: 0 / ' + datFiles.length + '...');
            $('#mapgen_progress_fill').css('width', '0%');

            // Try to delete FREESPAC.E
            try {
                await globalThis.electronAPI.rm(sdPath + '/FREESPAC.E');
            } catch (_) { /* OK */ }

            const startTime = Date.now();
            const total = datFiles.length;
            let processed = 0;
            let failedCount = 0;
            let skipped = 0;
            const totalBytes = datFiles.reduce((s, f) => s + f.data.length, 0);
            let writtenBytes = 0;

            for (let i = 0; i < datFiles.length; i++) {
                if (syncAborted) break;
                const df = datFiles[i];
                const fullPath = sdPath + '/' + df.name;
                try {
                    if (!forceOverwrite) {
                        const exists = await tileExistsOnSD(fullPath);
                        if (exists) {
                            skipped++;
                            writtenBytes += df.data.length;
                            processed++;
                            const pct = totalBytes > 0 ? (writtenBytes / totalBytes * 100) : 0;
                            $('#mapgen_progress_fill').css('width', pct.toFixed(0) + '%');
                            $('#mapgen_download_status').text(`Skipped (exists): ${df.name}`);
                            continue;
                        }
                    }
                    await globalThis.electronAPI.writeFile(fullPath, df.data);
                    writtenBytes += df.data.length;
                    const pct = totalBytes > 0 ? (writtenBytes / totalBytes * 100) : 0;
                    $('#mapgen_progress_fill').css('width', pct.toFixed(0) + '%');
                    const elapsed = Date.now() - startTime;
                    if (writtenBytes > 0 && elapsed > 500) {
                        const remainMs = Math.max(0, elapsed / writtenBytes * (totalBytes - writtenBytes));
                        const mins = Math.floor(remainMs / 60000);
                        const secs = Math.ceil((remainMs % 60000) / 1000);
                        const speed = (writtenBytes / 1024 / (elapsed / 1000)).toFixed(0);
                        $('#mapgen_download_status').text(`Writing ${df.name}... ${pct.toFixed(0)}% (${speed} KB/s, ${mins}:${secs.toString().padStart(2, '0')} remaining)`);
                    }
                } catch (e) {
                    failedCount++;
                    console.warn(`Failed: ${df.name}: ${e.message}`);
                }
                processed++;
            }

            if (syncAborted) return;
            showTerrainComplete(total, failedCount, skipped, true);
        }

        async function downloadTerrainZip(datFiles) {
            $('#mapgen_download_status').text('Creating ZIP...');
            $('#mapgen_progress_fill').css('width', '0%');

            const copernicus = getTerrainSource() === 'copernicus';
            const zip = new JSZip();
            for (const df of datFiles) {
                zip.file(df.name, df.data);
            }
            if (copernicus) zip.file('NOTICE.txt', copernicusNoticeText());

            const blob = await zip.generateAsync({ type: 'arraybuffer' });
            const result = await globalThis.electronAPI.showSaveDialog({
                title: 'Save Terrain Files ZIP',
                defaultPath: copernicus ? 'INAV_Terrain_Copernicus.zip' : 'INAV_Terrain_SRTM.zip',
                filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
            });
            if (!result.canceled && result.filePath) {
                await globalThis.electronAPI.writeFile(result.filePath, new Uint8Array(blob));
            }
            showTerrainComplete(datFiles.length, 0, 0, false);
        }

        function showTerrainComplete(total, failedCount, skipped, isSD) {
            skipped = skipped || 0;
            if (failedCount > 0) {
                $('#mapgen_download_status').text(`Done with ${failedCount} error(s).${skipped > 0 ? ` ${skipped} skipped (already existed).` : ''}`);
            } else {
                const written = total - skipped;
                let summary = `${written} .TER file(s) written`;
                if (skipped > 0) summary += `, ${skipped} skipped (already existed)`;

                const title = isSD ? 'Terrain Sync Complete!' : 'Terrain Generation Complete!';
                const msg = isSD ? 'All terrain files synced to SD card!' : 'All terrain files generated!';
                $('#mapgen_modal_header').text(title);
                $('#mapgen_sync_info').html(`
                    <div class="mapgen-info-row"><span>Files:</span><span>${summary}</span></div>
                    <div style="margin:18px 0; text-align:center; color:#87b025; font-size:16px; font-weight:bold;">${msg}</div>
                    <div style="text-align:center; color:#888; font-size:12px;">Enable terrain in INAV CLI:<br><code style="color:#ffb300;">set terrain_enabled = ON</code> then <code style="color:#ffb300;">save</code></div>
                `);
                $('#mapgen_progress_section').hide();
                $('#mapgen_download_status').text(`${isSD ? 'Sync' : 'Export'} complete! ${summary}`);
            }
            $('#mapgen_modal_actions').show();
            $('#mapgen_modal_confirm').hide();
            $('#mapgen_modal_cancel').text('Close');
        }

        const maptilerKeyTooltip = new jBox('Tooltip', {
            attach: '#mapgen_maptiler_key_tip',
            content: i18n.getMessage('mapgenMaptilerKeyHelp'),
            getContent: null,
            delayOpen: 100,
            delayClose: 100,
            position: { x: 'right', y: 'center' },
            outside: 'x'
        });

        GUI.content_ready(callback);
    }
};

TABS.map_generator.cleanup = function (callback) {
    // Leaving the tab stops an offline download; running it again resumes.
    if (stopOfflineDownload) stopOfflineDownload();
    if (callback) callback();
};
