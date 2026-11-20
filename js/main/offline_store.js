// File helpers for the Map Generator's offline data folder (terrain elevation
// files and map imagery). Runs in the Electron main process so large downloads
// stream straight to disk instead of passing through the renderer. No Electron
// imports: tests/offline-store.test.mjs runs it under plain node.

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, statfs, readdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

let controller = new AbortController();

// Aborts every download in flight. New downloads after this call run normally.
export function abortDownloads() {
    controller.abort();
    controller = new AbortController();
}

async function exists(file) {
    try {
        await stat(file);
        return true;
    } catch {
        return false;
    }
}

// Downloads url to dest through dest.part, renamed into place only when the
// whole body arrived (and matches Content-Length when the server sends one), so
// a stopped run never leaves a truncated file that a later run would trust.
// Returns { status, bytes } where status is the HTTP status, 'exists' when
// skipIfExists found the file, or 'error' with a message.
export async function downloadToFile(url, dest, opts = {}) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
        return { status: 'error', error: 'only https URLs are allowed' };
    }
    if (opts.skipIfExists && await exists(dest)) {
        return { status: 'exists', bytes: 0 };
    }
    const part = dest + '.part';
    const signal = controller.signal;
    try {
        const resp = await fetch(url, { signal });
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => {});
            return { status: resp.status, bytes: 0 };
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await pipeline(Readable.fromWeb(resp.body), createWriteStream(part), { signal });
        const { size } = await stat(part);
        // With a Content-Encoding, fetch decodes the body and Content-Length is
        // the encoded size, so the check only applies to identity responses.
        const encoded = (resp.headers.get('content-encoding') || 'identity') !== 'identity';
        const expected = encoded ? 0 : Number(resp.headers.get('content-length'));
        if (expected && size !== expected) {
            await rm(part, { force: true });
            return { status: 'error', error: `short download: ${size} of ${expected} bytes` };
        }
        await rename(part, dest);
        return { status: resp.status, bytes: size };
    } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        return { status: 'error', error: signal.aborted ? 'aborted' : String(err?.message || err) };
    }
}

// Writes data to dest through dest.part, so a crash mid-write never leaves a
// truncated file in place. Returns false on success, else the error message.
export async function writeFileAtomic(dest, data) {
    const part = dest + '.part';
    try {
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(part, data);
        await rename(part, dest);
        return false;
    } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        return String(err?.message || err);
    }
}

// Copies src to dest through dest.part, like writeFileAtomic. Used to put .TER
// files from the terrain folder onto an SD card without passing 40 MB through
// the renderer. Returns false on success, else the error message.
export async function copyFileAtomic(src, dest) {
    const part = dest + '.part';
    try {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, part);
        await rename(part, dest);
        return false;
    } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        return String(err?.message || err);
    }
}

// Makes sure dir exists and is a folder. Returns false on success, else the
// error message. The caller hands dir to the system's file manager, which
// would run a file instead of showing it, so anything but a folder is refused.
export async function ensureFolder(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return 'not an absolute path';
    try {
        await mkdir(dir, { recursive: true });
        const s = await stat(dir);
        return s.isDirectory() ? false : 'not a folder';
    } catch (err) {
        return String(err?.message || err);
    }
}

// Free bytes on the drive holding dir (or its nearest existing parent).
export async function diskFree(dir) {
    let p = path.resolve(dir);
    for (;;) {
        try {
            const s = await statfs(p);
            return s.bavail * s.bsize;
        } catch (err) {
            const parent = path.dirname(p);
            if (parent === p) throw err;
            p = parent;
        }
    }
}

// Lists the files directly inside dir as { name, size }; [] if dir is missing.
// .part files are left out: they are unfinished downloads.
export async function listFiles(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (!e.isFile() || e.name.endsWith('.part')) continue;
        const { size } = await stat(path.join(dir, e.name));
        out.push({ name: e.name, size });
    }
    return out;
}

// Total size and file count of everything under dir; zeros if it is missing.
export async function dirSize(dir) {
    let bytes = 0;
    let files = 0;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
        return { bytes, files };
    }
    for (const e of entries) {
        if (!e.isFile()) continue;
        try {
            const { size } = await stat(path.join(e.parentPath ?? e.path, e.name));
            bytes += size;
            files++;
        } catch { /* removed while walking */ }
    }
    return { bytes, files };
}
