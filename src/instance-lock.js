'use strict';

const fs = require('node:fs');
const path = require('node:path');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireInstanceLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    const currentPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (Number.isInteger(currentPid) && processExists(currentPid)) {
      throw new Error(`Another Transcode Manager process is already running with PID ${currentPid}`);
    }
    fs.rmSync(lockPath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error.message.startsWith('Another Transcode Manager')) {
        throw error;
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  const descriptor = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(descriptor, String(process.pid));
  fs.closeSync(descriptor);

  return () => fs.rmSync(lockPath, { force: true });
}

module.exports = {
  acquireInstanceLock
};
