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

function getProfile(key, fallback = 'medium', customProfiles = []) {
  const normalized = normalizeTag(key);
  return (Object.hasOwn(PROFILES, normalized) ? PROFILES[normalized] : null)
    || customProfiles.find((profile) => profile.key === normalized)
    || (Object.hasOwn(PROFILES, fallback) ? PROFILES[fallback] : null)
    || customProfiles.find((profile) => profile.key === fallback) || PROFILES.medium;
}

function listProfiles({ includeSkip = true, customProfiles = [] } = {}) {
  return [...Object.values(PROFILES), ...customProfiles].filter((profile) => includeSkip || profile.key !== 'skip');
}

function validateCustomProfile(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const qp = input?.qp;
  const maxWidth = input?.maxWidth;
  if (!name || name.length > 60) {
    throw new Error('Profile name must be between 1 and 60 characters');
  }
  if (!Number.isInteger(qp) || qp < 16 || qp > 36) {
    throw new Error('Quality must be an integer QP between 16 and 36');
  }
  if (![854, 1280, 1920, 2560, 3840].includes(maxWidth)) {
    throw new Error('Maximum resolution must be 480p, 720p, 1080p, 1440p or 2160p');
  }
  return { name, qp, maxWidth };
}

function selectProfileFromTags(tags, fallback = 'medium', customProfiles = []) {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : []).map(normalizeTag).filter(Boolean));

  for (const profileKey of TAG_PRIORITY) {
    if (profileKey === 'lowres') {
      const custom = customProfiles.find((profile) => normalizedTags.has(profile.key)
        || normalizedTags.has(`transcode:${profile.key}`) || normalizedTags.has(`transcode-${profile.key}`));
      if (custom) return custom;
    }
    for (const alias of TAG_ALIASES[profileKey]) {
      if (normalizedTags.has(alias)) {
        return PROFILES[profileKey];
      }
    }
  }

  return getProfile(fallback, 'medium', customProfiles);
}

module.exports = {
  PROFILES,
  getProfile,
  listProfiles,
  normalizeTag,
  validateCustomProfile,
  selectProfileFromTags
};
