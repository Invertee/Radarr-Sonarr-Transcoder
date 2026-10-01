'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createDatabase } = require('../src/db');
const { getProfile, selectProfileFromTags, validateCustomProfile } = require('../src/profiles');
const { createRouter, parseJobBody } = require('../src/routes');
const { QueueWorker } = require('../src/queue-worker');
const { buildFfmpegArgs, createProgressParser } = require('../src/ffmpeg');
const { estimateOutputSize, estimateFromProgress } = require('../public/conversion-estimates');

const logger = { warn() {}, info() {}, error() {}, tail() { return []; } };
const metadata = { durationSeconds: 3600, width: 1920, height: 1080, audioStreams: 2 };

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-profiles-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const db = createDatabase(databasePath, logger);
  context.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, databasePath };
}

test('custom profiles reject unsupported quality, resolution and names', () => {
  for (const input of [
    { name: '', qp: 24, maxWidth: 1920 },
    { name: 'x'.repeat(61), qp: 24, maxWidth: 1920 },
    { name: 'TV', qp: '24', maxWidth: 1920 },
    { name: 'TV', qp: 15, maxWidth: 1920 },
    { name: 'TV', qp: 37, maxWidth: 1920 },
    { name: 'TV', qp: 24.5, maxWidth: 1920 },
    { name: 'TV', qp: 24, maxWidth: 0 }
  ]) assert.throws(() => validateCustomProfile(input));
  assert.equal(validateCustomProfile({ name: ' TV ', qp: 16, maxWidth: 3840 }).name, 'TV');
});

test('custom selection uses stable keys and skip tags still win', () => {
  const custom = { key: 'custom-tv', name: 'TV', qp: 28, maxWidth: 1280 };
  assert.equal(getProfile(custom.key, 'medium', [custom]), custom);
  assert.equal(selectProfileFromTags(['transcode:custom-tv', 'high'], 'medium', [custom]), custom);
  assert.equal(selectProfileFromTags(['custom-tv', 'skip'], 'medium', [custom]).key, 'skip');
  assert.equal(selectProfileFromTags([], custom.key, [custom]), custom);
  assert.throws(() => parseJobBody({ path: path.resolve('movie.mkv'), profileKey: 'custom-missing' }, { defaultProfile: 'medium' }));
  assert.throws(() => parseJobBody({ path: path.resolve('movie.mkv'), profileKey: 'constructor' }, { defaultProfile: 'medium' }));
  assert.equal(parseJobBody({ path: path.resolve('movie.mkv'), profileKey: custom.key }, { defaultProfile: 'medium' }, [custom]).profileKey, custom.key);
});

test('saved profiles survive restart and queued settings survive edits and deletion', (context) => {
  const { db, databasePath } = fixture(context);
  const original = db.saveCustomProfile({ name: 'Compact TV', qp: 28, maxWidth: 1280 });
  const job = db.enqueueJob({ path: '/media/tv.mkv', profileKey: original.key }).job;
  db.saveCustomProfile({ name: 'Updated', qp: 20, maxWidth: 3840 }, original.key);
  assert.deepEqual(JSON.parse(db.getJob(job.id).profile_json), original);
  const reopened = createDatabase(databasePath, logger);
  assert.equal(reopened.listCustomProfiles()[0].qp, 20);
  assert.equal(reopened.deleteCustomProfile(original.key), true);
  const queued = reopened.claimNextJob();
  const snapshot = JSON.parse(queued.profile_json);
  assert.equal(snapshot.qp, 28);
  assert.equal(snapshot.name, 'Compact TV');
  const args = buildFfmpegArgs({ inputPath: queued.path, outputPath: '/cache/tv.mkv', profile: snapshot,
    config: { vaapiDevice: '/dev/dri/renderD128', audioBitrate: '192k' } });
  assert.equal(args[args.indexOf('-qp') + 1], '28');
  assert.ok(args[args.indexOf('-vf') + 1].includes('1280'));
  reopened.close();
});

test('additive migration preserves old queued jobs and remains repeatable', (context) => {
  const { db, databasePath } = fixture(context);
  const job = db.enqueueJob({ path: '/media/legacy.mkv', profileKey: 'low' }).job;
  // Recreate the pre-profile schema to exercise an actual upgrade.
  db.sqlite.exec('ALTER TABLE jobs DROP COLUMN profile_json; DROP TABLE custom_profiles; DELETE FROM schema_migrations WHERE version = 3;');
  for (let index = 0; index < 2; index += 1) {
    const upgraded = createDatabase(databasePath, logger);
    assert.equal(upgraded.getJob(job.id).profile_key, 'low');
    assert.equal(upgraded.getQueue().length, 1);
    assert.equal(upgraded.getJob(job.id).profile_json, null);
    assert.equal(upgraded.stats().filesProcessed, 805);
    upgraded.close();
  }
});

