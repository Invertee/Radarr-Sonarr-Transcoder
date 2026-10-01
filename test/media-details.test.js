'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const express = require('express');
const { ArrClient } = require('../src/arr-client');
const ConversionEstimates = require('../public/conversion-estimates');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appFile = index.match(/src="\/(app\.[^"?]+)/)[1];
const gb = 1024 ** 3;

function frontend() {
  const context = vm.createContext({ document: { addEventListener() {} }, ConversionEstimates });
  vm.runInContext(fs.readFileSync(path.join(root, 'public', appFile), 'utf8'), context);
  vm.runInContext(`
    for (const key of ['seriesSearch', 'episodeSearch', 'movieSearch', 'movieProfile', 'episodeProfile']) elements[key] = { value: '' };
    for (const key of ['seriesBody', 'episodesBody', 'moviesBody', 'episodeSummary', 'mediaInfoHeading',
      'mediaInfoPath', 'mediaInfoSummary', 'mediaInfoJson', 'cacheSize']) elements[key] = {};
  `, context);
  return context;
}

test('GB/hour handles runtime, missing values and approximate series averages', () => {
  const context = frontend();
  context.gb = gb;
  vm.runInContext(`
    globalThis.movieRate = gbPerHour(6 * gb, 7200);
    globalThis.episodeRate = gbPerHour(gb, 1800);
    globalThis.missing = [null, undefined, '', 0, -1, Infinity, NaN].map(value => gbPerHour(gb, value));
    state.series = [{ title: 'Show', sizeBytes: 10 * gb, episodeFileCount: 20, runtimeMinutes: 30 }];
    renderSeries(); globalThis.seriesHtml = elements.seriesBody.innerHTML;
    state.series[0].episodeFileCount = 0;
    renderSeries(); globalThis.emptyRateHtml = elements.seriesBody.innerHTML;
  `, context);
  assert.equal(context.movieRate, 3);
  assert.equal(context.episodeRate, 2);
  assert.ok(context.missing.every(value => value === null));
  assert.match(context.seriesHtml, /data-sort-value="1"[^>]*>~1\.00<\/td>/);
  assert.match(context.emptyRateHtml, /data-sort-value="-1"[^>]*>-<\/td>/);
});

test('movie and episode rates keep unrounded sort values and suppress absent files', () => {
  const context = frontend();
  context.items = [
    { title: 'Film', hasFile: true, sizeBytes: 3 * gb + 1, durationSeconds: 3600 },
    { title: 'Missing', hasFile: false, sizeBytes: gb, durationSeconds: 3600 }
  ];
  vm.runInContext(`
    state.movies = items; renderMovies(); globalThis.moviesHtml = elements.moviesBody.innerHTML;
    state.sonarrFiles = items.slice(0, 1); renderSonarrFiles(); globalThis.episodesHtml = elements.episodesBody.innerHTML;
  `, context);
  for (const html of [context.moviesHtml, context.episodesHtml]) {
    assert.match(html, new RegExp(`class="media-rate-cell" data-sort-value="${(3 * gb + 1) / gb}"[^>]*>3\\.00<`));
  }
  assert.match(context.moviesHtml, /class="media-rate-cell" data-sort-value="-1"[^>]*>-</);
});

test('Probe opens full media information safely and updates file metadata', async () => {
  const context = frontend();
  const mediaInfo = { format: { tags: { title: '<script>unsafe</script>' } }, streams: [{ codec_name: 'hevc', pix_fmt: 'yuv420p10le' }], chapters: [{ id: 1 }] };
  context.result = { sizeBytes: gb, durationSeconds: 1800, resolution: '1920x1080', videoCodec: 'hevc', mediaInfo };
  vm.runInContext(`
    globalThis.item = { service: 'sonarr', title: '<img onerror="bad">', path: '/media/episode.mkv' };
    state.sonarrFiles = [item];
    globalThis.api = async () => result;
    elements.mediaInfoModal = { showModal() { globalThis.opened = true; } };
    document.body = { classList: { add() {} } };
  `, context);
  await vm.runInContext('probeMedia(item)', context);
  assert.equal(context.opened, true);
  assert.equal(context.item.durationSeconds, 1800);
  assert.deepEqual(JSON.parse(vm.runInContext('elements.mediaInfoJson.textContent', context)), mediaInfo);
  assert.equal(vm.runInContext('elements.mediaInfoHeading.textContent', context), 'Media information: <img onerror="bad">');
  assert.match(vm.runInContext('elements.mediaInfoSummary.innerHTML', context), /<dt>GB\/hour<\/dt><dd>2\.00<\/dd>/);
});

test('Sonarr series metadata includes its typical runtime without fetching episode files', async () => {
  const client = new ArrClient({}, {});
  let calls = 0;
  client.request = async () => { calls++; return [{ id: 1, runtime: 45, statistics: { episodeFileCount: 10, sizeOnDisk: gb } }]; };
  const [series] = await client.getSonarrSeries();
  assert.equal(series.runtimeMinutes, 45);
  assert.equal(series.episodeFileCount, 10);
  assert.equal(calls, 1);
});

