'use strict';

// Shared by the browser and worker so previews use the same assumptions.
((root) => {
  function audioBitsPerSecond(value = '192k') {
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
    return match ? Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] || 1) : 192000;
  }

  function estimateOutputSize(metadata, profile, audioBitrate = '192k') {
    const duration = Number(metadata?.durationSeconds);
    const width = Number(metadata?.width);
    const height = Number(metadata?.height);
    if (!profile || profile.key === 'skip' || !Number.isFinite(duration) || duration <= 0
      || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
    const scale = Math.min(1, profile.maxWidth / width);
    // A broad HEVC QP heuristic; scene complexity and source quality vary widely.
    const videoBitrate = 3000000 * (width * height * scale ** 2 / (1920 * 1080))
      * 2 ** ((24 - profile.qp) / 6);
    const audioBitrateTotal = audioBitsPerSecond(audioBitrate) * Math.max(0, Number(metadata.audioStreams ?? 1) || 0);
    const bytes = (videoFactor) => Math.round((videoBitrate * videoFactor + audioBitrateTotal) * duration / 8 * 1.02);
    return { estimatedOutputBytes: bytes(1), lowerBytes: bytes(0.5), upperBytes: bytes(1.8), method: 'rough' };
  }

  function estimateFromProgress(outputBytes, outputTimeSeconds, durationSeconds) {
    if (![outputBytes, outputTimeSeconds, durationSeconds].every(Number.isFinite)
      || outputBytes <= 0 || durationSeconds <= 0 || outputTimeSeconds < Math.max(10, durationSeconds * 0.01)) return null;
    return {
      estimatedOutputBytes: Math.round(outputBytes * Math.max(1, durationSeconds / outputTimeSeconds)),
      method: 'encoding'
    };
  }

  const api = { audioBitsPerSecond, estimateOutputSize, estimateFromProgress };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversionEstimates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
