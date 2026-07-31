'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const BASELINE_STATS = Object.freeze({
  totalOriginalBytes: 1951444710009,
  totalSavedBytes: 1098663371735,
  filesProcessed: 805
});

function now() {
  return new Date().toISOString();
}

function createTransaction(sqlite, callback) {
  return (...args) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(...args);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // Preserve the original error if the connection has already rolled back.
      }
      throw error;
    }
  };
}

function normalizeAudioLanguages(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry?.name || entry?.language || entry || '').trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value).split(/[,/]/).map((entry) => entry.trim()).filter(Boolean);
}

function publicCachedMedia(row) {
  let audioLanguages = [];
  try {
    audioLanguages = JSON.parse(row.audio_languages_json || '[]');
  } catch {
    audioLanguages = [];
  }

  return {
    service: row.source_service,
    itemId: row.source_item_id === null ? null : Number(row.source_item_id),
    seriesId: row.source_series_id === null ? null : Number(row.source_series_id),
    movieId: row.source_movie_id === null ? null : Number(row.source_movie_id),
    fileId: row.source_file_id === null ? null : Number(row.source_file_id),
    title: row.title,
    relativePath: row.relative_path || '',
    path: row.path,
    sizeBytes: Number(row.size_bytes || 0),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    resolution: row.resolution || 'Unknown',
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    audioLanguages,
    quality: row.quality,
    hasFile: Boolean(row.has_file),
    cachedAt: row.last_seen_at
  };
}

