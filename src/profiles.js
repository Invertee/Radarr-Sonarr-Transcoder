'use strict';

const PROFILES = Object.freeze({
  high: Object.freeze({
    key: 'high',
    name: 'High (1080p QP 22)',
    qp: 22,
    maxWidth: 1920
  }),
  medium: Object.freeze({
    key: 'medium',
    name: 'Medium (1080p QP 24)',
    qp: 24,
    maxWidth: 1920
  }),
  low: Object.freeze({
    key: 'low',
    name: 'Low (1080p QP 30)',
    qp: 30,
    maxWidth: 1920
  }),
  lowres: Object.freeze({
    key: 'lowres',
    name: 'LowRes (720p QP 26)',
    qp: 26,
    maxWidth: 1280
  }),
  skip: Object.freeze({
    key: 'skip',
    name: 'No Convert',
    qp: null,
    maxWidth: null
  })
});

const TAG_ALIASES = Object.freeze({
  skip: new Set(['skip', 'noconvert', 'no-convert', 'transcode-skip', 'transcode:skip']),
  lowres: new Set(['lowres', '720p', 'transcode-lowres', 'transcode:lowres']),
  low: new Set(['low', 'transcode-low', 'transcode:low']),
  medium: new Set(['medium', 'transcode-medium', 'transcode:medium']),
  high: new Set(['high', 'transcode-high', 'transcode:high'])
});

const TAG_PRIORITY = Object.freeze(['skip', 'lowres', 'low', 'medium', 'high']);

function normalizeTag(tag) {
  return String(tag ?? '').trim().toLowerCase();
}

function getProfile(key, fallback = 'medium') {
  const normalized = normalizeTag(key);
  return PROFILES[normalized] || PROFILES[fallback] || PROFILES.medium;
}

function listProfiles({ includeSkip = true } = {}) {
  return Object.values(PROFILES).filter((profile) => includeSkip || profile.key !== 'skip');
}

function selectProfileFromTags(tags, fallback = 'medium') {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : []).map(normalizeTag).filter(Boolean));

  for (const profileKey of TAG_PRIORITY) {
    for (const alias of TAG_ALIASES[profileKey]) {
      if (normalizedTags.has(alias)) {
        return PROFILES[profileKey];
      }
    }
  }

  return getProfile(fallback);
}

module.exports = {
  PROFILES,
  getProfile,
  listProfiles,
  normalizeTag,
  selectProfileFromTags
};
