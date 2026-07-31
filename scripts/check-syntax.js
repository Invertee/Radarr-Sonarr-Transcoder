'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const directories = ['src', 'scripts', 'test', 'public'];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(candidate);
    } else if (entry.isFile() && candidate.endsWith('.js')) {
      files.push(candidate);
    }
  }
}

for (const directory of directories) {
  walk(path.join(root, directory));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
