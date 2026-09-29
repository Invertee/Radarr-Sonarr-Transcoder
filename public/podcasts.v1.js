'use strict';
(() => {
  let selected = null, loading = false;
  const get = async (suffix) => { const response = await fetch(`/api/podcasts${suffix}`); if (!response.ok) throw new Error(`Podcast API returned HTTP ${response.status}`); return response.json(); };
  async function detail(id) {
    selected = id;
    const { job, logs } = await get(`/jobs/${encodeURIComponent(id)}`);
    if (selected !== id) return;
    document.getElementById('podcastDetailTitle').textContent = job.request.title;
    document.getElementById('podcastJobDetails').textContent = JSON.stringify({ job, logs }, null, 2);
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const [status, logs] = await Promise.all([get('/status'), get('/logs')]);
      document.getElementById('podcastHealth').textContent = `English only · ${status.provider} classifier · ${status.sampleBudgetSeconds}s initial sample budget + up to 240s context · Whisper ${status.whisperConfigured ? 'configured' : 'model not configured (set PODCAST_WHISPER_MODEL)'}`;
      const body = document.getElementById('podcastJobs'); body.replaceChildren();
      if (!status.jobs.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.textContent = 'No podcast jobs yet. Enable analysis in Podwaffle or analyse an episode manually.'; }
      for (const job of status.jobs) {
        const row = body.insertRow();
        for (const value of [new Date(job.createdAt).toLocaleString(), job.request.title, job.status, job.error || job.stage, `${job.progress}%`, job.segmentCount]) row.insertCell().textContent = String(value);
        const button = document.createElement('button'); button.className = 'button button--small'; button.textContent = 'Inspect';
        button.addEventListener('click', () => detail(job.id).catch(e => { document.getElementById('podcastError').textContent = e.message; })); row.insertCell().append(button);
      }
      document.getElementById('podcastLogs').textContent = logs.lines.join('\n') || 'No log entries yet.';
      if (selected) await detail(selected);
      document.getElementById('podcastError').textContent = '';
    } catch (error) { document.getElementById('podcastError').textContent = error.message; }
    finally { loading = false; }
  }
  document.getElementById('refreshPodcasts').addEventListener('click', refresh);
  document.querySelector('[data-panel="podcastsPanel"]').addEventListener('click', refresh);
  setInterval(() => { if (!document.hidden && document.getElementById('podcastsPanel').classList.contains('is-active')) void refresh(); }, 5000);
})();
