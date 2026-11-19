import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadToFile, writeFileAtomic, listFiles, dirSize, diskFree } from '../js/main/offline_store.js';

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

test('downloadToFile refuses non-https URLs and skips existing files', () => withTempDir(async dir => {
    const dest = path.join(dir, 'f.bin');
    assert.equal((await downloadToFile('http://example.com/x', dest)).status, 'error');
    await writeFile(dest, 'x');
    assert.equal((await downloadToFile('https://example.invalid/x', dest, { skipIfExists: true })).status, 'exists');
}));
