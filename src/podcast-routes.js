'use strict';
const express = require('express');
const { validateRequest } = require('./podcast-analysis');

function podcastRouter(store, config, logger) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/status', (_req, res) => res.json({ language: 'en', whisperConfigured: Boolean(config.podcastWhisperModel),
    provider: config.podcastGeminiKey ? 'gemini' : 'rules', sampleBudgetSeconds: config.podcastSampleSeconds, jobs: store.list() }));
  router.post('/jobs', (req, res) => {
    const result = store.enqueue(validateRequest(req.body));
    if (!result.deduplicated) { store.log(result.job.id, 'info', 'Podcast analysis queued'); logger.info('Podcast analysis queued', { jobId: result.job.id }); }
    res.status(result.deduplicated ? 200 : 202).json(result);
  });
  router.get('/jobs/:id', (req, res) => { store.prune(); const job = store.get(req.params.id); if (!job) return res.status(404).json({ error: 'Podcast job not found' }); res.json({ job, logs: store.logs(job.id) }); });
  router.get('/logs', (_req, res) => res.json({ lines: logger.tail(300) }));
  return router;
}
module.exports = { podcastRouter };
