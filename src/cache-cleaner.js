'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

async function removeStaleCacheFiles({
  cacheDir,
  activeTempPath = null,
  retentionMs,
  now = Date.now()
}) {
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error('retentionMs must be a non-negative number');
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('transcode-job-')) {
      continue;
    }

    const candidate = path.join(cacheDir, entry.name);
    if (candidate === activeTempPath) {
      continue;
    }

    let stat;
    try {
      stat = await fsp.stat(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if ((now - stat.mtimeMs) < retentionMs) {
      continue;
    }

    await fsp.rm(candidate, { force: true });
    removed += 1;
  }

  return removed;
}

module.exports = {
  removeStaleCacheFiles
};
