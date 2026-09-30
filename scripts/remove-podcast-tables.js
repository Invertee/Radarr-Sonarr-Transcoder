'use strict';
// Optional, explicit cleanup only. Normal startup never deletes historical data.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { acquireInstanceLock } = require('../src/instance-lock');

async function removePodcastTables(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Pass an absolute database path');
  filename = fs.realpathSync(filename); // Fail rather than create a missing database.
  const release = acquireInstanceLock(path.join(path.dirname(filename), 'transcode-manager.pid'));
  let db;
  try {
    db = new DatabaseSync(filename);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    if (!tables.includes('jobs') || !tables.includes('conversion_records') || !tables.includes('app_stats')) throw new Error('Not a Transcode Manager database');
    if (!tables.includes('podcast_jobs') && !tables.includes('podcast_job_logs')) return { removed: false };
    const backupPath = `${filename}.before-podcast-removal-${Date.now()}.sqlite`;
    if (fs.existsSync(backupPath)) throw new Error('Backup destination already exists');
    await backup(db, backupPath);
    db.exec('BEGIN IMMEDIATE; DROP TABLE IF EXISTS podcast_job_logs; DROP TABLE IF EXISTS podcast_jobs; COMMIT;');
    return { removed: true, backupPath };
  } finally { db?.close(); release(); }
}
if (require.main === module) {
  const [flag, filename] = process.argv.slice(2);
  if (flag !== '--database' || !filename) { console.error('Stop the service, then run: node scripts/remove-podcast-tables.js --database /absolute/path/transcode-manager.sqlite'); process.exitCode = 1; }
  else removePodcastTables(filename).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { removePodcastTables };
