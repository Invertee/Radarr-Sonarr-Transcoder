'use strict';

const path = require('node:path');
const packageJson = require('../package.json');

function integer(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function string(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
}

function frameAncestors() {
  const configured = string('FRAME_ANCESTORS', "'self' https:");
  const values = configured.split(/\s+/).filter(Boolean);
  const valid = values.filter((value) => {
    if (["'self'", "'none'", '*', 'http:', 'https:'].includes(value)) {
      return true;
    }
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash;
    } catch {
      return false;
    }
  });

  if (valid.length === 0) {
    throw new Error('FRAME_ANCESTORS must contain one or more CSP frame-ancestors sources');
  }
  return valid.join(' ');
}

const workingDirectory = process.cwd();
const dataDir = path.resolve(string('DATA_DIR', path.join(workingDirectory, 'data')));
const cacheDir = path.resolve(string('CACHE_DIR', path.join(workingDirectory, 'cache')));
const logDir = path.resolve(string('LOG_DIR', path.join(workingDirectory, 'logs')));

const config = Object.freeze({
  appVersion: packageJson.version,
  nodeEnv: string('NODE_ENV', 'production'),
  host: string('HOST', '0.0.0.0'),
  port: integer('PORT', 5000, 1, 65535),
  frameAncestors: frameAncestors(),
  dataDir,
  cacheDir,
  logDir,
  databasePath: path.join(dataDir, 'transcode-manager.sqlite'),
  logPath: path.join(logDir, 'transcode-manager.log'),
  ffmpegLogPath: path.join(logDir, 'ffmpeg-last.log'),
  instanceLockPath: path.join(dataDir, 'transcode-manager.pid'),
  ffmpegPath: string('FFMPEG_PATH', '/usr/bin/ffmpeg'),
  ffprobePath: string('FFPROBE_PATH', '/usr/bin/ffprobe'),
  vaapiDevice: string('VAAPI_DEVICE', '/dev/dri/renderD128'),
  audioBitrate: string('AUDIO_BITRATE', '192k'),
  defaultProfile: string('DEFAULT_PROFILE', 'medium').toLowerCase(),
  arrTimeoutMs: integer('ARR_TIMEOUT_MS', 10000, 1000, 120000),
  queuePollMs: integer('QUEUE_POLL_MS', 1000, 250, 60000),
  logMaxBytes: integer('LOG_MAX_BYTES', 5 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  sonarr: Object.freeze({
    url: string('SONARR_URL', 'http://127.0.0.1:8989').replace(/\/$/, ''),
    apiKey: string('SONARR_API_KEY'),
    pathFrom: string('SONARR_PATH_FROM'),
    pathTo: string('SONARR_PATH_TO')
  }),
  radarr: Object.freeze({
    url: string('RADARR_URL', 'http://127.0.0.1:7878').replace(/\/$/, ''),
    apiKey: string('RADARR_API_KEY'),
    pathFrom: string('RADARR_PATH_FROM'),
    pathTo: string('RADARR_PATH_TO')
  })
});

module.exports = config;
