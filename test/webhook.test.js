'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWebhookJob } = require('../src/webhook');

test('extracts a Radarr download webhook', () => {
  const result = extractWebhookJob({
    eventType: 'Download',
    movie: { id: 10, title: 'Example', tags: [3] },
    movieFile: { id: 20, path: '/movies/Example/movie.mkv' }
  });

  assert.equal(result.action, 'queue');
  assert.equal(result.service, 'radarr');
  assert.equal(result.sourceMovieId, 10);
  assert.equal(result.sourceFileId, 20);
  assert.deepEqual(result.tags, [3]);
});

test('extracts a Sonarr episode label and path', () => {
  const result = extractWebhookJob({
    eventType: 'Upgrade',
    series: { id: 7, title: 'Series', tags: ['medium'] },
    episodes: [{ id: 8, seasonNumber: 1, episodeNumber: 2, title: 'Episode' }],
    episodeFile: { id: 9, path: '/tv/Series/S01E02.mkv' }
  }, 'sonarr');

  assert.equal(result.title, 'Series - S01E02');
  assert.equal(result.sourceSeriesId, 7);
  assert.equal(result.sourceItemId, 8);
});

test('ignores non-download webhook events', () => {
  assert.equal(extractWebhookJob({ eventType: 'Rename' }, 'sonarr').action, 'ignored');
});
