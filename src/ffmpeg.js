'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SUPPORTED_CONTAINERS = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.m2ts']);
const TRANSIENT_COPY_ERRORS = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EIO',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTCONN',
  'ETIMEDOUT'
]);
const COPY_BUFFER_BYTES = 4 * 1024 * 1024;
const COPY_ATTEMPTS = 3;

class FfmpegError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'FfmpegError';
    this.details = details;
  }
}

class CancelledError extends Error {
  constructor(message = 'Transcode cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-100000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new FfmpegError(`${path.basename(command)} exited with code ${code}`, stderr));
      }
    });
  });
}

async function probeFile(filePath, config) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title:stream_disposition=default,forced',
    '-of', 'json',
    filePath
  ];
  const { stdout } = await runProcess(config.ffprobePath, args);
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new FfmpegError('ffprobe returned invalid JSON');
  }

  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic || 0) !== 1)
    || streams.find((stream) => stream.codec_type === 'video')
    || null;
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const subtitles = streams.filter((stream) => stream.codec_type === 'subtitle');
  const attachments = streams.filter((stream) => stream.codec_type === 'attachment');
  const audioLanguages = [...new Set(audio
    .map((stream) => String(stream.tags?.language || stream.tags?.LANGUAGE || 'und').trim())
    .filter(Boolean))];
  const durationSeconds = Number(payload.format?.duration || 0);
  const sizeBytes = Number(payload.format?.size || 0) || (await fsp.stat(filePath)).size;

  return {
    path: filePath,
    sizeBytes,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    width: Number(video?.width || 0) || null,
    height: Number(video?.height || 0) || null,
    videoCodec: video?.codec_name || null,
    audioStreams: audio.length,
    subtitleStreams: subtitles.length,
    attachmentStreams: attachments.length,
    audioLanguages,
    streams
  };
}

function supportedContainer(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (SUPPORTED_CONTAINERS.has(extension)) {
    return extension;
  }
  throw new FfmpegError(`Unsupported output container ${extension || '(none)'}. Supported containers are MKV, MP4, M4V, MOV and M2TS.`);
}

function buildFfmpegArgs({ inputPath, outputPath, profile, config }) {
  const extension = supportedContainer(inputPath);
  const videoFilter = `format=nv12,hwupload,scale_vaapi=w='min(iw,${profile.maxWidth})':h=-2:format=nv12`;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-init_hw_device', `vaapi=va:${config.vaapiDevice}`,
    '-filter_hw_device', 'va',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-map_metadata', '0',
    '-map_chapters', '0',
    '-vf', videoFilter,
    '-c:v', 'hevc_vaapi',
    '-qp', String(profile.qp),
    '-bf', '0',
    '-c:a', 'aac',
    '-b:a', config.audioBitrate,
    '-max_muxing_queue_size', '4096'
  ];

  if (extension === '.mkv') {
    args.push('-map', '0:s?', '-map', '0:t?', '-c:s', 'copy', '-c:t', 'copy');
  } else if (extension === '.m2ts') {
    args.push('-f', 'mpegts', '-mpegts_m2ts_mode', '1');
  } else {
    args.push('-movflags', '+faststart');
  }

  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function progressSnapshot(values, durationSeconds, outputPath) {
  const rawOutputTime = values.out_time_us ?? values.out_time_ms ?? 0;
  const outputTimeSeconds = Number(rawOutputTime) / 1000000;
  const safeOutputTime = Number.isFinite(outputTimeSeconds) ? outputTimeSeconds : 0;
  const percent = durationSeconds > 0
    ? Math.min(99.9, Math.max(0, (safeOutputTime / durationSeconds) * 100))
    : 0;

  return {
    percent: Number(percent.toFixed(1)),
    outputTimeSeconds: safeOutputTime,
    fps: values.fps || null,
    speed: values.speed || null,
    tempPath: outputPath
  };
}

