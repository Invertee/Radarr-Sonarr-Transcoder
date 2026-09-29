'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { seedInitialStatsDatabase, toDatabaseStats } = require('../src/initial-stats');

const logger = { warn() {}, info() {}, error() {} };

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-starting-stats-'));
  return {
    directory,
    databasePath: path.join(directory, 'test.sqlite')
  };
}

test('starting statistics are converted to the database totals used by the dashboard', () => {
  assert.deepEqual(toDatabaseStats({
    savedGiB: 1023.21,
    efficiencyPercent: 56.3,
    filesProcessed: 805
  }), {
    totalOriginalBytes: 1951444710009,
    totalSavedBytes: 1098663371735,
    filesProcessed: 805
  });
});

test('configured starting statistics seed only a brand-new database', () => {
  const { directory, databasePath } = temporaryDatabase();

  try {
    assert.equal(seedInitialStatsDatabase(databasePath, {
      savedGiB: 100,
      efficiencyPercent: 50,
      filesProcessed: 25
    }), true);

    let db = createDatabase(databasePath, logger);
    let stats = db.stats();
    assert.equal(stats.savedGiB, 100);
    assert.equal(stats.efficiencyPercent, 50);
    assert.equal(stats.filesProcessed, 25);
    db.close();

    assert.equal(seedInitialStatsDatabase(databasePath, {
      savedGiB: 999,
      efficiencyPercent: 99,
      filesProcessed: 999
    }), false);

    db = createDatabase(databasePath, logger);
    stats = db.stats();
    assert.equal(stats.savedGiB, 100);
    assert.equal(stats.efficiencyPercent, 50);
    assert.equal(stats.filesProcessed, 25);
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('zero starting statistics are supported', () => {
  assert.deepEqual(toDatabaseStats({
    savedGiB: 0,
    efficiencyPercent: 0,
    filesProcessed: 0
  }), {
    totalOriginalBytes: 0,
    totalSavedBytes: 0,
    filesProcessed: 0
  });
});
