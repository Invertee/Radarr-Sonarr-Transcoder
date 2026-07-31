'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase, BASELINE_STATS } = require('../src/db');

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-manager-db-'));
  const logger = { warn() {}, info() {}, error() {} };
  const db = createDatabase(path.join(directory, 'test.sqlite'), logger);
  try {
    callback(db);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('new databases start with the requested dashboard baseline', () => {
  withDatabase((db) => {
    const stats = db.stats();
    assert.equal(stats.totalOriginalBytes, BASELINE_STATS.totalOriginalBytes);
    assert.equal(stats.totalSavedBytes, BASELINE_STATS.totalSavedBytes);
    assert.equal(stats.filesProcessed, 805);
    assert.equal(stats.savedGiB, 1023.21);
    assert.equal(stats.efficiencyPercent, 56.3);
  });
});

test('queue order is persistent, reorderable and deduplicated by active path', () => {
  withDatabase((db) => {
    const first = db.enqueueJob({
      path: '/media/one.mkv',
      title: 'One',
      profileKey: 'medium',
      sourceService: 'manual'
    });
    const second = db.enqueueJob({
      path: '/media/two.mkv',
      title: 'Two',
      profileKey: 'low',
      sourceService: 'manual'
    });
    const duplicate = db.enqueueJob({
      path: '/media/one.mkv',
      title: 'Duplicate',
      profileKey: 'high',
      sourceService: 'manual'
    });

    assert.equal(duplicate.deduplicated, true);
    assert.deepEqual(db.reorderQueue([Number(second.job.id), Number(first.job.id)]).map((job) => Number(job.id)), [
      Number(second.job.id),
      Number(first.job.id)
    ]);
    assert.equal(Number(db.claimNextJob().id), Number(second.job.id));
  });
});

test('media browser items and probe metadata are retained in SQLite', () => {
  withDatabase((db) => {
    const item = {
      service: 'radarr',
      itemId: 10,
      movieId: 10,
      fileId: 20,
      title: 'Example',
      path: '/movies/Example.mkv',
      relativePath: 'Example.mkv',
      sizeBytes: 1000,
      durationSeconds: null,
      width: null,
      height: null,
      resolution: 'Unknown',
      audioLanguages: ['eng'],
      hasFile: true
    };

    db.conversionState('radarr', [item]);
    db.updateCachedMediaProbe('radarr', item.path, {
      sizeBytes: 900,
      durationSeconds: 3600,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioLanguages: ['eng', 'jpn']
    });

    const cached = db.getCachedMedia('radarr');
    assert.equal(cached.length, 1);
    assert.equal(cached[0].durationSeconds, 3600);
    assert.equal(cached[0].resolution, '1920x1080');
    assert.deepEqual(cached[0].audioLanguages, ['eng', 'jpn']);
  });
});
