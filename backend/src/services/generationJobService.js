// Background generation jobs: an in-process queue with a concurrency cap, a
// per-job timeout, stage checkpoints, automatic resume after a transient
// provider failure, manual resume of a failed job, and startup recovery.
//
// Persistence goes through a small store interface (mongoJobStore below) so the
// runner can be tested with an in-memory store. Every failure is logged with
// sanitized metadata only and stored on the job; nothing is swallowed.

const GenerationJob = require('../models/GenerationJob');
const { llmTelemetry, TRANSIENT_LLM_CODES } = require('./geminiClient');

const { ACTIVE_JOB_STATUSES } = GenerationJob;

const DEFAULT_JOB_CONCURRENCY = 2;
const DEFAULT_JOB_TIMEOUT_MS = 900_000;
const DEFAULT_JOB_RESUME_DELAYS_MS = [20_000, 60_000];
// Automatic resumes per processing run; then the job fails with its last error.
const MAX_AUTO_RESUMES = 2;
// Startup recovery fails a job instead of requeueing it once it was resumed
// this many times.
const MAX_RECOVERY_RESUME_COUNT = 2;
const MAX_STORED_EVENTS = 200;
// A failed resume-kit job keeps its in-memory resume text this long, so a
// manual resume in the same process can still use it.
const FAILED_RESUME_INPUT_RETENTION_MS = 60 * 60 * 1000;

const GENERIC_FAILURE_MESSAGE = 'The generation failed unexpectedly. Please try again.';

class JobError extends Error {
  constructor(code, message, { stage, status = 500 } = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.stage = stage || null;
    this.status = status;
    this.isPublic = true;
  }
}

class JobConflictError extends JobError {
  constructor(jobId) {
    super('JOB_ALREADY_RUNNING', 'A generation of this kind is already running.', { status: 409 });
    this.name = 'JobConflictError';
    this.jobId = jobId;
  }
}

class DuplicateActiveJobError extends Error {
  constructor() {
    super('An active job already holds this activeKey.');
    this.name = 'DuplicateActiveJobError';
  }
}

// ---- configuration --------------------------------------------------------

const readPositiveInt = (name, fallback, problems) => {
  const raw = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  problems.push(`${name} must be a positive integer; using the default ${fallback}.`);
  return fallback;
};

const readDelays = (problems) => {
  const raw = typeof process.env.JOB_RESUME_DELAYS_MS === 'string' ? process.env.JOB_RESUME_DELAYS_MS.trim() : '';
  if (!raw) return DEFAULT_JOB_RESUME_DELAYS_MS;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.every((part) => /^\d+$/.test(part))) return parts.map(Number);
  problems.push(`JOB_RESUME_DELAYS_MS must be a comma-separated list of milliseconds; using the default ${DEFAULT_JOB_RESUME_DELAYS_MS.join(',')}.`);
  return DEFAULT_JOB_RESUME_DELAYS_MS;
};

// Read on use, so tests and operators can change them without a restart. An
// invalid value falls back to the default and is reported, never ignored: the
// startup log prints `problems`, and the runner logs them when it reads them.
const readJobConfig = () => {
  const problems = [];
  const config = {
    concurrency: readPositiveInt('JOB_CONCURRENCY', DEFAULT_JOB_CONCURRENCY, problems),
    timeoutMs: readPositiveInt('JOB_TIMEOUT_MS', DEFAULT_JOB_TIMEOUT_MS, problems),
    resumeDelaysMs: readDelays(problems),
    maxAutoResumes: MAX_AUTO_RESUMES,
  };
  return { ...config, problems };
};

const describeJobConfig = () => {
  const { problems, ...config } = readJobConfig();
  return { ...config, maxRecoveryResumeCount: MAX_RECOVERY_RESUME_COUNT, ...(problems.length ? { problems } : {}) };
};

// ---- MongoDB store ---------------------------------------------------------

const toJob = (doc) => (doc ? { ...doc, id: String(doc._id) } : null);

const isActiveKeyConflict = (error) =>
  error?.code === 11000 && (error?.keyPattern?.activeKey !== undefined || /activeKey/.test(String(error?.message)));