function createProgressParser({ durationSeconds, outputPath, onProgress }) {
  let buffer = '';
  let values = {};

  function consumeLine(line) {
    const index = line.indexOf('=');
    if (index <= 0) {
      return;
    }

    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    values[key] = value;

    if (key === 'progress') {
      onProgress?.(progressSnapshot(values, durationSeconds, outputPath));
      values = {};
    }
  }

  return {
    push(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        consumeLine(line);
      }
    },
    flush() {
      if (buffer) {
        consumeLine(buffer);
        buffer = '';
      }
    }
  };
}

function createTempOutput(jobId, inputPath, cacheDir) {
  const extension = supportedContainer(inputPath);
  const token = crypto.randomBytes(6).toString('hex');
  return path.join(cacheDir, `transcode-job-${jobId}-${token}${extension}`);
}

async function transcode({ jobId, inputPath, outputPath, profile, durationSeconds, config, logger, signal, onProgress }) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const args = buildFfmpegArgs({ inputPath, outputPath, profile, config });
  const ffmpegLog = fs.createWriteStream(config.ffmpegLogPath, { flags: 'w' });

  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let settled = false;
    let killTimer = null;
    const progressParser = createProgressParser({ durationSeconds, outputPath, onProgress });

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener('abort', abortHandler);
      progressParser.flush();
      ffmpegLog.end();
      callback(value);
    };

    const abortHandler = () => {
      logger.warn('Stopping active FFmpeg process', { jobId, pid: child.pid });
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      killTimer.unref?.();
    };

    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout.on('data', (chunk) => progressParser.push(chunk));

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      ffmpegLog.write(text);
      stderrTail = `${stderrTail}${text}`.slice(-50000);
    });

    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, closeSignal) => {
      if (signal?.aborted) {
        finish(reject, new CancelledError());
        return;
      }
      if (code === 0) {
        progressParser.flush();
        onProgress?.({
          percent: 100,
          outputTimeSeconds: durationSeconds,
          fps: null,
          speed: null,
          tempPath: outputPath
        });
        finish(resolve, { code, signal: closeSignal });
      } else {
        finish(reject, new FfmpegError(`FFmpeg exited with code ${code}${closeSignal ? ` (${closeSignal})` : ''}`, stderrTail));
      }
    });
  });
}

