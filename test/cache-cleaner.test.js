'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { removeStaleCacheFiles } = require('../src/cache-cleaner');

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
