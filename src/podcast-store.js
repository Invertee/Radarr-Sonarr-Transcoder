'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

function createPodcastStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS podcast_jobs (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, error TEXT, result_json TEXT, expires_at TEXT);
    CREATE TABLE IF NOT EXISTS podcast_job_logs (
      id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, created_at TEXT NOT NULL,
      level TEXT NOT NULL, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS podcast_job_log_idx ON podcast_job_logs(job_id,id);
    UPDATE podcast_jobs SET status='queued',stage='recovered',progress=0
      WHERE status='processing';`);
  function get(id) {
    const row = db.prepare('SELECT * FROM podcast_jobs WHERE id=?').get(id);
    if (!row) return null;
    return { id: row.id, requestKey: row.request_key, request: JSON.parse(row.request_json),
      status: row.status, stage: row.stage, progress: row.progress, createdAt: row.created_at,
      startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
      expiresAt: row.expires_at, result: row.result_json ? JSON.parse(row.result_json) : null };
  }
  return {
    get,
    enqueue(request) {
      const existing = db.prepare('SELECT id,request_json FROM podcast_jobs WHERE request_key=?').get(request.requestKey);
      if (existing) {
        if (existing.request_json !== JSON.stringify(request)) {
          const error = new Error('requestKey already used for different input'); error.statusCode = 409; throw error;
        }
        return { job: get(existing.id), deduplicated: true };
      }
      const id = randomUUID();
      db.prepare('INSERT INTO podcast_jobs(id,request_key,request_json,created_at) VALUES(?,?,?,?)')
        .run(id, request.requestKey, JSON.stringify(request), new Date().toISOString());
      return { job: get(id), deduplicated: false };
    },
    list() {
      return db.prepare('SELECT id FROM podcast_jobs ORDER BY created_at DESC LIMIT 200').all()
        .map(({ id }) => { const { result, ...job } = get(id); return { ...job, segmentCount: result?.segments?.length ?? 0 }; });
    },
    claim() {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare("SELECT id FROM podcast_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
        if (row) db.prepare("UPDATE podcast_jobs SET status='processing',started_at=?,error=NULL WHERE id=?")
          .run(new Date().toISOString(), row.id);
        db.exec('COMMIT'); return row ? get(row.id) : null;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    progress(id, stage, progress) { db.prepare('UPDATE podcast_jobs SET stage=?,progress=? WHERE id=?').run(stage, progress, id); },
    finish(id, result) {
      const now = new Date();
      db.prepare("UPDATE podcast_jobs SET status='completed',stage='completed',progress=100,result_json=?,finished_at=?,expires_at=? WHERE id=?")
        .run(JSON.stringify(result), now.toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString(), id);
    },
    fail(id, message) { db.prepare("UPDATE podcast_jobs SET status='failed',stage='failed',error=?,finished_at=? WHERE id=?")
      .run(message.slice(0, 2000), new Date().toISOString(), id); },
    requeue(id) { db.prepare("UPDATE podcast_jobs SET status='queued',stage='queued',progress=0 WHERE id=? AND status='processing'").run(id); },
    log(id, level, message) { db.prepare('INSERT INTO podcast_job_logs(job_id,created_at,level,message) VALUES(?,?,?,?)')
      .run(id, new Date().toISOString(), level, message.slice(0, 2000)); },
    logs(id) { return db.prepare('SELECT created_at AS createdAt,level,message FROM podcast_job_logs WHERE job_id=? ORDER BY id DESC LIMIT 300').all(id).reverse(); },
    prune() {
      const now = new Date().toISOString();
      for (const row of db.prepare('SELECT id,result_json FROM podcast_jobs WHERE expires_at<=? AND result_json IS NOT NULL').all(now)) {
        const result = JSON.parse(row.result_json); result.fragments = []; result.transcriptExpired = true;
        db.prepare('UPDATE podcast_jobs SET result_json=?,expires_at=NULL WHERE id=?').run(JSON.stringify(result), row.id);
      }
      db.prepare('DELETE FROM podcast_job_logs WHERE created_at<?').run(new Date(Date.now() - 7 * 86400000).toISOString());
    },
    close() { db.close(); }
  };
}

module.exports = { createPodcastStore };
