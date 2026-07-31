'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapRemotePath } = require('../src/path-mapper');

test('maps a remote mount prefix to the local VM mount', () => {
  assert.equal(
    mapRemotePath('/downloads/tv/Show/episode.mkv', '/downloads', '/mnt/media'),
    '/mnt/media/tv/Show/episode.mkv'
  );
});

test('does not replace partial path-prefix matches', () => {
  assert.equal(
    mapRemotePath('/downloads-old/file.mkv', '/downloads', '/mnt/media'),
    '/downloads-old/file.mkv'
  );
});

test('normalises Windows separators and compares drive paths case-insensitively', () => {
  assert.equal(
    mapRemotePath('d:\\Media\\Movies\\Film.mkv', 'D:\\Media', '/mnt/media'),
    '/mnt/media/Movies/Film.mkv'
  );
});

test('can map a root path without collapsing it to an empty prefix', () => {
  assert.equal(mapRemotePath('/tv/show/file.mkv', '/', '/mnt/media'), '/mnt/media/tv/show/file.mkv');
});
