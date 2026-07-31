'use strict';

const { mapServicePath } = require('./path-mapper');

class ArrConfigurationError extends Error {
  constructor(service) {
    super(`${service} is not configured. Set its URL and API key in /etc/transcode-manager.env.`);
    this.name = 'ArrConfigurationError';
    this.statusCode = 503;
  }
}

function parseRuntime(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }

  const parts = text.split(':').map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  return null;
}

function parseResolution(mediaInfo, quality) {
  const width = Number(mediaInfo?.width) || null;
  const height = Number(mediaInfo?.height) || null;
  if (width && height) {
    return { width, height, label: `${width}x${height}` };
  }

  const raw = String(mediaInfo?.resolution || '').trim();
  const match = raw.match(/(\d{3,5})\s*[xX]\s*(\d{3,5})/);
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]), label: `${match[1]}x${match[2]}` };
  }

  const qualityResolution = Number(quality?.quality?.resolution || quality?.resolution);
  if (qualityResolution) {
    return { width: null, height: qualityResolution, label: `${qualityResolution}p` };
  }

  return { width: null, height: null, label: 'Unknown' };
}

function episodeDisplayTitle(file, episodesByFileId) {
  const episodes = episodesByFileId.get(file.id) || [];
  if (episodes.length === 0) {
    return file.relativePath || file.path || `Episode file ${file.id}`;
  }

  return episodes
    .map((episode) => {
      const season = String(episode.seasonNumber ?? 0).padStart(2, '0');
      const number = String(episode.episodeNumber ?? 0).padStart(2, '0');
      return `S${season}E${number} - ${episode.title || 'Untitled'}`;
    })
    .join(' / ');
}

class ArrClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.tagCache = new Map();
  }

  serviceConfig(service) {
    return service === 'radarr' ? this.config.radarr : this.config.sonarr;
  }

  async request(service, apiPath, options = {}) {
    const serviceConfig = this.serviceConfig(service);
    if (!serviceConfig.url || !serviceConfig.apiKey) {
      throw new ArrConfigurationError(service);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.arrTimeoutMs);

    try {
      const response = await fetch(`${serviceConfig.url}${apiPath}`, {
        method: options.method || 'GET',
        headers: {
          'X-Api-Key': serviceConfig.apiKey,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      if (!response.ok) {
        const error = new Error(`${service} returned HTTP ${response.status}`);
        error.statusCode = response.status;
        error.details = body;
        throw error;
      }

      return body;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`${service} API request timed out after ${this.config.arrTimeoutMs}ms`);
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(service) {
    const started = Date.now();
    try {
      const status = await this.request(service, '/api/v3/system/status');
      return {
        service,
        configured: true,
        reachable: true,
        version: status?.version || null,
        responseMs: Date.now() - started
      };
    } catch (error) {
      return {
        service,
        configured: !(error instanceof ArrConfigurationError),
        reachable: false,
        error: error.message,
        responseMs: Date.now() - started
      };
    }
  }

  async getTagMap(service) {
    const cached = this.tagCache.get(service);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const tags = await this.request(service, '/api/v3/tag');
    const tagMap = new Map((Array.isArray(tags) ? tags : []).map((tag) => [Number(tag.id), String(tag.label || '').trim()]));
    this.tagCache.set(service, { value: tagMap, expiresAt: Date.now() + (5 * 60 * 1000) });
    return tagMap;
  }

  async resolveTagNames(service, rawTags) {
    const values = Array.isArray(rawTags) ? rawTags : [];
    const names = values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean);
    const ids = values.map(Number).filter(Number.isFinite);

    if (ids.length > 0) {
      try {
        const tagMap = await this.getTagMap(service);
        for (const id of ids) {
          const label = tagMap.get(id);
          if (label) {
            names.push(label);
          }
        }
      } catch (error) {
        this.logger.warn('Could not resolve Arr tag IDs; default profile may be used', {
          service,
          error: error.message
        });
      }
    }

    return [...new Set(names)];
  }

  async getSonarrSeries() {
    const series = await this.request('sonarr', '/api/v3/series');
    return (Array.isArray(series) ? series : []).map((item) => ({
      id: item.id,
      title: item.title,
      year: item.year || null,
      status: item.status || null,
      monitored: Boolean(item.monitored),
      sizeBytes: Number(item.statistics?.sizeOnDisk || 0),
      episodeFileCount: Number(item.statistics?.episodeFileCount || 0),
      tags: Array.isArray(item.tags) ? item.tags : []
    }));
  }

  async getSonarrFiles(seriesId) {
    const [files, episodes] = await Promise.all([
      this.request('sonarr', `/api/v3/episodefile?seriesId=${encodeURIComponent(seriesId)}`),
      this.request('sonarr', `/api/v3/episode?seriesId=${encodeURIComponent(seriesId)}`)
    ]);

    const episodesByFileId = new Map();
    for (const episode of Array.isArray(episodes) ? episodes : []) {
      if (!episode.episodeFileId) {
        continue;
      }
      const group = episodesByFileId.get(episode.episodeFileId) || [];
      group.push(episode);
      episodesByFileId.set(episode.episodeFileId, group);
    }

    return (Array.isArray(files) ? files : []).map((file) => {
      const resolution = parseResolution(file.mediaInfo, file.quality);
      return {
        service: 'sonarr',
        itemId: (episodesByFileId.get(file.id) || [])[0]?.id || null,
        seriesId: Number(seriesId),
        fileId: file.id,
        title: episodeDisplayTitle(file, episodesByFileId),
        relativePath: file.relativePath || '',
        path: mapServicePath('sonarr', file.path, this.config),
        sizeBytes: Number(file.size || 0),
        durationSeconds: parseRuntime(file.mediaInfo?.runTime),
        width: resolution.width,
        height: resolution.height,
        resolution: resolution.label,
        videoCodec: file.mediaInfo?.videoCodec || null,
        audioCodec: file.mediaInfo?.audioCodec || null,
        audioLanguages: file.mediaInfo?.audioLanguages || null,
        quality: file.quality?.quality?.name || null
      };
    });
  }

  async getRadarrMovies() {
    const movies = await this.request('radarr', '/api/v3/movie');
    return (Array.isArray(movies) ? movies : []).map((movie) => {
      const file = movie.movieFile || null;
      const resolution = parseResolution(file?.mediaInfo, file?.quality);
      return {
        service: 'radarr',
        itemId: movie.id,
        movieId: movie.id,
        fileId: file?.id || null,
        title: movie.title,
        year: movie.year || null,
        monitored: Boolean(movie.monitored),
        hasFile: Boolean(movie.hasFile && file),
        relativePath: file?.relativePath || '',
        path: file?.path ? mapServicePath('radarr', file.path, this.config) : '',
        sizeBytes: Number(file?.size || movie.sizeOnDisk || 0),
        durationSeconds: parseRuntime(file?.mediaInfo?.runTime) || (Number(movie.runtime) ? Number(movie.runtime) * 60 : null),
        width: resolution.width,
        height: resolution.height,
        resolution: resolution.label,
        videoCodec: file?.mediaInfo?.videoCodec || null,
        audioCodec: file?.mediaInfo?.audioCodec || null,
        audioLanguages: file?.mediaInfo?.audioLanguages || null,
        quality: file?.quality?.quality?.name || null,
        tags: Array.isArray(movie.tags) ? movie.tags : []
      };
    });
  }

  async rescanJob(job) {
    if (job.source_service === 'sonarr' && job.source_series_id) {
      await this.request('sonarr', '/api/v3/command', {
        method: 'POST',
        body: { name: 'RescanSeries', seriesId: job.source_series_id }
      });
      return;
    }

    if (job.source_service === 'radarr' && job.source_movie_id) {
      await this.request('radarr', '/api/v3/command', {
        method: 'POST',
        body: { name: 'RescanMovie', movieId: job.source_movie_id }
      });
    }
  }
}

module.exports = {
  ArrClient,
  ArrConfigurationError,
  parseResolution,
  parseRuntime
};