const buildUpdate = ({ set = {}, unset = [] }) => {
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (unset.length) update.$unset = Object.fromEntries(unset.map((field) => [field, '']));
  return update;
};

const mongoJobStore = {
  async create(doc) {
    try {
      const created = await GenerationJob.create(doc);
      return toJob(created.toObject());
    } catch (error) {
      if (isActiveKeyConflict(error)) throw new DuplicateActiveJobError();
      throw error;
    }
  },
  async findById(id) {
    return toJob(await GenerationJob.findById(id).lean());
  },
  async findOwned(id, userId) {
    return toJob(await GenerationJob.findOne({ _id: id, userId }).lean());
  },
  async findByActiveKey(activeKey) {
    return toJob(await GenerationJob.findOne({ activeKey }).lean());
  },
  // Returns the updated job, or null when `expectStatus` did not match.
  async update(id, { set, unset, expectStatus } = {}) {
    const filter = expectStatus ? { _id: id, status: expectStatus } : { _id: id };
    try {
      return toJob(await GenerationJob.findOneAndUpdate(filter, buildUpdate({ set, unset }), { returnDocument: 'after' }).lean());
    } catch (error) {
      if (isActiveKeyConflict(error)) throw new DuplicateActiveJobError();
      throw error;
    }
  },
  async setCheckpoint(id, stage, value) {
    await GenerationJob.updateOne({ _id: id }, { $set: { [`checkpoints.${stage}`]: value } });
  },
  async incrementAttempt(id, stage) {
    await GenerationJob.updateOne({ _id: id }, { $inc: { [`attemptsByStage.${stage}`]: 1 } });
  },
  async setModelUsed(id, stage, model) {
    await GenerationJob.updateOne({ _id: id }, { $set: { [`modelsUsed.${stage}`]: model } });
  },
  async pushEvent(id, event) {
    await GenerationJob.updateOne({ _id: id }, { $push: { events: { $each: [event], $slice: -MAX_STORED_EVENTS } } });
  },
  async findUnfinished() {
    return (await GenerationJob.find({ status: { $in: ACTIVE_JOB_STATUSES } }).sort({ createdAt: 1 }).lean()).map(toJob);
  },
};

// ---- runner ---------------------------------------------------------------

const safeErrorMeta = (error) => ({
  name: error?.name || null,
  code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null,
  causeCode: typeof error?.causeCode === 'string' ? error.causeCode : null,
  stage: typeof error?.stage === 'string' ? error.stage : null,
});

const isTransientJobError = (error) =>
  TRANSIENT_LLM_CODES.has(error?.code) || TRANSIENT_LLM_CODES.has(error?.causeCode);

// User-safe error stored on the job. Only errors that are public by design
// (sanitized LLM / pipeline / builder / job errors) keep their message.
const toStoredError = (error, fallbackStage) => {
  const isPublic = error?.isPublic === true || error?.name === 'KitBuilderError';
  const code = typeof error?.code === 'string' && error.code ? error.code : 'JOB_FAILED';
  const message = isPublic && typeof error?.message === 'string' && error.message
    ? error.message.slice(0, 500)
    : GENERIC_FAILURE_MESSAGE;
  const stage = typeof error?.stage === 'string' && error.stage ? error.stage : fallbackStage || null;
  return { code, message, ...(stage ? { stage } : {}) };
};

const activeKeyFor = ({ userId, type, kitId }) => `${userId}:${type}:${kitId || ''}`;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

