'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { getProfile } = require('./profiles');
const {
  CancelledError,
  atomicReplace,
  createTempOutput,
  probeFile,
  removeTemp,
  transcode,
  verifyOutput
} = require('./ffmpeg');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class QueueWorker {
  constructor({ db, config, logger, arrClient }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.arrClient = arrClient;
    this.running = false;
    this.loopPromise = null;
    this.activeJob = null;
    this.activeAbortController = null;
    this.abortReason = null;
    this.lastProgressWrite = 0;
  }

  status() {
    if (!this.activeJob) {
      return {
        status: 'Idle',
        jobId: null,
        file: null,
        fullPath: null,
        profile: null,
        progress: 0,
        fps: null,
        speed: null,
        outputTimeSeconds: 0,
        durationSeconds: 0
      };
    }
    return { ...this.activeJob };
  }

  activeTempPath() {
    return this.activeJob?.tempPath || null;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop() {
    this.running = false;
    if (this.activeAbortController) {
      this.abortReason = 'shutdown';
      this.activeAbortController.abort();
    }
    await this.loopPromise;
  }

  cancelActive() {
    if (!this.activeAbortController || !this.activeJob) {
      return false;
    }
    this.abortReason = 'user';
    this.activeAbortController.abort();
    return true;
  }

  async runLoop() {
    while (this.running) {
      try {
        const job = this.db.claimNextJob();
        if (!job) {
          await delay(this.config.queuePollMs);
          continue;
        }

        await this.processJob(job);
      } catch (error) {
        this.logger.error('Queue worker loop failed; retrying', { error: error.stack || error.message });
        await delay(this.config.queuePollMs);
      }
    }
  }

  async processJob(job) {
    const profile = getProfile(job.profile_key, this.config.defaultProfile);
    this.abortReason = null;
    this.activeAbortController = new AbortController();
    this.activeJob = {
      status: profile.key === 'skip' ? 'Skipping' : 'Processing',
      jobId: Number(job.id),
      file: path.basename(job.path),
      fullPath: job.path,
      profile: profile.name,
      profileKey: profile.key,
      progress: 0,
      fps: null,
      speed: null,
      outputTimeSeconds: 0,
      durationSeconds: 0,
      tempPath: null
    };

    let tempPath = null;

    try {
      if (profile.key === 'skip') {
        this.db.skipJob(job.id);
        this.logger.info('Job skipped by profile', { jobId: job.id, path: job.path });
        return;
      }

      const stat = await fs.stat(job.path);
      if (!stat.isFile()) {
        throw new Error('Source path is not a regular file');
      }

      const inputProbe = await probeFile(job.path, this.config);
      tempPath = createTempOutput(job.id, job.path, this.config.cacheDir);
      this.activeJob.durationSeconds = inputProbe.durationSeconds;
      this.activeJob.tempPath = tempPath;
      this.db.updateInputMetadata(job.id, inputProbe, tempPath);

      this.logger.info('Starting transcode', {
        jobId: job.id,
        file: job.path,
        profile: profile.name,
        audioStreams: inputProbe.audioStreams
      });

      await transcode({
        jobId: job.id,
        inputPath: job.path,
        outputPath: tempPath,
        profile,
        durationSeconds: inputProbe.durationSeconds,
        config: this.config,
        logger: this.logger,
        signal: this.activeAbortController.signal,
        onProgress: (progress) => this.handleProgress(job.id, progress)
      });

      this.throwIfCancelled();
      const outputProbe = await probeFile(tempPath, this.config);
      verifyOutput(inputProbe, outputProbe);
      this.throwIfCancelled();

      await atomicReplace(job.path, tempPath, {
        logger: this.logger,
        signal: this.activeAbortController.signal
      });
      const finalStat = await fs.stat(job.path);

      const result = {
        originalBytes: inputProbe.sizeBytes,
        outputBytes: finalStat.size,
        savedBytes: inputProbe.sizeBytes - finalStat.size,
        durationSeconds: outputProbe.durationSeconds || inputProbe.durationSeconds,
        width: outputProbe.width,
        height: outputProbe.height,
        audioStreams: outputProbe.audioStreams
      };

      this.db.completeJob(job, result);
      this.logger.info('Transcode completed', {
        jobId: job.id,
        savedBytes: result.savedBytes,
        audioStreams: result.audioStreams
      });

      try {
        await this.arrClient.rescanJob(job);
      } catch (error) {
        this.logger.warn('Transcode completed but Arr rescan failed', {
          jobId: job.id,
          service: job.source_service,
          error: error.message
        });
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        if (this.abortReason === 'shutdown') {
          this.db.requeueProcessingJob(job.id, 'Requeued during service shutdown');
          this.logger.info('Active job requeued during service shutdown', { jobId: job.id });
        } else {
          this.db.cancelProcessingJob(job.id);
          this.logger.warn('Active job cancelled', { jobId: job.id });
        }
      } else {
        const message = error.details ? `${error.message}\n${error.details}` : error.message;
        this.db.failJob(job.id, message);
        this.logger.error('Transcode failed', { jobId: job.id, error: error.message });
      }
    } finally {
      try {
        await removeTemp(tempPath);
      } catch (error) {
        this.logger.warn('Could not remove transcode temporary file', { tempPath, error: error.message });
      }
      this.activeJob = null;
      this.activeAbortController = null;
      this.abortReason = null;
      this.lastProgressWrite = 0;
    }
  }

  throwIfCancelled() {
    if (this.activeAbortController?.signal.aborted) {
      throw new CancelledError();
    }
  }

  handleProgress(jobId, progress) {
    if (!this.activeJob) {
      return;
    }

    this.activeJob.progress = progress.percent;
    this.activeJob.fps = progress.fps;
    this.activeJob.speed = progress.speed;
    this.activeJob.outputTimeSeconds = progress.outputTimeSeconds;
    this.activeJob.tempPath = progress.tempPath;

    const timestamp = Date.now();
    if (timestamp - this.lastProgressWrite >= 2000 || progress.percent === 100) {
      this.db.updateProgress(jobId, progress);
      this.lastProgressWrite = timestamp;
    }
  }
}

module.exports = {
  QueueWorker
};
