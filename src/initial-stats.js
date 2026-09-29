'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function toDatabaseStats({ savedGiB, efficiencyPercent, filesProcessed }) {
  const totalSavedBytes = Math.round(Number(savedGiB) * (1024 ** 3));
  const efficiency = Number(efficiencyPercent);
  const processed = Number(filesProcessed);

  if (!Number.isFinite(totalSavedBytes) || totalSavedBytes < 0) {
    throw new Error('STARTING_STATS_SAVED_GIB must be a non-negative number');
  }
  if (!Number.isFinite(efficiency) || efficiency < 0 || efficiency > 100) {
    throw new Error('STARTING_STATS_EFFICIENCY_PERCENT must be between 0 and 100');
  }
  if (!Number.isSafeInteger(processed) || processed < 0) {
    throw new Error('STARTING_STATS_FILES_PROCESSED must be a non-negative integer');
  }
  if ((totalSavedBytes === 0) !== (efficiency === 0)) {
    throw new Error('Starting saved space and efficiency must both be zero or both be greater than zero');
  }

  const totalOriginalBytes = efficiency > 0
    ? Math.round(totalSavedBytes / (efficiency / 100))
    : 0;

  return {
    totalOriginalBytes,
    totalSavedBytes,
    filesProcessed: processed
  };
}

function seedInitialStatsDatabase(databasePath, configuredStats) {
  if (fs.existsSync(databasePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const stats = toDatabaseStats(configuredStats);
  const timestamp = new Date().toISOString();
  const sqlite = new DatabaseSync(databasePath);

  try {
    sqlite.exec(`
      CREATE TABLE app_stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_original_bytes INTEGER NOT NULL,
        total_saved_bytes INTEGER NOT NULL,
        files_processed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite.prepare(`
      INSERT INTO app_stats (
        id, total_original_bytes, total_saved_bytes, files_processed, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      stats.totalOriginalBytes,
      stats.totalSavedBytes,
      stats.filesProcessed,
      timestamp,
      timestamp
    );
  } finally {
    sqlite.close();
  }

  return true;
}

module.exports = {
  seedInitialStatsDatabase,
  toDatabaseStats
};
