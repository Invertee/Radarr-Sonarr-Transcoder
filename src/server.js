'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { createLogger } = require('./logger');
const { createDatabase } = require('./db');
const { seedInitialStatsDatabase } = require('./initial-stats');
const { ArrClient } = require('./arr-client');
const { QueueWorker } = require('./queue-worker');
const { createRouter } = require('./routes');
const { acquireInstanceLock } = require('./instance-lock');
const { getProfile } = require('./profiles');
const { removeStaleCacheFiles } = require('./cache-cleaner');

const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

for (const directory of [config.dataDir, config.cacheDir, config.logDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const logger = createLogger({ logPath: config.logPath, maxBytes: config.logMaxBytes });
const releaseLock = acquireInstanceLock(config.instanceLockPath);
const initialStatsSeeded = seedInitialStatsDatabase(config.databasePath, config.initialStats);
const db = createDatabase(config.databasePath, logger);
const arrClient = new ArrClient(config, logger);
const worker = new QueueWorker({ db, config, logger, arrClient });
const startedAt = new Date().toISOString();

if (initialStatsSeeded) {
  logger.info('Created database with configured starting statistics', config.initialStats);
}

if (getProfile(config.defaultProfile).key !== config.defaultProfile) {
  logger.warn('DEFAULT_PROFILE was not recognised; medium will be used', { configuredValue: config.defaultProfile });
}

const publicDirectory = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicDirectory, 'index.html');
const app = express();

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'none'; frame-ancestors ${config.frameAncestors}; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '2mb', strict: true }));
app.use(createRouter({ db, worker, arrClient, config, logger, startedAt }));
app.get('/', (request, response) => {
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.sendFile(indexPath);
});
app.use(express.static(publicDirectory, {
  etag: true,
  fallthrough: true,
  index: false,
  maxAge: config.nodeEnv === 'production' ? '1y' : 0,
  immutable: config.nodeEnv === 'production',
  setHeaders(response, filePath) {
    if (filePath.endsWith('index.html')) {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'API route not found' });
});
app.use((request, response) => {
  response.status(404).type('text/plain').send('Not found');
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }

  const statusCode = Number(error.statusCode || error.status) || 500;
  if (statusCode >= 500) {
    logger.error('HTTP request failed', {
      method: request.method,
      path: request.path,
      error: error.stack || error.message
    });
  }

  return response.status(statusCode).json({
    error: error.message || 'Unexpected server error',
    details: statusCode < 500 ? error.details || null : null
  });
});

let shuttingDown = false;
let workerStarted = false;
let cacheCleanupInFlight = false;
let cacheCleanupTimer = null;
let server;

async function runCacheCleanup() {
  if (cacheCleanupInFlight) {
    return;
  }
  cacheCleanupInFlight = true;
  try {
    const removed = await removeStaleCacheFiles({
      cacheDir: config.cacheDir,
      activeTempPath: worker.activeTempPath(),
      retentionMs: config.cacheRetentionHours * 60 * 60 * 1000
    });
    if (removed > 0) {
      logger.info('Removed expired transcode cache files', {
        removed,
        retentionHours: config.cacheRetentionHours
      });
    }
  } catch (error) {
    logger.warn('Scheduled transcode cache cleanup failed', { error: error.stack || error.message });
  } finally {
    cacheCleanupInFlight = false;
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('Service shutdown requested', { signal, exitCode });

  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer);
    cacheCleanupTimer = null;
  }

  const serverClosed = new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

  try {
    if (workerStarted) {
      await worker.stop();
    }
    await serverClosed;
  } catch (error) {
    logger.error('Error during service shutdown', { error: error.stack || error.message });
    exitCode = 1;
  } finally {
    try {
      db.close();
    } finally {
      releaseLock();
    }
  }

  process.exit(exitCode);
}

server = app.listen(config.port, config.host, () => {
  logger.info('Transcode Manager started', {
    version: config.appVersion,
    address: `http://${config.host}:${config.port}`,
    database: config.databasePath,
    vaapiDevice: config.vaapiDevice,
    frameAncestors: config.frameAncestors,
    cacheRetentionHours: config.cacheRetentionHours
  });
  worker.start();
  workerStarted = true;
  void runCacheCleanup();
  cacheCleanupTimer = setInterval(() => void runCacheCleanup(), CACHE_SWEEP_INTERVAL_MS);
  cacheCleanupTimer.unref?.();
});

server.on('error', (error) => {
  logger.error('HTTP server failed', { error: error.stack || error.message });
  shutdown('serverError', 1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.stack || error.message });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error: error?.stack || String(error) });
  shutdown('unhandledRejection', 1);
});
