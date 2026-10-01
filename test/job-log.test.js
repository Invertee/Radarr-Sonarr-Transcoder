'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const express = require('express');
const { jobLogPath } = require('../src/job-log');
const { getProfile } = require('../src/profiles');
const { createRouter } = require('../src/routes');

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-job-log-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, config: { ffmpegLogPath: path.join(directory, 'ffmpeg-last.log'),
    ffmpegPath: 'ffmpeg', vaapiDevice: '/dev/dri/renderD128', audioBitrate: '192k' } };
}

test('full per-job stderr is flushed before failure and survives the next conversion', async (context) => {
  const { directory, config } = await fixture(context);
  const output = 'First diagnostic\n' + 'x'.repeat(110000) + '\nLast diagnostic\n';
  context.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.end(output);
      child.stdout.end();
      child.emit('close', 234, null);
    });
    return child;
  });
  delete require.cache[require.resolve('../src/ffmpeg')];
  const { transcode } = require('../src/ffmpeg');
  const convert = (jobId) => transcode({ jobId, inputPath: path.join(directory, 'input.mkv'),
    outputPath: path.join(directory, 'output.mkv'), profile: getProfile('medium'), durationSeconds: 60,
    config, logger: { warn() {} } });
  await assert.rejects(convert(1), (error) => error.message.includes('234') && error.details.length === 50000);
  const archived = await fs.readFile(jobLogPath(config, 1), 'utf8');
  assert.ok(archived.includes('Command:'));
  assert.ok(archived.includes(output));
  assert.match(archived, /Result: FFmpeg exited with code 234/);
  await assert.rejects(convert(2), /234/);
  assert.equal(await fs.readFile(jobLogPath(config, 1), 'utf8'), archived);
  assert.equal(await fs.readFile(config.ffmpegLogPath, 'utf8'), output);
});

test('failed-job download serves complete archives and labelled legacy details, rejecting other jobs', async (context) => {
  const { config } = await fixture(context);
  const archived = 'first\n' + 'diagnostic\n'.repeat(15000) + 'last\n';
  await fs.mkdir(path.dirname(jobLogPath(config, 1)), { recursive: true });
  await fs.writeFile(jobLogPath(config, 1), archived);
  const jobs = new Map([[1, { id: 1, status: 'failed', error: 'short error' }],
    [2, { id: 2, status: 'failed', error: 'Older saved error' }],
    [3, { id: 3, status: 'completed' }]]);
  const app = express();
  app.use(createRouter({ db: { getJob: (id) => jobs.get(id) }, worker: {}, arrClient: {}, config, logger: {} }));
  app.use((error, request, response, next) => response.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const download = (id) => fetch('http://127.0.0.1:' + server.address().port + '/api/history/' + id + '/ffmpeg-log');
  const full = await download(1);
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-disposition'), /attachment; filename="ffmpeg-job-1.log"/);
  assert.match(full.headers.get('content-type'), /text\/plain/);
  assert.equal(await full.text(), archived);
  const legacy = await download(2);
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /Full FFmpeg output is unavailable[\s\S]*Older saved error/);
  assert.equal((await download(3)).status, 404);
  assert.equal((await download(999)).status, 404);
  assert.equal((await download('invalid')).status, 400);
  assert.equal((await download('-1')).status, 400);
});


test('worker retains failed logs and removes completed and cancelled logs', async (context) => {
  const { directory, config } = await fixture(context);
  const ffmpeg = require('../src/ffmpeg');
  const source = path.join(directory, 'source.mkv');
  await fs.writeFile(source, 'source');
  const probe = { path: source, sizeBytes: 2048, durationSeconds: 60, width: 1920, height: 1080,
    videoCodec: 'hevc', audioStreams: 1, subtitleStreams: 0, attachmentStreams: 0 };
  context.mock.method(ffmpeg, 'probeFile', async () => probe);
  context.mock.method(ffmpeg, 'atomicReplace', async () => {});
  let outcome;
  context.mock.method(ffmpeg, 'transcode', async ({ jobId }) => {
    await fs.mkdir(path.dirname(jobLogPath(config, jobId)), { recursive: true });
    await fs.writeFile(jobLogPath(config, jobId), 'full job diagnostic');
    if (outcome === 'failed') throw new Error('encode failed');
    if (outcome === 'cancelled') throw new ffmpeg.CancelledError();
  });
  delete require.cache[require.resolve('../src/queue-worker')];
  const { QueueWorker } = require('../src/queue-worker');
  const statuses = [];
  const worker = new QueueWorker({ config: { ...config, cacheDir: directory, defaultProfile: 'medium' },
    logger: { info() {}, warn() {}, error() {} }, arrClient: { async rescanJob() {} },
    db: { updateInputMetadata() {}, completeJob() { statuses.push('completed'); },
      failJob() { statuses.push('failed'); }, cancelProcessingJob() { statuses.push('cancelled'); } } });
  for (const [index, status] of ['failed', 'completed', 'cancelled'].entries()) {
    outcome = status;
    await worker.processJob({ id: index + 10, path: source, profile_key: 'medium' });
    assert.equal(statuses.at(-1), status);
    if (status === 'failed') assert.equal(await fs.readFile(jobLogPath(config, index + 10), 'utf8'), 'full job diagnostic');
    else await assert.rejects(fs.access(jobLogPath(config, index + 10)), { code: 'ENOENT' });
  }
});
