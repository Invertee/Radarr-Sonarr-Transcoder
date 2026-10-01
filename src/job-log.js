'use strict';

const path = require('node:path');

function jobLogPath(config, jobId) {
  if (!Number.isSafeInteger(Number(jobId)) || Number(jobId) < 1) {
    throw new Error('Invalid job ID');
  }
  return path.join(path.dirname(config.ffmpegLogPath), 'failed-jobs', 'job-' + Number(jobId) + '.log');
}

module.exports = { jobLogPath };
