'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase, BASELINE_STATS } = require('../src/db');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-manager-smoke-'));
const logger = { warn() {}, info() {}, error() {} };

try {
  const db = createDatabase(path.join(temporaryDirectory, 'smoke.sqlite'), logger);
  const stats = db.stats();
  if (stats.totalSavedBytes !== BASELINE_STATS.totalSavedBytes || stats.filesProcessed !== BASELINE_STATS.filesProcessed) {
    throw new Error('Baseline statistics were not seeded correctly');
  }
  db.close();
  console.log('Smoke test passed.');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