const createJobRunner = ({
  store = mongoJobStore,
  handlers,
  sleep = defaultSleep,
  now = () => new Date(),
  readConfig = readJobConfig,
} = {}) => {
  const queue = [];
  const queuedIds = new Set();
  const memoryInputs = new Map();
  let active = 0;
  let idleWaiters = [];

  const getHandlers = () => handlers || require('./generationJobHandlers').defaultHandlers;

  const config = () => {
    const current = readConfig();
    if (current.problems?.length) console.error('Generation job configuration is invalid.', JSON.stringify(current.problems));
    return current;
  };

  const logStoreFailure = (operation, jobId) => (error) => {
    console.error('Generation job store write failed.', JSON.stringify({ operation, jobId, ...safeErrorMeta(error) }));
  };

  const notifyIdle = () => {
    if (active !== 0 || queue.length !== 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  };

  const pump = () => {
    const { concurrency } = config();
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift();
      queuedIds.delete(id);
      active += 1;
      processJob(id)
        .catch((error) => {
          console.error('Generation job processing failed outside its error handling.', JSON.stringify({ jobId: id, ...safeErrorMeta(error) }));
        })
        .finally(() => {
          active -= 1;
          pump();
          notifyIdle();
        });
    }
    notifyIdle();
  };

  const enqueue = (id) => {
    if (!queuedIds.has(id)) {
      queuedIds.add(id);
      queue.push(id);
    }
    pump();
  };

  const releaseMemoryInputLater = (id) => {
    if (!memoryInputs.has(id)) return;
    setTimeout(() => { memoryInputs.delete(id); }, FAILED_RESUME_INPUT_RETENTION_MS).unref?.();
  };

  const failJob = async (id, error, fallbackStage) => {
    const stored = toStoredError(error, fallbackStage);
    console.error('Generation job failed.', JSON.stringify({ jobId: id, code: stored.code, stage: stored.stage || null, ...safeErrorMeta(error) }));
    await store.pushEvent(id, { type: 'job_failed', code: stored.code, stage: stored.stage || null, at: now().toISOString() });
    await store.update(id, { set: { status: 'failed', error: stored, finishedAt: now() }, unset: ['activeKey', 'nextRetryAt'] });
    releaseMemoryInputLater(id);
  };

  const cancelledError = (control) =>
    new JobError('JOB_CANCELLED', 'The generation was stopped.', { stage: control.stage });

  const buildContext = (job, stages, control) => ({
    checkpoints: job.checkpoints || {},
    onStage: async (stage, { fromCheckpoint } = {}) => {
      if (control.cancelled) throw cancelledError(control);
      control.stage = stage;
      const stageIndex = stages.indexOf(stage) + 1;
      await store.update(job.id, { set: { stage, stageIndex: stageIndex || job.stageIndex || 0 } });
      if (!fromCheckpoint) await store.incrementAttempt(job.id, stage);
      console.info('Generation job stage.', JSON.stringify({
        jobId: job.id,
        type: job.type,
        stage,
        stageIndex,
        stageCount: stages.length,
        fromCheckpoint: fromCheckpoint === true,
        at: now().toISOString(),
      }));
    },
    saveCheckpoint: async (stage, value) => {
      if (control.cancelled) throw cancelledError(control);
      await store.setCheckpoint(job.id, stage, value);
    },
  });

  // LLM events raised inside the job's async context are stored on the job;
  // a success records which model produced the current stage.
  const telemetrySink = (id, control) => ({
    onEvent: (event) => {
      if (event.type === 'attempt_succeeded') {
        if (control.stage) {
          store.setModelUsed(id, control.stage, `${event.provider}:${event.model}`).catch(logStoreFailure('setModelUsed', id));
        }
        return;
      }
      store.pushEvent(id, { ...event, jobStage: control.stage || null }).catch(logStoreFailure('pushEvent', id));
    },
  });

  const runWithAutoResume = async (jobId, handler, stages, control, cfg) => {
    let autoResumes = 0;
    for (;;) {
      const job = await store.findById(jobId);
      const context = buildContext(job, stages, control);
      try {
        return await llmTelemetry.run(telemetrySink(jobId, control), () =>
          handler.run({ job, context, memoryInput: memoryInputs.get(jobId) })
        );
      } catch (error) {
        if (control.cancelled || !isTransientJobError(error) || autoResumes >= cfg.maxAutoResumes) throw error;
        autoResumes += 1;
        const delayMs = cfg.resumeDelaysMs[Math.min(autoResumes - 1, cfg.resumeDelaysMs.length - 1)] ?? 0;
        const stage = typeof error?.stage === 'string' ? error.stage : control.stage;
        const resumeCount = (job.resumeCount || 0) + 1;
        console.warn('Generation job auto-resume scheduled.', JSON.stringify({
          jobId,
          type: job.type,
          stage,
          autoResume: autoResumes,
          resumeCount,
          delayMs,
          ...safeErrorMeta(error),
        }));
        await store.pushEvent(jobId, {
          type: 'auto_resume',
          stage: stage || null,
          code: typeof error?.code === 'string' ? error.code : null,
          causeCode: typeof error?.causeCode === 'string' ? error.causeCode : null,
          delayMs,
          at: now().toISOString(),
        });
        await store.update(jobId, {
          set: { status: 'retrying', nextRetryAt: new Date(now().getTime() + delayMs), resumeCount },
        });
        await sleep(delayMs);
        if (control.cancelled) throw error;
        await store.update(jobId, { set: { status: 'running' }, unset: ['nextRetryAt'] });
      }
    }
  };

  const processJob = async (id) => {
    const job = await store.findById(id);
    if (!job || job.status !== 'queued') {
      console.warn('Generation job skipped: it is no longer queued.', JSON.stringify({ jobId: id, status: job?.status || null }));
      return;
    }
    const handler = getHandlers()[job.type];
    if (!handler) {
      await failJob(id, new JobError('JOB_UNKNOWN_TYPE', 'This kind of job is not supported.'), null);
      return;
    }
    const cfg = config();
    const stages = handler.stages(job.input || {});
    const control = { cancelled: false, stage: job.stage || null };
    const runStartedAt = now();
    await store.update(id, { set: { status: 'running', startedAt: job.startedAt || runStartedAt }, unset: ['error', 'nextRetryAt'] });
    console.info('Generation job started.', JSON.stringify({
      jobId: id,
      type: job.type,
      resumeCount: job.resumeCount || 0,
      checkpointedStages: Object.keys(job.checkpoints || {}),
      at: runStartedAt.toISOString(),
    }));

    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        control.cancelled = true;
        reject(new JobError('JOB_TIMEOUT', `The generation did not finish within ${Math.round(cfg.timeoutMs / 1000)} seconds.`, { stage: control.stage }));
      }, cfg.timeoutMs);
      timer.unref?.();
    });
    const work = runWithAutoResume(id, handler, stages, control, cfg);
    // After a timeout the abandoned run may still settle; its outcome is logged
    // (it can no longer write checkpoints or results because control.cancelled).
    work.catch((error) => {
      if (control.cancelled) console.warn('Generation job run ended after the job was stopped.', JSON.stringify({ jobId: id, ...safeErrorMeta(error) }));
    });

    try {
      const result = await Promise.race([work, timeout]);
      await store.update(id, { set: { status: 'succeeded', result: result || {}, finishedAt: now() }, unset: ['activeKey', 'nextRetryAt'] });
      memoryInputs.delete(id);
      console.info('Generation job succeeded.', JSON.stringify({
        jobId: id,
        type: job.type,
        durationMs: now().getTime() - runStartedAt.getTime(),
        at: now().toISOString(),
      }));
    } catch (error) {
      control.cancelled = true;
      await failJob(id, error, control.stage);
    } finally {
      clearTimeout(timer);
    }
  };

  const createJob = async ({ userId, type, kitId, input = {}, memoryInput }) => {
    const handler = getHandlers()[type];
    if (!handler) throw new JobError('JOB_UNKNOWN_TYPE', 'This kind of job is not supported.');
    const activeKey = activeKeyFor({ userId, type, kitId });
    let job;
    try {
      job = await store.create({
        userId,
        type,
        ...(kitId ? { kitId } : {}),
        status: 'queued',
        stage: null,
        stageIndex: 0,
        stageCount: handler.stages(input).length,
        input,
        checkpoints: {},
        attemptsByStage: {},
        modelsUsed: {},
        events: [],
        resumeCount: 0,
        activeKey,
      });
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      const existing = await store.findByActiveKey(activeKey);
      throw new JobConflictError(existing ? existing.id : null);
    }
    if (memoryInput) memoryInputs.set(job.id, memoryInput);
    console.info('Generation job queued.', JSON.stringify({ jobId: job.id, type, stageCount: job.stageCount }));
    enqueue(job.id);
    return job;
  };

  const getOwnedJob = (id, userId) => store.findOwned(id, userId);

  const resumeJob = async (id, userId) => {
    const job = await store.findOwned(id, userId);
    if (!job) throw new JobError('JOB_NOT_FOUND', 'Job not found.', { status: 404 });
    if (job.status !== 'failed') {
      throw new JobError('JOB_NOT_RESUMABLE', 'Only a failed job can be resumed.', { status: 409 });
    }
    if (!job.checkpoints || Object.keys(job.checkpoints).length === 0) {
      throw new JobError('JOB_NOT_RESUMABLE', 'This job has no completed stages to resume from; start over instead.', { status: 409 });
    }
    const activeKey = activeKeyFor(job);
    let updated;
    try {
      updated = await store.update(id, {
        set: { status: 'queued', activeKey, resumeCount: (job.resumeCount || 0) + 1 },
        unset: ['error', 'finishedAt', 'nextRetryAt'],
        expectStatus: 'failed',
      });
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      const existing = await store.findByActiveKey(activeKey);
      throw new JobConflictError(existing ? existing.id : null);
    }
    if (!updated) throw new JobError('JOB_NOT_RESUMABLE', 'Only a failed job can be resumed.', { status: 409 });
    await store.pushEvent(id, { type: 'manual_resume', fromStage: job.error?.stage || job.stage || null, at: now().toISOString() });
    console.info('Generation job resumed manually.', JSON.stringify({ jobId: id, type: job.type, fromStage: job.error?.stage || null, resumeCount: updated.resumeCount }));
    enqueue(id);
    return updated;
  };

  const recoverOnStartup = async () => {
    const jobs = await store.findUnfinished();
    let requeued = 0;
    let failed = 0;
    for (const job of jobs) {
      if ((job.resumeCount || 0) >= MAX_RECOVERY_RESUME_COUNT) {
        await failJob(job.id, new JobError(
          'JOB_INTERRUPTED',
          'The server restarted while this generation was running, and it was already resumed the maximum number of times.',
          { stage: job.stage }
        ), job.stage);
        failed += 1;
        continue;
      }
      const wasStarted = job.status !== 'queued';
      await store.update(job.id, {
        set: { status: 'queued', resumeCount: (job.resumeCount || 0) + (wasStarted ? 1 : 0) },
        unset: ['nextRetryAt'],
      });
      if (wasStarted) await store.pushEvent(job.id, { type: 'startup_requeue', stage: job.stage || null, at: now().toISOString() });
      enqueue(job.id);
      requeued += 1;
    }
    console.log('Generation job recovery:', JSON.stringify({ found: jobs.length, requeued, failed }));
    return { found: jobs.length, requeued, failed };
  };

  // Resolves once nothing is running or queued (used by tests).
  const idle = () => new Promise((resolve) => {
    idleWaiters.push(resolve);
    notifyIdle();
  });

  return { createJob, getOwnedJob, resumeJob, recoverOnStartup, idle, stats: () => ({ active, queued: queue.length }) };
};

