'use strict';

const state = {
  profiles: [],
  queue: [],
  series: [],
  sonarrFiles: [],
  movies: [],
  history: [],
  loaded: new Set(),
  currentSeriesId: null,
  statusRefreshInFlight: false,
  connectionRefreshInFlight: false
};

const elements = {};
let toastTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(requestPath, options = {}) {
  const response = await fetch(requestPath, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(body?.error || body || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3500);
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') {
    return '-';
  }
  const value = Number(bytes);
  if (!Number.isFinite(value)) {
    return '-';
  }
  const absolute = Math.abs(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let display = absolute;
  while (display >= 1024 && unitIndex < units.length - 1) {
    display /= 1024;
    unitIndex += 1;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${display.toFixed(unitIndex >= 3 ? 2 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  return [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatAudio(item) {
  const languages = Array.isArray(item.audioLanguages)
    ? item.audioLanguages
    : String(item.audioLanguages || '').split(/[,/]/).map((value) => value.trim()).filter(Boolean);
  const details = [];
  if (languages.length > 0) {
    details.push(languages.join(', '));
  }
  if (item.audioCodec) {
    details.push(item.audioCodec);
  }
  if (Number(item.audioStreams) > 0) {
    details.push(`${Number(item.audioStreams)} stream${Number(item.audioStreams) === 1 ? '' : 's'}`);
  }
  return details.length > 0 ? details.join(' · ') : 'Unknown';
}

function searchMatches(item, query, fields) {
  if (!query) {
    return true;
  }
  const haystack = fields.map((field) => item?.[field]).filter((value) => value !== null && value !== undefined).join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function profileOptions(selected = 'medium') {
  return state.profiles
    .filter((profile) => profile.key !== 'skip')
    .map((profile) => `<option value="${escapeHtml(profile.key)}" ${profile.key === selected ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`)
    .join('');
}

function statusPill(status, label = status) {
  const safeClass = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `<span class="status-pill status-pill--${safeClass}">${escapeHtml(label || 'Unknown')}</span>`;
}

async function loadProfiles() {
  state.profiles = await api('/api/profiles');
  elements.manualProfile.innerHTML = profileOptions('medium');
}

async function refreshStatus() {
  if (state.statusRefreshInFlight) {
    return;
  }
  state.statusRefreshInFlight = true;
  try {
    const data = await api('/api/status?compact=1');
    const current = data.current || {};
    const stats = data.stats || {};
    const processing = current.status === 'Processing' || current.status === 'Skipping';
    const progress = Number(current.progress ?? data.progress ?? 0);

    elements.appVersion.textContent = data.version || '2.0.0';
    elements.statusText.textContent = current.status || 'Idle';
    elements.statusText.style.color = processing ? 'var(--primary)' : 'var(--success)';
    elements.progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;
    elements.currentFile.textContent = processing ? (current.file || 'Active job') : 'No active job';
    elements.currentMetrics.textContent = processing
      ? `${progress.toFixed(1)}%${current.fps ? ` | ${current.fps} fps` : ''}${current.speed ? ` | ${current.speed}` : ''}`
      : '0%';
    elements.cancelActiveButton.disabled = !processing;

    elements.statSaved.textContent = `${Number(stats.savedGiB ?? stats.saved_gb ?? 0).toFixed(2)} GB`;
    elements.statEfficiency.textContent = `${Number(stats.efficiencyPercent ?? stats.percent ?? 0).toFixed(1)}%`;
    elements.statProcessed.textContent = String(stats.filesProcessed ?? stats.count ?? 0);

    state.queue = Array.isArray(data.queue) ? data.queue : [];
    elements.queueCount.textContent = String(state.queue.length);
    elements.clearQueueButton.disabled = state.queue.length === 0;
    renderQueue();
  } catch (error) {
    elements.statusText.textContent = 'Unavailable';
    elements.statusText.style.color = 'var(--danger)';
    elements.currentFile.textContent = error.message;
  } finally {
    state.statusRefreshInFlight = false;
  }
}

function renderQueue() {
  if (state.queue.length === 0) {
    elements.queueBody.innerHTML = '<tr><td colspan="6" class="empty-cell">The queue is empty.</td></tr>';
    return;
  }

  elements.queueBody.innerHTML = state.queue.map((job, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>
        <span class="table-title">${escapeHtml(job.title || job.path.split('/').pop())}</span>
        <span class="path-text" title="${escapeHtml(job.path)}">${escapeHtml(job.path)}</span>
      </td>
      <td>${escapeHtml(job.profileKey)}</td>
      <td>${escapeHtml(job.sourceService || 'manual')}</td>
      <td>${escapeHtml(formatDate(job.createdAt))}</td>
      <td>
        <div class="inline-actions">
          <button class="button button--icon button--outline" type="button" data-action="queue-up" data-id="${job.id}" ${index === 0 ? 'disabled' : ''} aria-label="Move job up">↑</button>
          <button class="button button--icon button--outline" type="button" data-action="queue-down" data-id="${job.id}" ${index === state.queue.length - 1 ? 'disabled' : ''} aria-label="Move job down">↓</button>
          <button class="button button--small button--danger button--outline" type="button" data-action="queue-remove" data-id="${job.id}">Remove</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function moveQueueJob(id, direction) {
  const index = state.queue.findIndex((job) => Number(job.id) === Number(id));
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.queue.length) {
    return;
  }
  const ids = state.queue.map((job) => Number(job.id));
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await api('/api/queue/reorder', { method: 'POST', body: JSON.stringify({ jobIds: ids }) });
  await refreshStatus();
}

async function removeQueueJob(id) {
  await api(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  showToast('Job removed from the queue.');
  await refreshStatus();
}

async function refreshConnections() {
  if (state.connectionRefreshInFlight) {
    return;
  }
  state.connectionRefreshInFlight = true;
  setConnectionBadge(elements.sonarrConnection, 'Sonarr', null);
  setConnectionBadge(elements.radarrConnection, 'Radarr', null);
  try {
    const data = await api('/api/connections');
    setConnectionBadge(elements.sonarrConnection, 'Sonarr', data.sonarr);
    setConnectionBadge(elements.radarrConnection, 'Radarr', data.radarr);
  } catch (error) {
    setConnectionBadge(elements.sonarrConnection, 'Sonarr', { reachable: false, error: error.message });
    setConnectionBadge(elements.radarrConnection, 'Radarr', { reachable: false, error: error.message });
  } finally {
    state.connectionRefreshInFlight = false;
  }
}

function setConnectionBadge(element, name, result) {
  element.classList.remove('is-ok', 'is-error');
  element.title = '';
  if (!result) {
    element.textContent = `${name}: checking`;
    return;
  }
  if (result.reachable) {
    element.classList.add('is-ok');
    element.textContent = `${name}: connected${result.version ? ` (${result.version})` : ''}`;
  } else {
    element.classList.add('is-error');
    element.textContent = `${name}: ${result.configured === false ? 'not configured' : 'unavailable'}`;
    element.title = result.error || '';
  }
}

async function loadSeries(force = false) {
  if (state.loaded.has('series') && !force) {
    renderSeries();
    return;
  }
  elements.seriesBody.innerHTML = '<tr><td colspan="4" class="empty-cell">Loading Sonarr series...</td></tr>';
  try {
    state.series = await api('/api/media/sonarr/series');
    state.loaded.add('series');
    renderSeries();
  } catch (error) {
    elements.seriesBody.innerHTML = `<tr><td colspan="4" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderSeries() {
  const filtered = state.series.filter((series) => searchMatches(series, elements.seriesSearch.value.trim(), ['title', 'year', 'status']));
  if (filtered.length === 0) {
    elements.seriesBody.innerHTML = `<tr><td colspan="4" class="empty-cell">${state.series.length ? 'No shows match the filter.' : 'No Sonarr series were returned.'}</td></tr>`;
    return;
  }
  elements.seriesBody.innerHTML = filtered.map((series) => `
    <tr>
      <td><span class="table-title">${escapeHtml(series.title)}</span>${series.year ? ` <span class="path-text">${escapeHtml(series.year)}</span>` : ''}</td>
      <td>${escapeHtml(series.episodeFileCount)}</td>
      <td>${escapeHtml(formatBytes(series.sizeBytes))}</td>
      <td><button class="button button--small button--primary" type="button" data-action="browse-series" data-id="${series.id}">Browse</button></td>
    </tr>
  `).join('');
}

async function loadEpisodes(seriesId) {
  state.currentSeriesId = Number(seriesId);
  const series = state.series.find((item) => Number(item.id) === Number(seriesId));
  elements.episodeHeading.textContent = series ? series.title : 'Series files';
  elements.episodeSummary.textContent = 'Loading...';
  elements.episodesBody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading episode files...</td></tr>';
  try {
    state.sonarrFiles = await api(`/api/media/sonarr/series/${encodeURIComponent(seriesId)}/files`);
    renderSonarrFiles();
  } catch (error) {
    elements.episodeSummary.textContent = '';
    elements.episodesBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderSonarrFiles() {
  const query = elements.episodeSearch.value.trim();
  const filtered = state.sonarrFiles.filter((file) => searchMatches(file, query, [
    'title', 'relativePath', 'path', 'resolution', 'videoCodec', 'audioCodec', 'audioLanguages', 'quality'
  ]));
  elements.episodeSummary.textContent = query
    ? `${filtered.length} of ${state.sonarrFiles.length} file(s)`
    : `${state.sonarrFiles.length} file(s)`;
  if (filtered.length === 0) {
    elements.episodesBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${state.sonarrFiles.length ? 'No files match the filter.' : 'No episode files were returned.'}</td></tr>`;
    return;
  }
  elements.episodesBody.innerHTML = filtered.map((file) => {
    const index = state.sonarrFiles.indexOf(file);
    return `
      <tr>
        <td><span class="table-title">${escapeHtml(file.title)}</span><span class="path-text" title="${escapeHtml(file.path)}">${escapeHtml(file.relativePath || file.path)}</span></td>
        <td>${escapeHtml(formatBytes(file.sizeBytes))}</td>
        <td>${escapeHtml(formatDuration(file.durationSeconds))}</td>
        <td>${escapeHtml(file.resolution || 'Unknown')}</td>
        <td>${escapeHtml(formatAudio(file))}</td>
        <td>${mediaState(file)}</td>
        <td><select class="profile-select" data-profile-kind="sonarr" data-index="${index}">${profileOptions('medium')}</select></td>
        <td><div class="inline-actions"><button class="button button--small button--outline" type="button" data-action="probe-sonarr" data-index="${index}" ${!file.path ? 'disabled' : ''}>Probe</button><button class="button button--small button--primary" type="button" data-action="queue-sonarr" data-index="${index}" ${!file.path || file.queueStatus ? 'disabled' : ''}>${file.queueStatus ? escapeHtml(file.queueStatus) : 'Queue'}</button></div></td>
      </tr>
    `;
  }).join('');
}

function mediaState(item) {
  if (item.queueStatus) {
    return statusPill(item.queueStatus, item.queueStatus);
  }
  if (item.converted) {
    const saved = Number(item.conversion?.savedBytes);
    let label = 'Converted';
    if (Number.isFinite(saved) && saved > 0) {
      label = `Converted (${formatBytes(saved)} saved)`;
    } else if (Number.isFinite(saved) && saved < 0) {
      label = `Converted (grew ${formatBytes(Math.abs(saved))})`;
    }
    return statusPill('converted', label);
  }
  return statusPill('unknown', 'Not tracked');
}

async function loadMovies(force = false) {
  if (state.loaded.has('movies') && !force) {
    renderMovies();
    return;
  }
  elements.moviesBody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading Radarr movies...</td></tr>';
  try {
    state.movies = await api('/api/media/radarr/movies');
    state.loaded.add('movies');
    renderMovies();
  } catch (error) {
    elements.moviesBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderMovies() {
  const filtered = state.movies.filter((movie) => searchMatches(movie, elements.movieSearch.value.trim(), [
    'title', 'year', 'relativePath', 'path', 'resolution', 'videoCodec', 'audioCodec', 'audioLanguages', 'quality'
  ]));
  if (filtered.length === 0) {
    elements.moviesBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${state.movies.length ? 'No movies match the filter.' : 'No Radarr movies were returned.'}</td></tr>`;
    return;
  }
  elements.moviesBody.innerHTML = filtered.map((movie) => {
    const index = state.movies.indexOf(movie);
    return `
      <tr>
        <td><span class="table-title">${escapeHtml(movie.title)}${movie.year ? ` (${escapeHtml(movie.year)})` : ''}</span><span class="path-text" title="${escapeHtml(movie.path)}">${escapeHtml(movie.relativePath || (movie.hasFile ? movie.path : 'No file'))}</span></td>
        <td>${movie.hasFile ? escapeHtml(formatBytes(movie.sizeBytes)) : '-'}</td>
        <td>${movie.hasFile ? escapeHtml(formatDuration(movie.durationSeconds)) : '-'}</td>
        <td>${movie.hasFile ? escapeHtml(movie.resolution || 'Unknown') : '-'}</td>
        <td>${movie.hasFile ? escapeHtml(formatAudio(movie)) : '-'}</td>
        <td>${movie.hasFile ? mediaState(movie) : statusPill('unknown', 'No file')}</td>
        <td><select class="profile-select" data-profile-kind="radarr" data-index="${index}" ${!movie.hasFile ? 'disabled' : ''}>${profileOptions('medium')}</select></td>
        <td><div class="inline-actions"><button class="button button--small button--outline" type="button" data-action="probe-radarr" data-index="${index}" ${!movie.hasFile || !movie.path ? 'disabled' : ''}>Probe</button><button class="button button--small button--primary" type="button" data-action="queue-radarr" data-index="${index}" ${!movie.hasFile || !movie.path || movie.queueStatus ? 'disabled' : ''}>${movie.queueStatus ? escapeHtml(movie.queueStatus) : 'Queue'}</button></div></td>
      </tr>
    `;
  }).join('');
}

async function probeMedia(item) {
  const probe = await api('/api/media/probe', {
    method: 'POST',
    body: JSON.stringify({ service: item.service, path: item.path })
  });
  Object.assign(item, probe, {
    resolution: probe.resolution || (probe.width && probe.height ? `${probe.width}x${probe.height}` : 'Unknown')
  });
  showToast(`Probed ${item.title}: ${item.resolution}, ${formatDuration(item.durationSeconds)}, ${formatAudio(item)}.`);
}

async function queueMedia(item, profileKey) {
  const body = {
    path: item.path,
    title: item.title,
    profileKey,
    sourceService: item.service,
    sourceItemId: item.itemId,
    sourceFileId: item.fileId,
    sourceSeriesId: item.seriesId,
    sourceMovieId: item.movieId,
    requestedBy: 'browser'
  };
  const result = await api('/api/queue', { method: 'POST', body: JSON.stringify(body) });
  showToast(result.deduplicated ? 'This file is already queued.' : 'File added to the queue.');
  await refreshStatus();
}

async function loadHistory() {
  elements.historyBody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading history...</td></tr>';
  try {
    state.history = await api('/api/history?limit=250');
    renderHistory();
  } catch (error) {
    elements.historyBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderHistory() {
  const filtered = state.history.filter((job) => searchMatches(job, elements.historySearch.value.trim(), [
    'title', 'path', 'status', 'profileKey', 'sourceService', 'error'
  ]));
  if (filtered.length === 0) {
    elements.historyBody.innerHTML = `<tr><td colspan="8" class="empty-cell">${state.history.length ? 'No history entries match the filter.' : 'No job history is available.'}</td></tr>`;
    return;
  }
  elements.historyBody.innerHTML = filtered.map((job) => `
    <tr>
      <td>${escapeHtml(formatDate(job.finishedAt || job.createdAt))}</td>
      <td><span class="table-title">${escapeHtml(job.title)}</span><span class="path-text" title="${escapeHtml(job.path)}">${escapeHtml(job.path)}</span></td>
      <td>${statusPill(job.status)}</td>
      <td>${escapeHtml(job.profileKey)}</td>
      <td>${escapeHtml(formatBytes(job.originalBytes))}</td>
      <td>${escapeHtml(formatBytes(job.outputBytes))}</td>
      <td>${job.savedBytes === null ? '-' : escapeHtml(formatBytes(job.savedBytes))}</td>
      <td><span class="path-text" title="${escapeHtml(job.error || '')}">${escapeHtml(job.error || `${job.width || '-'}x${job.height || '-'}, ${job.audioStreams ?? '-'} audio stream(s)`)}</span></td>
    </tr>
  `).join('');
}

async function loadLogs() {
  elements.logWindow.textContent = 'Loading logs...';
  try {
    const data = await api('/api/logs?limit=500');
    elements.logWindow.textContent = data.lines.length ? data.lines.join('\n') : 'No application log entries yet.';
    elements.logWindow.scrollTop = elements.logWindow.scrollHeight;
  } catch (error) {
    elements.logWindow.textContent = error.message;
  }
}

async function activatePanel(panelId) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === panelId));

  if (panelId === 'tvPanel') {
    await loadSeries();
  } else if (panelId === 'moviesPanel') {
    await loadMovies();
  } else if (panelId === 'historyPanel') {
    await loadHistory();
  } else if (panelId === 'logsPanel') {
    await loadLogs();
  }
}

async function handleAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  button.disabled = true;
  try {
    const action = button.dataset.action;
    if (action === 'queue-up') {
      await moveQueueJob(button.dataset.id, -1);
    } else if (action === 'queue-down') {
      await moveQueueJob(button.dataset.id, 1);
    } else if (action === 'queue-remove') {
      await removeQueueJob(button.dataset.id);
    } else if (action === 'browse-series') {
      await loadEpisodes(button.dataset.id);
    } else if (action === 'probe-sonarr') {
      const index = Number(button.dataset.index);
      await probeMedia(state.sonarrFiles[index]);
      renderSonarrFiles();
    } else if (action === 'queue-sonarr') {
      const index = Number(button.dataset.index);
      const selector = document.querySelector(`[data-profile-kind="sonarr"][data-index="${index}"]`);
      await queueMedia(state.sonarrFiles[index], selector.value);
      await loadEpisodes(state.currentSeriesId);
    } else if (action === 'probe-radarr') {
      const index = Number(button.dataset.index);
      await probeMedia(state.movies[index]);
      renderMovies();
    } else if (action === 'queue-radarr') {
      const index = Number(button.dataset.index);
      const selector = document.querySelector(`[data-profile-kind="radarr"][data-index="${index}"]`);
      await queueMedia(state.movies[index], selector.value);
      state.loaded.delete('movies');
      await loadMovies(true);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
    }
  }
}

function cacheElements() {
  for (const id of [
    'statusText', 'progressBar', 'currentFile', 'currentMetrics', 'statSaved', 'statEfficiency',
    'statProcessed', 'clearCacheButton', 'sonarrConnection', 'radarrConnection',
    'refreshConnectionsButton', 'appVersion', 'queueCount', 'cancelActiveButton',
    'clearQueueButton', 'manualJobForm', 'manualPath', 'manualProfile', 'queueBody',
    'refreshSeriesButton', 'seriesSearch', 'seriesBody', 'episodeHeading', 'episodeSummary',
    'episodeSearch', 'episodesBody', 'refreshMoviesButton', 'movieSearch', 'moviesBody',
    'refreshHistoryButton', 'historySearch', 'historyBody', 'refreshLogsButton', 'logWindow', 'toast'
  ]) {
    elements[id] = byId(id);
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => void activatePanel(tab.dataset.panel));
  });
  document.addEventListener('click', (event) => void handleAction(event));

  elements.manualJobForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/api/queue', {
        method: 'POST',
        body: JSON.stringify({
          path: elements.manualPath.value,
          profileKey: elements.manualProfile.value,
          sourceService: 'manual',
          requestedBy: 'manual'
        })
      });
      elements.manualPath.value = '';
      showToast(result.deduplicated ? 'This file is already queued.' : 'Manual job added to the queue.');
      await refreshStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.cancelActiveButton.addEventListener('click', async () => {
    if (!window.confirm('Stop the active FFmpeg job? The original media file will remain unchanged.')) {
      return;
    }
    try {
      await api('/api/active/cancel', { method: 'POST' });
      showToast('Stopping the active job.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.clearQueueButton.addEventListener('click', async () => {
    if (!window.confirm('Remove all pending jobs from the queue?')) {
      return;
    }
    try {
      const result = await api('/api/queue/clear', { method: 'POST' });
      showToast(`${result.removed} pending job(s) removed.`);
      await refreshStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.clearCacheButton.addEventListener('click', async () => {
    if (!window.confirm('Remove inactive transcode temporary files?')) {
      return;
    }
    try {
      const result = await api('/api/clear-cache', { method: 'POST' });
      showToast(`${result.removed} temporary file(s) removed.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.refreshConnectionsButton.addEventListener('click', () => void refreshConnections());
  elements.refreshSeriesButton.addEventListener('click', () => {
    state.loaded.delete('series');
    void loadSeries(true);
  });
  elements.refreshMoviesButton.addEventListener('click', () => {
    state.loaded.delete('movies');
    void loadMovies(true);
  });
  elements.refreshHistoryButton.addEventListener('click', () => void loadHistory());
  elements.refreshLogsButton.addEventListener('click', () => void loadLogs());
  elements.seriesSearch.addEventListener('input', renderSeries);
  elements.episodeSearch.addEventListener('input', renderSonarrFiles);
  elements.movieSearch.addEventListener('input', renderMovies);
  elements.historySearch.addEventListener('input', renderHistory);
}

async function initialise() {
  cacheElements();
  bindEvents();
  try {
    await loadProfiles();
  } catch (error) {
    showToast(`Could not load profiles: ${error.message}`, true);
  }
  await Promise.allSettled([refreshStatus(), refreshConnections()]);
  setInterval(() => void refreshStatus(), 2000);
}

document.addEventListener('DOMContentLoaded', initialise);
