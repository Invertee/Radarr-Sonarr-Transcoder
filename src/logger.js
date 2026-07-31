'use strict';

const fs = require('node:fs');
const path = require('node:path');

function serializeMeta(meta) {
  if (meta === undefined || meta === null) {
    return '';
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

function createLogger({ logPath, maxBytes }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function rotateIfRequired() {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < maxBytes) {
        return;
      }
      const rotatedPath = `${logPath}.1`;
      fs.rmSync(rotatedPath, { force: true });
      fs.renameSync(logPath, rotatedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Log rotation failed:', error.message);
      }
    }
  }

  function write(level, message, meta) {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${level.toUpperCase()} ${message}${serializeMeta(meta)}\n`;

    rotateIfRequired();
    fs.appendFileSync(logPath, line, 'utf8');

    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(line.trimEnd());
  }

  function tail(limit = 200) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).slice(-limit);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  return Object.freeze({
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    tail
  });
}

module.exports = {
  createLogger
};