let defaultRunner;
const getDefaultJobRunner = () => {
  if (!defaultRunner) defaultRunner = createJobRunner();
  return defaultRunner;
};

// The status payload GET /api/jobs/:id returns.
const toJobResponse = (job) => ({
  jobId: job.id,
  type: job.type,
  status: job.status,
  stage: job.stage || null,
  stageIndex: job.stageIndex || 0,
  stageCount: job.stageCount || 0,
  kitId: job.result?.kitId ? String(job.result.kitId) : job.kitId ? String(job.kitId) : null,
  error: job.error?.code ? { code: job.error.code, message: job.error.message, stage: job.error.stage || null } : null,
  resumeCount: job.resumeCount || 0,
  nextRetryAt: job.nextRetryAt || null,
  canResume: job.status === 'failed' && Object.keys(job.checkpoints || {}).length > 0,
  modelsUsed: job.modelsUsed || {},
  ...(job.result?.summary ? { summary: job.result.summary } : {}),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

module.exports = {
  createJobRunner,
  getDefaultJobRunner,
  mongoJobStore,
  readJobConfig,
  describeJobConfig,
  toJobResponse,
  toStoredError,
  isTransientJobError,
  JobError,
  JobConflictError,
  DuplicateActiveJobError,
  MAX_AUTO_RESUMES,
  MAX_RECOVERY_RESUME_COUNT,
  DEFAULT_JOB_RESUME_DELAYS_MS,
};
