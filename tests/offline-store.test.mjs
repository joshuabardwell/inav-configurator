import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadToFile, writeFileAtomic, copyFileAtomic, ensureFolder, ensureParentDir, makeDir, listFiles, dirSize, diskFree } from '../js/main/offline_store.js';

async function withTempDir(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'offline-store-'));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test('writeFileAtomic creates folders and leaves no .part file', () => withTempDir(async dir => {
    const dest = path.join(dir, 'a', 'b', 'c.bin');
    assert.equal(await writeFileAtomic(dest, new Uint8Array([1, 2, 3])), false);
    assert.deepEqual([...await readFile(dest)], [1, 2, 3]);
    assert.deepEqual(await listFiles(path.join(dir, 'a', 'b')), [{ name: 'c.bin', size: 3 }]);
}));

test('listFiles skips .part files and folders; missing folder is empty', () => withTempDir(async dir => {
    await writeFile(path.join(dir, 'x.tif'), 'abcd');
    await writeFile(path.join(dir, 'y.tif.part'), 'ab');
    await mkdir(path.join(dir, 'sub'));
    assert.deepEqual(await listFiles(dir), [{ name: 'x.tif', size: 4 }]);
    assert.deepEqual(await listFiles(path.join(dir, 'nope')), []);
}));

test('dirSize totals nested files', () => withTempDir(async dir => {
    await mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await writeFile(path.join(dir, 'one'), '12345');
    await writeFile(path.join(dir, 'a', 'b', 'two'), '123');
    assert.deepEqual(await dirSize(dir), { bytes: 8, files: 2 });
    assert.deepEqual(await dirSize(path.join(dir, 'missing')), { bytes: 0, files: 0 });
}));

test('diskFree walks up to an existing folder', () => withTempDir(async dir => {
    const free = await diskFree(path.join(dir, 'not', 'yet', 'made'));
    assert.ok(free > 0);
}));

test('copyFileAtomic copies into a new folder and reports a missing source', () => withTempDir(async dir => {
    const src = path.join(dir, 'N47E008.TER');
    await writeFile(src, 'terrain');
    const dest = path.join(dir, 'card', 'N47E008.TER');
    assert.equal(await copyFileAtomic(src, dest), false);
    assert.equal(await readFile(dest, 'utf8'), 'terrain');
    assert.deepEqual(await listFiles(path.join(dir, 'card')), [{ name: 'N47E008.TER', size: 7 }]);
    assert.equal(typeof await copyFileAtomic(path.join(dir, 'nope.TER'), dest), 'string');
    assert.equal(await readFile(dest, 'utf8'), 'terrain');
}));

test('ensureFolder creates a folder and refuses a file or a relative path', () => withTempDir(async dir => {
    const folder = path.join(dir, 'INAV Terrain', 'Default');
    assert.equal(await ensureFolder(folder), false);
    assert.deepEqual(await listFiles(folder), []);
    const file = path.join(dir, 'run.bat');
    await writeFile(file, 'x');
    assert.equal(typeof await ensureFolder(file), 'string');
    assert.equal(typeof await ensureFolder('relative/folder'), 'string');
}));

// Windows refuses mkdir on a drive root with EPERM, even with { recursive: true }.
function fakeFs({ folderExists, isFile = false }) {
    const calls = [];
    return {
        calls,
        mkdir: async (dir, opts) => {
            calls.push(['mkdir', dir, opts]);
            throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${dir}'`), { code: 'EPERM' });
        },
        stat: async (dir) => {
            calls.push(['stat', dir]);
            if (!folderExists && !isFile) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return { isDirectory: () => folderExists };
        },
    };
}

test('makeDir carries on when mkdir throws for a folder that is there (an SD card root)', async () => {
    const fs = fakeFs({ folderExists: true });
    await makeDir('J:\\', fs);
    assert.deepEqual(fs.calls, [['mkdir', 'J:\\', { recursive: true }], ['stat', 'J:\\']]);
});

test('makeDir keeps the mkdir error when the folder is missing or is a file', async () => {
    await assert.rejects(makeDir('J:\\', fakeFs({ folderExists: false })), { code: 'EPERM' });
    await assert.rejects(makeDir('J:\\file.txt', fakeFs({ folderExists: false, isFile: true })), { code: 'EPERM' });
});

test('a drive root is accepted as the folder for a file', async () => {
    // The real file system, nothing written: on Windows this is the mkdir that
    // failed for every file of a Sync to a card's root.
    const root = path.parse(tmpdir()).root;
    await ensureParentDir(path.join(root, 'N34W112.TER'));
    assert.equal(await ensureFolder(root), false);
});

test('downloadToFile refuses non-https URLs and skips existing files', () => withTempDir(async dir => {
    const dest = path.join(dir, 'f.bin');
    assert.equal((await downloadToFile('http://example.com/x', dest)).status, 'error');
    await writeFile(dest, 'x');
    assert.equal((await downloadToFile('https://example.invalid/x', dest, { skipIfExists: true })).status, 'exists');
}));
