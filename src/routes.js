'use strict';

const path = require('node:path');
const express = require('express');
const { clearCache, probeFile, supportedContainer } = require('./ffmpeg');
const { PROFILES, getProfile, listProfiles, normalizeTag, selectProfileFromTags } = require('./profiles');
const { mapServicePath } = require('./path-mapper');
const { extractWebhookJob } = require('./webhook');

const ALLOWED_SOURCES = new Set(['manual', 'sonarr', 'radarr']);

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function publicJob(row) {
  return {
    id: Number(row.id),
    status: row.status,
    queuePosition: row.queue_position === null ? null : Number(row.queue_position),
    path: row.path,
    title: row.title,
    profileKey: row.profile_key,
    sourceService: row.source_service,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    originalBytes: row.original_bytes === null ? null : Number(row.original_bytes),
    outputBytes: row.output_bytes === null ? null : Number(row.output_bytes),
    savedBytes: row.saved_bytes === null ? null : Number(row.saved_bytes),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    audioStreams: row.audio_streams === null ? null : Number(row.audio_streams),
    progress: Number(row.progress || 0),
    fps: row.fps,
    speed: row.speed,
    error: row.error
  };
}

function parseOptionalInteger(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badRequest(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function validateMediaPath(jobPath) {
  if (!path.isAbsolute(jobPath)) {
    throw badRequest('path must be an absolute path visible to the transcoder VM');
  }
  try {
    supportedContainer(jobPath);
  } catch (error) {
    throw badRequest(error.message);
  }
}

function parseJobBody(body, config) {
  const jobPath = String(body?.path || '').trim();
  if (!jobPath) {
    throw badRequest('path is required');
  }
  validateMediaPath(jobPath);

  const requestedProfile = normalizeTag(body?.profileKey || body?.quality || config.defaultProfile);
  if (!PROFILES[requestedProfile]) {
    throw badRequest(`Unknown profile '${requestedProfile}'`);
  }
  const profile = getProfile(requestedProfile, config.defaultProfile);

  const sourceService = String(body?.sourceService || 'manual').trim().toLowerCase();
  if (!ALLOWED_SOURCES.has(sourceService)) {
    throw badRequest('sourceService must be manual, sonarr or radarr');
  }

  return {
    path: jobPath,
    title: String(body?.title || '').trim() || path.basename(jobPath),
    profileKey: profile.key,
    sourceService,
    sourceItemId: parseOptionalInteger(body?.sourceItemId, 'sourceItemId'),
    sourceFileId: parseOptionalInteger(body?.sourceFileId, 'sourceFileId'),
    sourceSeriesId: parseOptionalInteger(body?.sourceSeriesId ?? body?.seriesId, 'sourceSeriesId'),
    sourceMovieId: parseOptionalInteger(body?.sourceMovieId ?? body?.movieId, 'sourceMovieId'),
    eventType: body?.eventType ? String(body.eventType).slice(0, 100) : null,
    requestedBy: String(body?.requestedBy || 'manual').slice(0, 100)
  };
}

function createRouter({ db, worker, arrClient, config, logger, startedAt }) {
  const router = express.Router();

  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/health', (request, response) => {
    const databaseOk = db.ping();
    response.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? 'ok' : 'degraded',
      database: databaseOk ? 'ok' : 'unavailable',
      version: config.appVersion,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  router.get('/api/status', (request, response) => {
    const stats = db.stats();
    const current = worker.status();
    const payload = {
      version: config.appVersion,
      startedAt,
      current: {
        ...current,
        file: current.file,
        full_path: current.fullPath,
        duration: current.durationSeconds
      },
      progress: current.progress,
      queue: db.getQueue().map(publicJob),
      stats: {
        ...stats,
        saved_gb: stats.savedGiB,
        count: stats.filesProcessed,
        percent: stats.efficiencyPercent
      }
    };

    if (request.query.compact !== '1') {
      payload.history = db.getHistory(100).map(publicJob);
    }

    response.json(payload);
  });

  router.get('/api/stats', (request, response) => {
    response.json(db.stats());
  });

  router.get('/api/profiles', (request, response) => {
    response.json(listProfiles());
  });

  router.get('/api/connections', asyncRoute(async (request, response) => {
    const [sonarr, radarr] = await Promise.all([arrClient.health('sonarr'), arrClient.health('radarr')]);
    response.json({ sonarr, radarr });
  }));

  router.get('/api/queue', (request, response) => {
    response.json(db.getQueue().map(publicJob));
  });

  router.post('/api/queue', (request, response) => {
    const result = db.enqueueJob(parseJobBody(request.body, config));
    response.status(result.deduplicated ? 200 : 201).json({
      deduplicated: result.deduplicated,
      job: publicJob(result.job)
    });
  });

  router.post('/api/queue/reorder', (request, response) => {
    const jobIds = request.body?.jobIds;
    if (!Array.isArray(jobIds) || jobIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
      throw badRequest('jobIds must be an array of positive job IDs');
    }
    response.json(db.reorderQueue(jobIds).map(publicJob));
  });

  router.delete('/api/queue/:id', (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw badRequest('Invalid job ID');
    }
    const removed = db.removeQueuedJob(id);
    if (!removed) {
      return response.status(404).json({ error: 'Queued job not found' });
    }
    return response.status(204).end();
  });

  router.post('/api/queue/clear', (request, response) => {
    response.json({ removed: db.clearQueue() });
  });

  router.post('/api/active/cancel', (request, response) => {
    if (!worker.cancelActive()) {
      return response.status(409).json({ error: 'There is no active job' });
    }
    return response.status(202).json({ status: 'stopping' });
  });

  router.get('/api/history', (request, response) => {
    response.json(db.getHistory(request.query.limit).map(publicJob));
  });

  router.get('/api/logs', (request, response) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 200, 1), 1000);
    response.json({ lines: logger.tail(limit) });
  });

  router.post('/api/clear-cache', asyncRoute(async (request, response) => {
    const removed = await clearCache(config.cacheDir, worker.activeTempPath());
    response.json({ removed });
  }));

  router.post('/api/media/probe', asyncRoute(async (request, response) => {
    const service = String(request.body?.service || 'manual').trim().toLowerCase();
    if (!ALLOWED_SOURCES.has(service)) {
      throw badRequest('service must be manual, sonarr or radarr');
    }
    const mediaPath = String(request.body?.path || '').trim();
    if (!mediaPath) {
      throw badRequest('path is required');
    }
    validateMediaPath(mediaPath);

    const probe = await probeFile(mediaPath, config);
    if (service === 'sonarr' || service === 'radarr') {
      db.updateCachedMediaProbe(service, mediaPath, probe);
    }
    response.json({
      path: mediaPath,
      sizeBytes: probe.sizeBytes,
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : 'Unknown',
      videoCodec: probe.videoCodec,
      audioStreams: probe.audioStreams,
      audioLanguages: probe.audioLanguages,
      subtitleStreams: probe.subtitleStreams,
      attachmentStreams: probe.attachmentStreams
    });
  }));

  router.get('/api/media/sonarr/series', asyncRoute(async (request, response) => {
    response.json(await arrClient.getSonarrSeries());
  }));

  router.get('/api/media/sonarr/series/:id/files', asyncRoute(async (request, response) => {
    try {
      const files = await arrClient.getSonarrFiles(request.params.id);
      response.json(db.conversionState('sonarr', files));
    } catch (error) {
      const seriesId = Number(request.params.id);
      const cached = db.getCachedMedia('sonarr').filter((item) => Number(item.seriesId) === seriesId);
      if (cached.length === 0) {
        throw error;
      }
      logger.warn('Using cached Sonarr file metadata after an API error', { seriesId, error: error.message });
      response.setHeader('X-Transcode-Manager-Cache', 'stale');
      response.json(db.conversionState('sonarr', cached));
    }
  }));

  router.get('/api/media/radarr/movies', asyncRoute(async (request, response) => {
    try {
      const movies = await arrClient.getRadarrMovies();
      response.json(db.conversionState('radarr', movies));
    } catch (error) {
      const cached = db.getCachedMedia('radarr');
      if (cached.length === 0) {
        throw error;
      }
      logger.warn('Using cached Radarr metadata after an API error', { error: error.message });
      response.setHeader('X-Transcode-Manager-Cache', 'stale');
      response.json(db.conversionState('radarr', cached));
    }
  }));

  async function webhookHandler(request, response, serviceHint) {
    const extracted = extractWebhookJob(request.body, serviceHint);
    if (extracted.action === 'test') {
      return response.json({ status: 'ok', service: extracted.service, version: config.appVersion });
    }
    if (extracted.action === 'ignored') {
      return response.json({ status: 'ignored', eventType: extracted.eventType });
    }

    const tagNames = await arrClient.resolveTagNames(extracted.service, extracted.tags);
    const profile = selectProfileFromTags(tagNames, config.defaultProfile);
    if (profile.key === 'skip') {
      logger.info('Webhook ignored because media has a skip tag', {
        service: extracted.service,
        path: extracted.sourcePath,
        tags: tagNames
      });
      return response.json({ status: 'skipped', profile: profile.key, tags: tagNames });
    }

    const mappedPath = mapServicePath(extracted.service, extracted.sourcePath, config);
    validateMediaPath(mappedPath);
    const result = db.enqueueJob({
      path: mappedPath,
      title: extracted.title,
      profileKey: profile.key,
      sourceService: extracted.service,
      sourceItemId: extracted.sourceItemId,
      sourceFileId: extracted.sourceFileId,
      sourceSeriesId: extracted.sourceSeriesId,
      sourceMovieId: extracted.sourceMovieId,
      eventType: extracted.eventType,
      requestedBy: 'webhook'
    });

    logger.info(result.deduplicated ? 'Webhook job already queued' : 'Webhook job queued', {
      jobId: result.job.id,
      service: extracted.service,
      path: mappedPath,
      profile: profile.key,
      tags: tagNames
    });

    return response.status(result.deduplicated ? 200 : 202).json({
      status: result.deduplicated ? 'already-queued' : 'queued',
      profile: profile.key,
      tags: tagNames,
      job: publicJob(result.job)
    });
  }

  router.post('/api/webhook', asyncRoute((request, response) => webhookHandler(request, response, null)));
  router.post('/api/webhook/sonarr', asyncRoute((request, response) => webhookHandler(request, response, 'sonarr')));
  router.post('/api/webhook/radarr', asyncRoute((request, response) => webhookHandler(request, response, 'radarr')));

  // Compatibility aliases retained for existing webhook URLs and API bookmarks.
  router.get('/api/shows', asyncRoute(async (request, response) => response.json(await arrClient.getSonarrSeries())));
  router.get('/api/episodes/:id', asyncRoute(async (request, response) => {
    response.json(db.conversionState('sonarr', await arrClient.getSonarrFiles(request.params.id)));
  }));
  router.get('/api/movies', asyncRoute(async (request, response) => {
    response.json(db.conversionState('radarr', await arrClient.getRadarrMovies()));
  }));
  router.post('/api/transcode_file', (request, response) => {
    const result = db.enqueueJob(parseJobBody(request.body, config));
    response.status(result.deduplicated ? 200 : 201).json({
      status: result.deduplicated ? 'Already queued' : 'Queued',
      job: publicJob(result.job)
    });
  });
  router.post('/api/queue_all', (request, response) => {
    const files = Array.isArray(request.body?.files) ? request.body.files : [];
    const results = files.map((file) => db.enqueueJob(parseJobBody({
      ...file,
      profileKey: request.body?.profileKey || request.body?.quality,
      sourceService: file.sourceService || (request.body?.seriesId ? 'sonarr' : 'manual'),
      sourceSeriesId: request.body?.seriesId
    }, config)));
    response.json({ status: 'Bulk queued', added: results.filter((result) => !result.deduplicated).length });
  });
  router.post('/api/queue/remove', (request, response) => {
    const queue = db.getQueue();
    const index = Number(request.body?.index);
    const explicitId = Number(request.body?.id);
    const id = Number.isSafeInteger(explicitId) && explicitId > 0 ? explicitId : queue[index]?.id;
    if (!id || !db.removeQueuedJob(Number(id))) {
      return response.status(404).json({ error: 'Queued job not found' });
    }
    return response.json({ status: 'Removed' });
  });
  router.post('/api/stop', (request, response) => {
    const stopping = worker.cancelActive();
    response.status(stopping ? 202 : 409).json({ status: stopping ? 'Stopping' : 'Idle' });
  });
  router.post('/api/clear_cache', asyncRoute(async (request, response) => {
    response.json({ removed: await clearCache(config.cacheDir, worker.activeTempPath()) });
  }));
  router.get('/api/debug_log', asyncRoute(async (request, response) => {
    const fs = require('node:fs/promises');
    try {
      response.type('text/plain').send(await fs.readFile(config.ffmpegLogPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        response.type('text/plain').send('No FFmpeg log has been written yet.');
        return;
      }
      throw error;
    }
  }));

  return router;
}

module.exports = {
  createRouter,
  parseJobBody,
  publicJob
};
