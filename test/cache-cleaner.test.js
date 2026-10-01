'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getCacheSize, removeStaleCacheFiles } = require('../src/cache-cleaner');
const { clearCache } = require('../src/ffmpeg');

test('cache cleanup removes only expired inactive transcode files', async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-cache-'));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));

  const now = Date.now();
  const oldFile = path.join(cacheDir, 'transcode-job-1-old.mkv');
  const recentFile = path.join(cacheDir, 'transcode-job-2-recent.mkv');
  const activeFile = path.join(cacheDir, 'transcode-job-3-active.mkv');
  const unrelatedFile = path.join(cacheDir, 'keep-me.txt');

  await Promise.all([
    fs.writeFile(oldFile, 'old'),
    fs.writeFile(recentFile, 'recent'),
    fs.writeFile(activeFile, 'active'),
    fs.writeFile(unrelatedFile, 'unrelated')
  ]);

  const oldDate = new Date(now - (13 * 60 * 60 * 1000));
  const recentDate = new Date(now - (60 * 60 * 1000));
  await fs.utimes(oldFile, oldDate, oldDate);
  await fs.utimes(activeFile, oldDate, oldDate);
  await fs.utimes(recentFile, recentDate, recentDate);

  const removed = await removeStaleCacheFiles({
    cacheDir,
    activeTempPath: activeFile,
    retentionMs: 12 * 60 * 60 * 1000,
    now
  });

  assert.equal(removed, 1);
  await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
  await fs.stat(recentFile);
  await fs.stat(activeFile);
  await fs.stat(unrelatedFile);
});

test('cache size includes active output and nested files and reflects safe clearing', async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-cache-size-'));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const activeFile = path.join(cacheDir, 'transcode-job-1-active.mkv');
  await fs.mkdir(path.join(cacheDir, 'nested'));
  await Promise.all([
    fs.writeFile(activeFile, Buffer.alloc(1024)),
    fs.writeFile(path.join(cacheDir, 'transcode-job-2-inactive.mkv'), Buffer.alloc(2048)),
    fs.writeFile(path.join(cacheDir, 'keep.txt'), Buffer.alloc(16)),
    fs.writeFile(path.join(cacheDir, 'nested', 'keep.txt'), Buffer.alloc(32))
  ]);
  assert.equal(await getCacheSize(cacheDir), 3120);
  assert.equal(await clearCache(cacheDir, activeFile), 1);
  assert.equal(await getCacheSize(cacheDir), 1072);
  await fs.appendFile(activeFile, Buffer.alloc(512));
  assert.equal(await getCacheSize(cacheDir), 1584);
});

test('a missing cache directory measures zero without creating it', async () => {
  const directory = path.join(os.tmpdir(), `transcode-missing-${require('node:crypto').randomUUID()}`);
  assert.equal(await getCacheSize(directory), 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