function verifyOutput(inputProbe, outputProbe) {
  if (!outputProbe.width || !outputProbe.height) {
    throw new FfmpegError('Output verification failed: no video stream was found');
  }
  if (outputProbe.videoCodec !== 'hevc') {
    throw new FfmpegError(`Output verification failed: expected HEVC video, found ${outputProbe.videoCodec || 'none'}`);
  }
  if (outputProbe.audioStreams !== inputProbe.audioStreams) {
    throw new FfmpegError(
      `Output verification failed: input has ${inputProbe.audioStreams} audio stream(s), output has ${outputProbe.audioStreams}`
    );
  }
  if (path.extname(inputProbe.path || '').toLowerCase() === '.mkv') {
    if (outputProbe.subtitleStreams !== inputProbe.subtitleStreams) {
      throw new FfmpegError(
        `Output verification failed: input has ${inputProbe.subtitleStreams} subtitle stream(s), output has ${outputProbe.subtitleStreams}`
      );
    }
    if (outputProbe.attachmentStreams !== inputProbe.attachmentStreams) {
      throw new FfmpegError(
        `Output verification failed: input has ${inputProbe.attachmentStreams} attachment stream(s), output has ${outputProbe.attachmentStreams}`
      );
    }
  }
  if (inputProbe.durationSeconds > 0 && outputProbe.durationSeconds > 0) {
    const tolerance = Math.max(2, inputProbe.durationSeconds * 0.01);
    if (Math.abs(inputProbe.durationSeconds - outputProbe.durationSeconds) > tolerance) {
      throw new FfmpegError('Output verification failed: output duration differs from the input');
    }
  }
  if (outputProbe.sizeBytes < 1024) {
    throw new FfmpegError('Output verification failed: output file is empty');
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fsp.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function bufferedCopy(sourcePath, destinationPath, signal) {
  const source = await fsp.open(sourcePath, 'r');
  let destination = null;

  try {
    destination = await fsp.open(destinationPath, 'wx', 0o666);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let sourcePosition = 0;

    while (true) {
      if (signal?.aborted) {
        throw new CancelledError();
      }

      const { bytesRead } = await source.read(buffer, 0, buffer.length, sourcePosition);
      if (bytesRead === 0) {
        break;
      }

      let written = 0;
      while (written < bytesRead) {
        if (signal?.aborted) {
          throw new CancelledError();
        }
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          sourcePosition + written
        );
        if (result.bytesWritten <= 0) {
          const error = new Error('Destination write returned zero bytes');
          error.code = 'EIO';
          throw error;
        }
        written += result.bytesWritten;
      }
      sourcePosition += bytesRead;
    }

    await destination.sync();
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }

  const [sourceStat, destinationStat] = await Promise.all([
    fsp.stat(sourcePath),
    fsp.stat(destinationPath)
  ]);
  if (sourceStat.size !== destinationStat.size) {
    throw new FfmpegError(
      `Copied output size mismatch: expected ${sourceStat.size} bytes, found ${destinationStat.size}`
    );
  }
}

async function copyToMediaDirectory(sourcePath, inputDirectory, extension, { logger, signal } = {}) {
  const failedSidecars = [];

  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    const sidecarPath = path.join(
      inputDirectory,
      `.transcode-manager-${crypto.randomBytes(6).toString('hex')}${extension}`
    );

    try {
      await bufferedCopy(sourcePath, sidecarPath, signal);
      await Promise.allSettled(failedSidecars.map((failedPath) => fsp.rm(failedPath, { force: true })));
      return sidecarPath;
    } catch (error) {
      failedSidecars.push(sidecarPath);
      await fsp.rm(sidecarPath, { force: true }).catch(() => undefined);

      if (error instanceof CancelledError || !TRANSIENT_COPY_ERRORS.has(error.code) || attempt === COPY_ATTEMPTS) {
        throw error;
      }

      logger?.warn('Media share copy interrupted; retrying', {
        attempt,
        maxAttempts: COPY_ATTEMPTS,
        sourcePath,
        destinationDirectory: inputDirectory,
        code: error.code,
        error: error.message
      });
      await delay(attempt * 2000);
    }
  }

  throw new FfmpegError('Media share copy failed after retries');
}

async function renameWithRetry(sourcePath, destinationPath, logger) {
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!TRANSIENT_COPY_ERRORS.has(error.code) || attempt === COPY_ATTEMPTS) {
        throw error;
      }
      logger?.warn('Media share rename interrupted; retrying', {
        attempt,
        maxAttempts: COPY_ATTEMPTS,
        sourcePath,
        destinationPath,
        code: error.code,
        error: error.message
      });
      await delay(attempt * 2000);
    }
  }
}

async function atomicReplace(inputPath, outputPath, options = {}) {
  const inputDirectory = path.dirname(inputPath);
  const extension = path.extname(inputPath);
  let sidecarPath = null;

  try {
    sidecarPath = await copyToMediaDirectory(outputPath, inputDirectory, extension, options);
    if (options.signal?.aborted) {
      throw new CancelledError();
    }
    await renameWithRetry(sidecarPath, inputPath, options.logger);
    sidecarPath = null;
    await syncDirectory(inputDirectory);
  } catch (error) {
    if (sidecarPath) {
      await fsp.rm(sidecarPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function removeTemp(filePath) {
  if (filePath) {
    await fsp.rm(filePath, { force: true });
  }
}

async function clearCache(cacheDir, activeTempPath = null) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    const candidate = path.join(cacheDir, entry.name);
    if (!entry.isFile() || !entry.name.startsWith('transcode-job-') || candidate === activeTempPath) {
      continue;
    }
    await fsp.rm(candidate, { force: true });
    removed += 1;
  }
  return removed;
}

module.exports = {
  CancelledError,
  FfmpegError,
  atomicReplace,
  bufferedCopy,
  buildFfmpegArgs,
  clearCache,
  createProgressParser,
  createTempOutput,
  probeFile,
  removeTemp,
  supportedContainer,
  transcode,
  verifyOutput
};
