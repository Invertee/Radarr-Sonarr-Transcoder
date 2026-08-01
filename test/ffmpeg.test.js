'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  FfmpegError,
  atomicReplace,
  bufferedCopy,
  buildFfmpegArgs,
  createProgressParser,
  verifyOutput
} = require('../src/ffmpeg');
const { getProfile } = require('../src/profiles');

const config = {
  vaapiDevice: '/dev/dri/renderD128',
  audioBitrate: '192k'
};

test('FFmpeg maps and converts every audio stream without forcing stereo', () => {
  const args = buildFfmpegArgs({
    inputPath: '/media/example.mkv',
    outputPath: '/cache/example.mkv',
    profile: getProfile('medium'),
    config
  });

  assert.ok(args.some((value, index) => value === '-init_hw_device' && args[index + 1] === 'vaapi=va:/dev/dri/renderD128'));
  assert.ok(args.some((value, index) => value === '-map' && args[index + 1] === '0:a?'));
  assert.ok(args.some((value, index) => value === '-c:a' && args[index + 1] === 'aac'));
  assert.ok(args.some((value, index) => value === '-b:a' && args[index + 1] === '192k'));
  assert.equal(args.includes('-ac'), false);
  assert.ok(args.some((value, index) => value === '-map' && args[index + 1] === '0:s?'));
  assert.ok(args.some((value, index) => value === '-map' && args[index + 1] === '0:t?'));
});

test('MP4 outputs avoid incompatible subtitle and attachment copies', () => {
  const args = buildFfmpegArgs({
    inputPath: '/media/example.mp4',
    outputPath: '/cache/example.mp4',
    profile: getProfile('high'),
    config
  });

  assert.equal(args.includes('0:s?'), false);
  assert.equal(args.includes('0:t?'), false);
  assert.ok(args.some((value, index) => value === '-movflags' && args[index + 1] === '+faststart'));
});

test('M2TS outputs select the MPEG-TS muxer', () => {
  const args = buildFfmpegArgs({
    inputPath: '/media/example.m2ts',
    outputPath: '/cache/example.m2ts',
    profile: getProfile('medium'),
    config
  });

  assert.ok(args.some((value, index) => value === '-f' && args[index + 1] === 'mpegts'));
  assert.ok(args.some((value, index) => value === '-mpegts_m2ts_mode' && args[index + 1] === '1'));
});

test('progress parser handles FFmpeg output split across chunks', () => {
  const updates = [];
  const parser = createProgressParser({
    durationSeconds: 100,
    outputPath: '/cache/example.mkv',
    onProgress: (progress) => updates.push(progress)
  });

  parser.push('fps=48.0\nout_time_us=250000');
  parser.push('00\nspeed=2.0x\nprogress=continue\n');
  parser.flush();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].percent, 25);
  assert.equal(updates[0].fps, '48.0');
  assert.equal(updates[0].speed, '2.0x');
});

test('output verification rejects missing audio streams', () => {
  assert.throws(
    () => verifyOutput(
      { path: '/media/example.mkv', durationSeconds: 100, audioStreams: 2, subtitleStreams: 0, attachmentStreams: 0 },
      { durationSeconds: 100, audioStreams: 1, subtitleStreams: 0, attachmentStreams: 0, videoCodec: 'hevc', width: 1920, height: 1080, sizeBytes: 5000 }
    ),
    FfmpegError
  );
});

test('buffered copy preserves the complete file', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-copy-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.mkv');
  const destinationPath = path.join(directory, 'destination.mkv');
  const sourceData = Buffer.alloc((5 * 1024 * 1024) + 137, 0x5a);
  await fs.writeFile(sourcePath, sourceData);

  await bufferedCopy(sourcePath, destinationPath);

  const destinationData = await fs.readFile(destinationPath);
  assert.deepEqual(destinationData, sourceData);
});

test('atomic replacement leaves no sidecar files', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-replace-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'movie.mkv');
  const outputPath = path.join(directory, 'converted.mkv');
  await fs.writeFile(inputPath, 'original');
  await fs.writeFile(outputPath, 'converted output');

  await atomicReplace(inputPath, outputPath);

  assert.equal(await fs.readFile(inputPath, 'utf8'), 'converted output');
  const sidecars = (await fs.readdir(directory)).filter((name) => name.startsWith('.transcode-manager-'));
  assert.deepEqual(sidecars, []);
});