test('media-info dismissal restores focus and preserves the underlying episode modal', () => {
  const nodes = Object.fromEntries([...index.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', hidden: true, listeners: {}, setAttribute() {}, focus() {},
    addEventListener(event, handler) { this.listeners[event] = handler; }
  }]));
  const documentEvents = {};
  const bodyClasses = new Set();
  let focusedSelector;
  const document = {
    readyState: 'loading', activeElement: null,
    body: { classList: { add: value => bodyClasses.add(value), remove: value => bodyClasses.delete(value) } },
    getElementById: id => nodes[id], querySelectorAll: () => [],
    querySelector: selector => ({ focus() { focusedSelector = selector; } }),
    addEventListener: (event, handler) => { documentEvents[event] = handler; }
  };
  nodes.mediaInfoModal.showModal = function () { this.open = true; };
  nodes.mediaInfoModal.close = function () { this.open = false; this.listeners.close(); };
  const context = vm.createContext({ document, ConversionEstimates, HTMLElement: class {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'public', appFile), 'utf8'), context);
  vm.runInContext(`cacheElements(); bindEvents(); state.movies = [{ service: 'radarr', title: 'Film', mediaInfo: {} }]; showMediaInfo(state.movies[0]);`, context);
  assert.ok(bodyClasses.has('modal-open'));
  nodes.mediaInfoClose.listeners.click();
  assert.ok(!bodyClasses.has('modal-open'));
  assert.equal(focusedSelector, '[data-action="probe-radarr"][data-index="0"]');

  nodes.episodeModal.hidden = false;
  vm.runInContext('showMediaInfo(state.movies[0])', context);
  const episodeAsset = index.match(/src="\/(episode-modal\.[^"?]+)/)[1];
  vm.runInContext(fs.readFileSync(path.join(root, 'public', episodeAsset), 'utf8'), context);
  documentEvents.DOMContentLoaded();
  documentEvents.keydown({ key: 'Escape', preventDefault() { throw new Error('Episode modal consumed Escape intended for media info'); } });
  assert.equal(nodes.episodeModal.hidden, false);
  nodes.mediaInfoModal.listeners.click({ target: nodes.mediaInfoJson });
  assert.equal(nodes.mediaInfoModal.open, true);
  nodes.mediaInfoModal.listeners.click({ target: nodes.mediaInfoModal });
  assert.ok(bodyClasses.has('modal-open'));
  assert.equal(nodes.episodeModal.hidden, false);
  documentEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(nodes.episodeModal.hidden, true);
  assert.ok(!bodyClasses.has('modal-open'));
});

test('full ffprobe includes all format, stream and chapter fields while preserving normalized metadata', async () => {
  const filename = path.join(root, 'src/ffmpeg.js');
  const localRequire = createRequire(filename);
  const payload = { format: { size: '4096', duration: '12', format_name: 'matroska', tags: { title: 'Example' } },
    streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, pix_fmt: 'yuv420p10le' },
      { codec_type: 'audio', codec_name: 'aac', channels: 6, tags: { language: 'eng' } }], chapters: [{ id: 0 }] };
  let args;
  const context = vm.createContext({ module: { exports: {} }, require(name) {
    if (name !== 'node:child_process') return localRequire(name);
    return { spawn(command, values) {
      args = values;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(payload)); child.emit('close', 0); });
      return child;
    } };
  } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  const probe = await context.module.exports.probeFile('/media/test.mkv', { ffprobePath: 'ffprobe' }, { full: true });
  for (const flag of ['-show_format', '-show_streams', '-show_chapters']) assert.ok(args.includes(flag));
  assert.equal(args.includes('-show_entries'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(probe.mediaInfo)), payload);
  assert.equal(probe.sizeBytes, 4096);
  assert.equal(probe.audioStreams, 1);
  await context.module.exports.probeFile('/media/test.mkv', { ffprobePath: 'ffprobe' });
  assert.ok(args.includes('-show_entries'));
});

test('status and clear-cache return measured bytes and the probe API exposes full information', async (context) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-media-api-'));
  context.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const activePath = path.join(cacheDir, 'transcode-job-1-active.mkv');
  fs.writeFileSync(activePath, Buffer.alloc(100));
  fs.writeFileSync(path.join(cacheDir, 'transcode-job-2-inactive.mkv'), Buffer.alloc(200));
  const filename = path.join(root, 'src/routes.js');
  const localRequire = createRequire(filename);
  let probeOptions;
  const mediaInfo = { format: { format_name: 'matroska' }, streams: [], chapters: [] };
  const routeContext = vm.createContext({ Promise, module: { exports: {} }, require(name) {
    if (name !== './ffmpeg') return localRequire(name);
    return { ...localRequire(name), probeFile: async (file, config, options) => {
      probeOptions = options; return { sizeBytes: 100, durationSeconds: 50, mediaInfo };
    } };
  } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), routeContext);
  const app = express(); app.use(express.json());
  const cached = [];
  app.use(routeContext.module.exports.createRouter({ config: { cacheDir }, logger: { warn() {} }, arrClient: {},
    db: { stats: () => ({}), getQueue: () => [], getHistory: () => [], updateCachedMediaProbe: (...args) => cached.push(args) },
    worker: { status: () => ({ status: 'Idle' }), activeTempPath: () => activePath } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(base + '/api/status?compact=1')).json()).cacheSizeBytes, 300);
  assert.deepEqual(await (await fetch(base + '/api/clear-cache', { method: 'POST' })).json(), { removed: 1, cacheSizeBytes: 100 });
  const response = await fetch(base + '/api/media/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'sonarr', path: path.join(cacheDir, 'test.mkv') }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).mediaInfo, mediaInfo);
  assert.equal(probeOptions.full, true);
  assert.equal(cached.length, 1);
});