function createDatabase(databasePath, logger) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_original_bytes INTEGER NOT NULL,
      total_saved_bytes INTEGER NOT NULL,
      files_processed INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled', 'skipped')),
      queue_position INTEGER,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      source_service TEXT CHECK (source_service IN ('sonarr', 'radarr', 'manual') OR source_service IS NULL),
      source_item_id INTEGER,
      source_file_id INTEGER,
      source_series_id INTEGER,
      source_movie_id INTEGER,
      event_type TEXT,
      requested_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      original_bytes INTEGER,
      output_bytes INTEGER,
      saved_bytes INTEGER,
      duration_seconds REAL,
      width INTEGER,
      height INTEGER,
      audio_streams INTEGER,
      progress REAL NOT NULL DEFAULT 0,
      fps TEXT,
      speed TEXT,
      output_time_seconds REAL,
      error TEXT,
      temp_path TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_path
      ON jobs(path)
      WHERE status IN ('queued', 'processing');

    CREATE INDEX IF NOT EXISTS jobs_queue_order
      ON jobs(status, queue_position, id);

    CREATE INDEX IF NOT EXISTS jobs_history_order
      ON jobs(finished_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS conversion_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      source_service TEXT,
      source_item_id INTEGER,
      source_file_id INTEGER,
      source_series_id INTEGER,
      source_movie_id INTEGER,
      job_id INTEGER NOT NULL,
      profile_key TEXT NOT NULL,
      converted_at TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      current_bytes INTEGER NOT NULL,
      saved_bytes INTEGER NOT NULL,
      duration_seconds REAL,
      width INTEGER,
      height INTEGER,
      audio_streams INTEGER,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS conversion_service_file
      ON conversion_records(source_service, source_file_id);

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_service TEXT NOT NULL CHECK (source_service IN ('sonarr', 'radarr')),
      source_item_id INTEGER,
      source_file_id INTEGER,
      source_series_id INTEGER,
      source_movie_id INTEGER,
      title TEXT NOT NULL,
      relative_path TEXT,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL,
      width INTEGER,
      height INTEGER,
      resolution TEXT,
      video_codec TEXT,
      audio_codec TEXT,
      audio_languages_json TEXT NOT NULL DEFAULT '[]',
      quality TEXT,
      has_file INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source_service, path)
    );

    CREATE INDEX IF NOT EXISTS media_items_service_title
      ON media_items(source_service, title, source_file_id);

    CREATE INDEX IF NOT EXISTS media_items_service_file
      ON media_items(source_service, source_file_id);
  `);

  const timestamp = now();
  sqlite.prepare(`
    INSERT OR IGNORE INTO app_stats (
      id, total_original_bytes, total_saved_bytes, files_processed, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    BASELINE_STATS.totalOriginalBytes,
    BASELINE_STATS.totalSavedBytes,
    BASELINE_STATS.filesProcessed,
    timestamp,
    timestamp
  );

  sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(timestamp);
  sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(timestamp);

  const transaction = (callback) => createTransaction(sqlite, callback);

  const requeueInterrupted = transaction(() => {
    const interrupted = sqlite.prepare("SELECT id FROM jobs WHERE status = 'processing' ORDER BY id").all();
    if (interrupted.length === 0) {
      return 0;
    }

    let position = Number(sqlite.prepare("SELECT COALESCE(MAX(queue_position), 0) AS position FROM jobs WHERE status = 'queued'").get().position);
    const update = sqlite.prepare(`
      UPDATE jobs
      SET status = 'queued', queue_position = ?, started_at = NULL, progress = 0,
          error = 'Requeued after an interrupted service process', temp_path = NULL
      WHERE id = ?
    `);

    for (const row of interrupted) {
      position += 1;
      update.run(position, row.id);
    }
    return interrupted.length;
  });

  const interruptedCount = requeueInterrupted();
  if (interruptedCount > 0) {
    logger.warn('Requeued interrupted jobs after startup', { count: interruptedCount });
  }

  const statements = {
    getStats: sqlite.prepare('SELECT * FROM app_stats WHERE id = 1'),
    maxQueuePosition: sqlite.prepare("SELECT COALESCE(MAX(queue_position), 0) AS position FROM jobs WHERE status = 'queued'"),
    insertJob: sqlite.prepare(`
      INSERT INTO jobs (
        status, queue_position, path, title, profile_key, source_service,
        source_item_id, source_file_id, source_series_id, source_movie_id,
        event_type, requested_by, created_at
      ) VALUES ('queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    findActivePath: sqlite.prepare("SELECT * FROM jobs WHERE path = ? AND status IN ('queued', 'processing') ORDER BY id DESC LIMIT 1"),
    getJob: sqlite.prepare('SELECT * FROM jobs WHERE id = ?'),
    getQueue: sqlite.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position, id"),
    getProcessing: sqlite.prepare("SELECT * FROM jobs WHERE status = 'processing' ORDER BY started_at LIMIT 1"),
    claimNext: sqlite.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position, id LIMIT 1"),
    markProcessing: sqlite.prepare(`
      UPDATE jobs SET status = 'processing', queue_position = NULL, started_at = ?, progress = 0, error = NULL
      WHERE id = ? AND status = 'queued'
    `),
    updateProgress: sqlite.prepare(`
      UPDATE jobs SET progress = ?, fps = ?, speed = ?, output_time_seconds = ?, temp_path = ?
      WHERE id = ? AND status = 'processing'
    `),
    updateInputMetadata: sqlite.prepare(`
      UPDATE jobs SET original_bytes = ?, duration_seconds = ?, width = ?, height = ?, audio_streams = ?, temp_path = ?
      WHERE id = ?
    `),
    markFailed: sqlite.prepare(`
      UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, progress = 0, temp_path = NULL
      WHERE id = ?
    `),
    markCancelled: sqlite.prepare(`
      UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ?, progress = 0, temp_path = NULL
      WHERE id = ?
    `),
    requeueJob: sqlite.prepare(`
      UPDATE jobs SET status = 'queued', queue_position = ?, started_at = NULL, finished_at = NULL,
        progress = 0, error = ?, temp_path = NULL
      WHERE id = ?
    `),
    getHistory: sqlite.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('completed', 'failed', 'cancelled', 'skipped')
      ORDER BY COALESCE(finished_at, created_at) DESC, id DESC
      LIMIT ?
    `),
    cancelQueued: sqlite.prepare(`
      UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Removed from queue', queue_position = NULL
      WHERE id = ? AND status = 'queued'
    `),
    clearQueued: sqlite.prepare(`
      UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Queue cleared', queue_position = NULL
      WHERE status = 'queued'
    `),
    allQueuedIds: sqlite.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY queue_position, id"),
    updateQueuePosition: sqlite.prepare("UPDATE jobs SET queue_position = ? WHERE id = ? AND status = 'queued'"),
    allConversionsForService: sqlite.prepare('SELECT * FROM conversion_records WHERE source_service = ?'),
    activePaths: sqlite.prepare("SELECT path, status FROM jobs WHERE status IN ('queued', 'processing')"),
    upsertConversion: sqlite.prepare(`
      INSERT INTO conversion_records (
        path, source_service, source_item_id, source_file_id, source_series_id, source_movie_id,
        job_id, profile_key, converted_at, original_bytes, current_bytes, saved_bytes,
        duration_seconds, width, height, audio_streams
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        source_service = excluded.source_service,
        source_item_id = excluded.source_item_id,
        source_file_id = excluded.source_file_id,
        source_series_id = excluded.source_series_id,
        source_movie_id = excluded.source_movie_id,
        job_id = excluded.job_id,
        profile_key = excluded.profile_key,
        converted_at = excluded.converted_at,
        original_bytes = excluded.original_bytes,
        current_bytes = excluded.current_bytes,
        saved_bytes = excluded.saved_bytes,
        duration_seconds = excluded.duration_seconds,
        width = excluded.width,
        height = excluded.height,
        audio_streams = excluded.audio_streams
    `),
    completeJob: sqlite.prepare(`
      UPDATE jobs SET
        status = 'completed', finished_at = ?, original_bytes = ?, output_bytes = ?, saved_bytes = ?,
        duration_seconds = ?, width = ?, height = ?, audio_streams = ?, progress = 100,
        output_time_seconds = ?, error = NULL, temp_path = NULL
      WHERE id = ?
    `),
    markSkipped: sqlite.prepare(`
      UPDATE jobs SET status = 'skipped', finished_at = ?, progress = 100,
        error = 'Skipped by profile', temp_path = NULL
      WHERE id = ?
    `),
    updateStats: sqlite.prepare(`
      UPDATE app_stats SET
        total_original_bytes = total_original_bytes + ?,
        total_saved_bytes = total_saved_bytes + ?,
        files_processed = files_processed + 1,
        updated_at = ?
      WHERE id = 1
    `),
    upsertMediaItem: sqlite.prepare(`
      INSERT INTO media_items (
        source_service, source_item_id, source_file_id, source_series_id, source_movie_id,
        title, relative_path, path, size_bytes, duration_seconds, width, height,
        resolution, video_codec, audio_codec, audio_languages_json, quality, has_file, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_service, path) DO UPDATE SET
        source_item_id = excluded.source_item_id,
        source_file_id = excluded.source_file_id,
        source_series_id = excluded.source_series_id,
        source_movie_id = excluded.source_movie_id,
        title = excluded.title,
        relative_path = excluded.relative_path,
        size_bytes = excluded.size_bytes,
        duration_seconds = excluded.duration_seconds,
        width = excluded.width,
        height = excluded.height,
        resolution = excluded.resolution,
        video_codec = excluded.video_codec,
        audio_codec = excluded.audio_codec,
        audio_languages_json = excluded.audio_languages_json,
        quality = excluded.quality,
        has_file = excluded.has_file,
        last_seen_at = excluded.last_seen_at
    `),
    cachedMedia: sqlite.prepare(`
      SELECT * FROM media_items
      WHERE source_service = ?
      ORDER BY title COLLATE NOCASE, source_file_id
    `),
    updateCachedMediaProbe: sqlite.prepare(`
      UPDATE media_items SET
        size_bytes = ?, duration_seconds = ?, width = ?, height = ?, resolution = ?,
        video_codec = ?, audio_languages_json = ?, last_seen_at = ?
      WHERE source_service = ? AND path = ?
    `)
  };

  const enqueueTransaction = transaction((job) => {
    const existing = statements.findActivePath.get(job.path);
    if (existing) {
      return { job: existing, deduplicated: true };
    }

    const position = Number(statements.maxQueuePosition.get().position) + 1;
    const createdAt = now();
    const result = statements.insertJob.run(
      position,
      job.path,
      job.title || path.basename(job.path),
      job.profileKey,
      job.sourceService || 'manual',
      job.sourceItemId ?? null,
      job.sourceFileId ?? null,
      job.sourceSeriesId ?? null,
      job.sourceMovieId ?? null,
      job.eventType || null,
      job.requestedBy || 'manual',
      createdAt
    );
    return { job: statements.getJob.get(Number(result.lastInsertRowid)), deduplicated: false };
  });

  const claimTransaction = transaction(() => {
    const next = statements.claimNext.get();
    if (!next) {
      return null;
    }
    const result = statements.markProcessing.run(now(), next.id);
    return Number(result.changes) === 1 ? statements.getJob.get(next.id) : null;
  });

  const completeTransaction = transaction((job, result) => {
    const finishedAt = now();
    statements.completeJob.run(
      finishedAt,
      result.originalBytes,
      result.outputBytes,
      result.savedBytes,
      result.durationSeconds,
      result.width,
      result.height,
      result.audioStreams,
      result.durationSeconds,
      job.id
    );
    statements.updateStats.run(result.originalBytes, result.savedBytes, finishedAt);
    statements.upsertConversion.run(
      job.path,
      job.source_service,
      job.source_item_id,
      job.source_file_id,
      job.source_series_id,
      job.source_movie_id,
      job.id,
      job.profile_key,
      finishedAt,
      result.originalBytes,
      result.outputBytes,
      result.savedBytes,
      result.durationSeconds,
      result.width,
      result.height,
      result.audioStreams
    );
    return statements.getJob.get(job.id);
  });

  const reorderTransaction = transaction((jobIds) => {
    const current = statements.allQueuedIds.all().map((row) => Number(row.id));
    const requested = jobIds.map(Number);
    const sortedCurrent = [...current].sort((a, b) => a - b);
    const sortedRequested = [...requested].sort((a, b) => a - b);
    if (current.length !== requested.length || sortedCurrent.some((id, index) => id !== sortedRequested[index])) {
      const error = new Error('Queue changed while it was being reordered. Refresh and try again.');
      error.statusCode = 409;
      throw error;
    }

    requested.forEach((id, index) => statements.updateQueuePosition.run(index + 1, id));
    return statements.getQueue.all();
  });

  const cacheMediaTransaction = transaction((service, items) => {
    const seenAt = now();
    for (const item of items) {
      if (!item.path) {
        continue;
      }
      statements.upsertMediaItem.run(
        service,
        item.itemId ?? null,
        item.fileId ?? null,
        item.seriesId ?? null,
        item.movieId ?? null,
        item.title || path.basename(item.path),
        item.relativePath || '',
        item.path,
        Number(item.sizeBytes || 0),
        item.durationSeconds ?? null,
        item.width ?? null,
        item.height ?? null,
        item.resolution || null,
        item.videoCodec || null,
        item.audioCodec || null,
        JSON.stringify(normalizeAudioLanguages(item.audioLanguages)),
        item.quality || null,
        item.hasFile === false ? 0 : 1,
        seenAt
      );
    }
  });

  function stats() {
    const row = statements.getStats.get();
    const original = Number(row.total_original_bytes);
    const saved = Number(row.total_saved_bytes);
    return {
      totalOriginalBytes: original,
      totalSavedBytes: saved,
      filesProcessed: Number(row.files_processed),
      efficiencyPercent: original > 0 ? Number(((saved / original) * 100).toFixed(1)) : 0,
      savedGiB: Number((saved / (1024 ** 3)).toFixed(2)),
      updatedAt: row.updated_at
    };
  }

  function conversionState(service, items) {
    cacheMediaTransaction(service, items);
    const records = statements.allConversionsForService.all(service);
    const byFileId = new Map();
    const byPath = new Map();
    for (const record of records) {
      if (record.source_file_id !== null) {
        byFileId.set(Number(record.source_file_id), record);
      }
      byPath.set(record.path, record);
    }

    const active = new Map(statements.activePaths.all().map((row) => [row.path, row.status]));
    return items.map((item) => {
      const conversion = (item.fileId ? byFileId.get(Number(item.fileId)) : null) || byPath.get(item.path) || null;
      return {
        ...item,
        queueStatus: active.get(item.path) || null,
        converted: Boolean(conversion),
        conversion: conversion ? {
          profileKey: conversion.profile_key,
          convertedAt: conversion.converted_at,
          savedBytes: Number(conversion.saved_bytes),
          currentBytes: Number(conversion.current_bytes),
          jobId: Number(conversion.job_id)
        } : null
      };
    });
  }

  return Object.freeze({
    sqlite,
    baselineStats: BASELINE_STATS,
    stats,
    enqueueJob: (job) => enqueueTransaction(job),
    getJob: (id) => statements.getJob.get(id),
    getQueue: () => statements.getQueue.all(),
    getProcessing: () => statements.getProcessing.get() || null,
    claimNextJob: () => claimTransaction(),
    updateProgress: (id, progress) => statements.updateProgress.run(
      progress.percent,
      progress.fps || null,
      progress.speed || null,
      progress.outputTimeSeconds || 0,
      progress.tempPath || null,
      id
    ),
    updateInputMetadata: (id, metadata, tempPath) => statements.updateInputMetadata.run(
      metadata.sizeBytes,
      metadata.durationSeconds,
      metadata.width,
      metadata.height,
      metadata.audioStreams,
      tempPath,
      id
    ),
    completeJob: (job, result) => completeTransaction(job, result),
    skipJob: (id) => statements.markSkipped.run(now(), id),
    failJob: (id, error) => statements.markFailed.run(now(), String(error).slice(0, 4000), id),
    cancelProcessingJob: (id, reason = 'Cancelled by user') => statements.markCancelled.run(now(), reason, id),
    requeueProcessingJob: (id, reason) => {
      const position = Number(statements.maxQueuePosition.get().position) + 1;
      return statements.requeueJob.run(position, reason, id);
    },
    removeQueuedJob: (id) => Number(statements.cancelQueued.run(now(), id).changes) === 1,
    clearQueue: () => Number(statements.clearQueued.run(now()).changes),
    reorderQueue: (jobIds) => reorderTransaction(jobIds),
    getHistory: (limit = 100) => statements.getHistory.all(Math.min(Math.max(Number(limit) || 100, 1), 500)),
    conversionState,
    getCachedMedia: (service) => statements.cachedMedia.all(service).map(publicCachedMedia),
    updateCachedMediaProbe: (service, filePath, probe) => Number(statements.updateCachedMediaProbe.run(
      probe.sizeBytes || 0,
      probe.durationSeconds || null,
      probe.width || null,
      probe.height || null,
      probe.width && probe.height ? `${probe.width}x${probe.height}` : null,
      probe.videoCodec || null,
      JSON.stringify(normalizeAudioLanguages(probe.audioLanguages)),
      now(),
      service,
      filePath
    ).changes),
    ping: () => Number(sqlite.prepare('SELECT 1 AS ok').get().ok) === 1,
    close: () => sqlite.close()
  });
}

module.exports = {
  BASELINE_STATS,
  createDatabase
};
