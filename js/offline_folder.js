'use strict';

/*
 * The offline data folder: where the Map Generator's Offline Data panel and the
 * mission planner keep elevation files as downloaded (elevation/<source>/...).
 * One place decides whether the folder exists, where it is, and how one file in
 * it is read or written; tabs/map_generator.js and tabs/mission_control.js both
 * go through here. Electron only: the web build has no file system.
 */

import store from './store.js';

const RANGE_CHUNK = 1024 * 1024;    // electronAPI.readFileRanges accepts at most 1 MB per range

export function offlineFolderAvailable() {
    return !globalThis.__INAV_BROWSER_BUILD__ && typeof globalThis.electronAPI?.downloadToFile === 'function';
}

export function offlineFolderDefaultDir() {
    return globalThis.electronAPI.appGetPath('userData') + '/offline_terrain';
}

export function offlineFolderDir() {
    return store.get('mapgen_offline_dir', '') || offlineFolderDefaultDir();
}

export function offlineFolderPath(rel) {
    return offlineFolderDir() + '/' + rel;
}

/* Whole file as a Uint8Array, or null when it is not there. */
export async function offlineFolderRead(rel) {
    if (!offlineFolderAvailable()) return null;
    const r = await globalThis.electronAPI.readFile(offlineFolderPath(rel), null);
    if (!r || r.error || !r.data) return null;
    return r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
}

export async function offlineFolderWrite(rel, bytes) {
    if (!offlineFolderAvailable()) return;
    const err = await globalThis.electronAPI.writeFileAtomic(offlineFolderPath(rel), bytes);
    if (err) throw new Error(err);
}

export async function offlineFolderExists(rel) {
    if (!offlineFolderAvailable()) return false;
    try {
        return Boolean(await globalThis.electronAPI.pathExists(offlineFolderPath(rel)));
    } catch (_) {
        return false;
    }
}

/*
 * Parts of one file: slices is [{ offset, length }], the answer one ArrayBuffer per
 * slice (shorter where the file ends early). Throws when the file can't be read.
 */
export async function offlineFolderReadSlices(rel, slices) {
    const ranges = [];
    const parts = [];   // per slice: how many ranges it was split into
    for (const slice of slices) {
        let count = 0;
        for (let done = 0; done < slice.length || count === 0; done += RANGE_CHUNK) {
            ranges.push([slice.offset + done, Math.min(RANGE_CHUNK, slice.length - done)]);
            count++;
        }
        parts.push(count);
    }
    const result = await globalThis.electronAPI.readFileRanges(offlineFolderPath(rel), ranges);
    if (!result || result.error || !Array.isArray(result.data)) {
        throw new Error('Could not read ' + rel);
    }
    const out = [];
    let next = 0;
    for (const count of parts) {
        const chunks = result.data.slice(next, next + count).map(chunk => new Uint8Array(chunk));
        next += count;
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
            joined.set(chunk, at);
            at += chunk.byteLength;
        }
        out.push(joined.buffer);
    }
    return out;
}
