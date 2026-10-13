// Background job HTTP layer: status polling, manual resume, and the shared
// 202 / 409 responses used by every endpoint that starts a job.
// Ownership always comes from req.userId; another user's job is a 404.

const { getDefaultJobRunner, toJobResponse, JobConflictError, JobError } = require('../services/generationJobService');
const { isSafeIdentifier } = require('../services/inputValidationService');

const runnerFrom = (deps) => (deps && typeof deps === 'object' && deps.jobRunner) || getDefaultJobRunner();

const jobNotFound = (res) => res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } });

const isMalformedId = (error) => error?.name === 'CastError';

// Starts a job and answers 202 { jobId }, or 409 with the job that is already
// running for the same user/type/kit.
const startJob = async (res, runner, spec) => {
  try {
    const job = await runner.createJob(spec);
    return res.status(202).json({ jobId: job.id });
  } catch (error) {
    if (error instanceof JobConflictError) {
      return res.status(409).json({ error: { code: error.code, message: error.message, jobId: error.jobId } });
    }
    console.error('Generation job could not be created.', JSON.stringify({ type: spec.type, name: error?.name || null, code: error?.code ?? null }));
    return res.status(500).json({ error: { code: 'JOB_CREATE_FAILED', message: 'The generation could not be started. Please try again.' } });
  }
};

// GET /api/jobs/:id
const getJob = async (req, res, deps) => {
  if (!isSafeIdentifier(req.params.id)) return jobNotFound(res);
  try {
    const job = await runnerFrom(deps).getOwnedJob(req.params.id, req.userId);
    if (!job) return jobNotFound(res);
    return res.json(toJobResponse(job));
  } catch (error) {
    if (isMalformedId(error)) return jobNotFound(res);
    console.error('Generation job lookup failed.', JSON.stringify({ name: error?.name || null, code: error?.code ?? null }));
    return res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Server error.' } });
  }
};

// POST /api/jobs/:id/resume
const resumeJob = async (req, res, deps) => {
  if (!isSafeIdentifier(req.params.id)) return jobNotFound(res);
  try {
    const job = await runnerFrom(deps).resumeJob(req.params.id, req.userId);
    return res.status(202).json(toJobResponse(job));
  } catch (error) {
    if (isMalformedId(error)) return jobNotFound(res);
    if (error instanceof JobConflictError) {
      return res.status(409).json({ error: { code: error.code, message: error.message, jobId: error.jobId } });
    }
    if (error instanceof JobError && (error.status === 404 || error.status === 409)) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    console.error('Generation job resume failed.', JSON.stringify({ name: error?.name || null, code: error?.code ?? null }));
    return res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Server error.' } });
  }
};

module.exports = { getJob, resumeJob, startJob, runnerFrom };
