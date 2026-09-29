'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPodcastStore } = require('../src/podcast-store');
const { validateRequest, sampleWindows, parseWhisper, classifyRules, validateSegments, PodcastWorker } = require('../src/podcast-analysis');

const request = { requestKey: 'test-request', episodeId: 'episode', title: 'Test episode', enclosureUrl: 'https://example.com/audio.mp3', phrases: ['Waffle sponsor'] };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-test-'));
  const filename = path.join(directory, 'test.sqlite');
  const store = createPodcastStore(filename);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, filename };
}

test('validates HTTP audio input and bounded literal phrase hints', () => {
  assert.equal(validateRequest(request).chaptersUrl, null);
  assert.throws(() => validateRequest({ ...request, enclosureUrl: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => validateRequest({ ...request, phrases: Array(51).fill('ad') }), /50/);
  assert.throws(() => validateRequest({ ...request, phrases: [''] }), /nonempty/);
});

test('persistent queue deduplicates retries and rejects conflicting request keys', t => {
  const { store, filename } = fixture(t);
  const first = store.enqueue(validateRequest(request));
  assert.equal(store.enqueue(validateRequest(request)).job.id, first.job.id);
  assert.throws(() => store.enqueue(validateRequest({ ...request, title: 'Changed' })), /different input/);
  assert.equal(store.claim().id, first.job.id);
  assert.equal(store.claim(), null);
  // Simulate process restart: interrupted work becomes claimable again.
  const reopened = createPodcastStore(filename);
  assert.equal(reopened.claim().id, first.job.id);
  reopened.close();
});

test('sampling stays within duration, respects budget and covers the episode ends', () => {
  const windows = sampleWindows(3600000, Array.from({ length: 1000 }, (_, i) => i * 3500), 900);
  assert.equal(windows.length, 30);
  assert.equal(windows[0].startMs, 0);
  assert.equal(windows.at(-1).endMs, 3600000);
  assert.ok(windows.every(w => w.startMs >= 0 && w.endMs <= 3600000));
  assert.deepEqual(sampleWindows(5000, [], 900), [{ startMs: 0, endMs: 5000 }]);
});

test('Whisper offsets use original media time and phrase detection is literal', () => {
  const fragments = parseWhisper({ transcription: [{ offsets: { from: 1200, to: 4000 }, text: 'Thanks to our waffle sponsor.' }] }, { startMs: 90000, endMs: 120000 });
  assert.equal(fragments[0].startMs, 91200);
  assert.equal(fragments[0].endMs, 94000);
  assert.equal(classifyRules(fragments, ['Waffle sponsor'])[0].confidence, 0.6);
  assert.equal(classifyRules(fragments, ['.*']).length, 0);
  assert.throws(() => validateSegments([{ startMs: 20, endMs: 10, kind: 'chapter', title: 'bad', confidence: 1 }], 100), /Invalid/);
});

test('worker records stages, result and separate job logs; failures remain retryable with a new request', async t => {
  const { store } = fixture(t);
  const job = store.enqueue(validateRequest(request)).job;
  const logger = { info() {}, warn() {}, error() {} };
  const worker = new PodcastWorker(store, { podcastJobTimeoutMs: 10000 }, logger, async (_request, _config, _signal, progress) => {
    progress('classifying', 90); return { segments: [], fragments: [{ text: 'private excerpt' }] };
  });
  await worker.tick();
  assert.equal(store.get(job.id).status, 'completed');
  assert.equal(store.logs(job.id).some(entry => entry.message.includes('private excerpt')), false);
  const failed = store.enqueue(validateRequest({ ...request, requestKey: 'second' })).job;
  worker.processor = async () => { throw new Error('Missing model'); };
  await worker.tick();
  assert.equal(store.get(failed.id).status, 'failed');
  assert.equal(store.get(failed.id).error, 'Missing model');
});

test('seven-day transcript purge preserves markers and removes old logs', t => {
  const { store, filename } = fixture(t);
  const job = store.enqueue(validateRequest(request)).job;
  store.finish(job.id, { segments: [{ title: 'Chapter' }], fragments: [{ text: 'expire me' }] });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filename);
  db.prepare("UPDATE podcast_jobs SET expires_at='2000-01-01' WHERE id=?").run(job.id); db.close();
  store.prune();
  assert.deepEqual(store.get(job.id).result.fragments, []);
  assert.equal(store.get(job.id).result.segments.length, 1);
  assert.equal(store.get(job.id).result.transcriptExpired, true);
});

test('local HTTP API exposes independent job status and diagnostic logs', async t => {
  const express = require('express');
  const { podcastRouter } = require('../src/podcast-routes');
  const { store } = fixture(t);
  const app = express(); app.use(express.json()); app.use('/api/podcasts', podcastRouter(store, {}, { info() {}, tail: () => ['podcast-only log'] }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/podcasts`;
  const submitted = await fetch(`${url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(submitted.status, 202); const { job } = await submitted.json();
  const polled = await (await fetch(`${url}/jobs/${job.id}`)).json();
  assert.equal(polled.job.status, 'queued');
  assert.deepEqual((await (await fetch(`${url}/logs`)).json()).lines, ['podcast-only log']);
  assert.equal((await fetch(`${url}/jobs/missing`)).status, 404);
});

test('analysis pipeline hashes the fetched bytes, maps English snippets and cleans owned temporary files', async t => {
  const { analyse } = require('../src/podcast-analysis');
  const { createHash } = require('node:crypto');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const model = path.join(directory, 'tiny.en.bin'); fs.writeFileSync(model, 'test model placeholder');
  const config = { podcastWhisperModel: model, podcastCacheDir: path.join(directory, 'cache'), podcastMaxBytes: 1000, ffprobePath: 'probe', ffmpegPath: 'ffmpeg', podcastWhisperPath: 'whisper', podcastSampleSeconds: 60 };
  const audio = Buffer.from('test audio bytes');
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(audio);
  t.after(() => { global.fetch = originalFetch; });
  const execute = async (binary, args) => {
    if (binary === 'probe') return { stdout: JSON.stringify({ format: { duration: '90' }, chapters: [{ start_time: 0, end_time: 90, tags: { title: 'Opening' } }] }), stderr: '' };
    if (binary === 'whisper') {
      assert.equal(args[args.indexOf('-l') + 1], 'en');
      fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [{ offsets: { from: 1000, to: 3000 }, text: 'Brought to you by our sponsor.' }] }));
    }
    return { stdout: '', stderr: 'silence_end: 25.5' };
  };
  const result = await analyse(validateRequest(request), config, new AbortController().signal, () => {}, execute);
  assert.equal(result.fingerprint.sha256, createHash('sha256').update(audio).digest('hex'));
  assert.equal(result.segments[0].source, 'embedded');
  assert.ok(result.fragments.some(f => f.startMs >= 61000));
  assert.deepEqual(fs.readdirSync(config.podcastCacheDir), []);
  assert.equal(fs.readFileSync(model, 'utf8'), 'test model placeholder');
  await assert.rejects(analyse(validateRequest(request), config, new AbortController().signal, () => {}, async () => { throw new Error('probe failed'); }), /probe failed/);
  assert.deepEqual(fs.readdirSync(config.podcastCacheDir), []);
});
