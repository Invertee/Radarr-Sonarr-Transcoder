'use strict';

function inferService(payload, serviceHint) {
  if (serviceHint === 'sonarr' || serviceHint === 'radarr') {
    return serviceHint;
  }
  if (payload?.movie || payload?.movieFile) {
    return 'radarr';
  }
  return 'sonarr';
}

function getEpisodeLabel(payload) {
  const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
  if (episodes.length === 0) {
    return '';
  }

  return episodes
    .map((episode) => {
      const season = Number.isFinite(episode.seasonNumber) ? String(episode.seasonNumber).padStart(2, '0') : '';
      const number = Number.isFinite(episode.episodeNumber) ? String(episode.episodeNumber).padStart(2, '0') : '';
      return season && number ? `S${season}E${number}` : episode.title || '';
    })
    .filter(Boolean)
    .join(', ');
}

function extractTags(payload, service) {
  const owner = service === 'radarr' ? payload?.movie : payload?.series;
  const tags = [];

  for (const candidate of [owner?.tags, payload?.tags, payload?.remoteProfile?.tags]) {
    if (Array.isArray(candidate)) {
      tags.push(...candidate);
    }
  }

  return [...new Set(tags)];
}

function extractWebhookJob(payload, serviceHint) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Webhook payload must be a JSON object');
  }

  const service = inferService(payload, serviceHint);
  const eventType = String(payload.eventType || '').trim();
  const normalizedEventType = eventType.toLowerCase();

  if (normalizedEventType === 'test') {
    return { action: 'test', service, eventType };
  }

  if (!['download', 'upgrade'].includes(normalizedEventType)) {
    return { action: 'ignored', service, eventType };
  }

  const file = service === 'radarr' ? payload.movieFile : payload.episodeFile;
  const sourcePath = file?.path;
  if (!sourcePath) {
    throw new Error('Webhook did not contain movieFile.path or episodeFile.path');
  }

  const title = service === 'radarr'
    ? payload.movie?.title || file.relativePath || sourcePath
    : [payload.series?.title, getEpisodeLabel(payload)].filter(Boolean).join(' - ') || file.relativePath || sourcePath;

  const firstEpisode = Array.isArray(payload.episodes) ? payload.episodes[0] : null;

  return {
    action: 'queue',
    service,
    eventType,
    sourcePath,
    title,
    tags: extractTags(payload, service),
    sourceItemId: service === 'radarr' ? payload.movie?.id ?? null : firstEpisode?.id ?? null,
    sourceFileId: file?.id ?? null,
    sourceSeriesId: service === 'sonarr' ? payload.series?.id ?? null : null,
    sourceMovieId: service === 'radarr' ? payload.movie?.id ?? null : null
  };
}

module.exports = {
  extractWebhookJob,
  inferService
};
