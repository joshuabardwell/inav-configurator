'use strict';

/*
 * The offline data folder: where the Map Generator keeps map imagery it
 * downloaded for use without a connection (imagery/<provider>/<type>/z/x/y).
 * One place decides whether the folder exists, where it is, and how one file in
 * it is read or written. Electron only: the web build has no file system.
 *
 * Terrain files (.TER) are not kept here: they have their own folder
 * (js/terrain_library.js). Earlier versions kept raw elevation downloads in
 * elevation/<source>/ here; nothing reads them any more.
 */

import store from './store.js';

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