test('rough size estimates respond to quality, resolution, duration and all audio streams', () => {
  const medium = estimateOutputSize(metadata, getProfile('medium'));
  assert.ok(estimateOutputSize(metadata, getProfile('high')).estimatedOutputBytes > medium.estimatedOutputBytes);
  assert.ok(estimateOutputSize(metadata, getProfile('lowres')).estimatedOutputBytes < medium.estimatedOutputBytes);
  assert.equal(estimateOutputSize({ ...metadata, durationSeconds: 7200 }, getProfile('medium')).estimatedOutputBytes, medium.estimatedOutputBytes * 2);
  assert.ok(estimateOutputSize({ ...metadata, audioStreams: 4 }, getProfile('medium'), '256k').estimatedOutputBytes > medium.estimatedOutputBytes);
  assert.ok(medium.lowerBytes < medium.estimatedOutputBytes && medium.upperBytes > medium.estimatedOutputBytes);
  assert.equal(estimateOutputSize({ ...metadata, width: null }, getProfile('medium')), null);
  assert.equal(estimateOutputSize({ ...metadata, durationSeconds: Infinity }, getProfile('medium')), null);
  assert.equal(estimateOutputSize(metadata, getProfile('skip')), null);
  assert.deepEqual(estimateOutputSize({ ...metadata, width: 1280, height: 720 }, getProfile('medium')),
    estimateOutputSize({ ...metadata, width: 1280, height: 720 }, { qp: 24, maxWidth: 3840 }));
});

test('live output projections wait for enough encoded content and tolerate unavailable sizes', () => {
  assert.equal(estimateFromProgress(100, 2, 100), null);
  assert.equal(estimateFromProgress(NaN, 25, 100), null);
  assert.equal(estimateFromProgress(0, 25, 100), null);
  const updates = [];
  const parser = createProgressParser({ durationSeconds: 100, outputPath: '/cache/test.mkv', onProgress: (value) => updates.push(value) });
  parser.push('total_size=5000\nout_time_us=25000000\nprogress=continue\n');
  parser.push('total_size=N/A\nout_time_us=50000000\nprogress=continue\n');
  assert.equal(updates[0].outputBytes, 5000);
  assert.equal(updates[1].outputBytes, null);
  const worker = new QueueWorker({ db: { updateProgress() {} }, config: {}, logger, arrClient: {} });
  worker.activeJob = { durationSeconds: 100, sizeEstimate: { method: 'rough' } };
  worker.handleProgress(1, updates[0]);
  assert.deepEqual(worker.status().sizeEstimate, { estimatedOutputBytes: 20000, method: 'encoding' });
  worker.handleProgress(1, updates[1]);
  assert.equal(worker.status().sizeEstimate.estimatedOutputBytes, 20000);
});

test('profile API creates, edits, queues and deletes custom profiles while protecting presets', async (context) => {
  const { db } = fixture(context);
  const app = express();
  app.use(express.json());
  app.use(createRouter({ db, worker: { status: () => ({ status: 'Idle' }) }, arrClient: {}, logger,
    config: { defaultProfile: 'medium', audioBitrate: '192k' } }));
  app.use((error, request, response, next) => response.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = 'GET', body) => fetch(base + url, { method,
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/api/profiles', 'POST', { name: 'Invalid', qp: 1, maxWidth: 1920 })).status, 400);
  const created = await request('/api/profiles', 'POST', { name: 'Small', qp: 30, maxWidth: 1280 });
  assert.equal(created.status, 201);
  const profile = await created.json();
  assert.ok((await (await request('/api/profiles')).json()).some((item) => item.key === profile.key));
  const queued = await request('/api/queue', 'POST', { path: path.resolve('test.mkv'), profileKey: profile.key });
  assert.equal(queued.status, 201);
  const { job } = await queued.json();
  assert.equal(job.profile.name, 'Small');
  assert.equal((await request(`/api/profiles/${profile.key}`, 'PUT', { name: 'Large', qp: 16, maxWidth: 3840 })).status, 200);
  assert.equal((await request('/api/profiles/medium', 'PUT', { name: 'Override', qp: 16, maxWidth: 3840 })).status, 404);
  assert.equal((await request('/api/profiles/medium', 'DELETE')).status, 404);
  assert.equal((await request(`/api/profiles/${profile.key}`, 'DELETE')).status, 204);
  assert.equal((await request('/api/queue', 'POST', { path: path.resolve('another.mkv'), profileKey: profile.key })).status, 400);
  const queue = await (await request('/api/queue')).json();
  assert.equal(queue[0].profile.qp, 30);
  assert.equal(queue[0].profile.name, 'Small');
});
