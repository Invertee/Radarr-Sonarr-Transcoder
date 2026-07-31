'use strict';

function normalizePath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.replace(/\/+$/, '');
}

function mapRemotePath(inputPath, pathFrom, pathTo) {
  if (!inputPath) {
    return '';
  }

  const from = normalizePath(pathFrom);
  const to = normalizePath(pathTo);
  const input = normalizePath(inputPath);

  if (!from || !to) {
    return input;
  }

  const caseInsensitive = /^[a-z]:\//i.test(from) || from.startsWith('//');
  const comparisonInput = caseInsensitive ? input.toLowerCase() : input;
  const comparisonFrom = caseInsensitive ? from.toLowerCase() : from;
  const childPrefix = comparisonFrom === '/' ? '/' : `${comparisonFrom}/`;
  const isExact = comparisonInput === comparisonFrom;
  const isChild = comparisonInput.startsWith(childPrefix);
  if (!isExact && !isChild) {
    return input;
  }

  const suffixStart = from === '/' ? 1 : from.length;
  const suffix = input.slice(suffixStart).replace(/^\//, '');
  return suffix ? `${to}/${suffix}` : to;
}

function mapServicePath(service, inputPath, config) {
  const serviceConfig = service === 'radarr' ? config.radarr : config.sonarr;
  return mapRemotePath(inputPath, serviceConfig.pathFrom, serviceConfig.pathTo);
}

module.exports = {
  mapRemotePath,
  mapServicePath
};
