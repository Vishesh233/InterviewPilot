const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('@google/genai');

const { createJobRunner, toJobResponse } = require('../src/services/generationJobService');
const { createJobHandlers } = require('../src/services/generationJobHandlers');
const { generateInterviewPrepKit } = require('../src/services/interviewPrepPipelineService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const { generateContent, LlmError, resetLlmCooldowns } = require('../src/services/geminiClient');
const { generateInterviewPrep } = require('../src/controllers/interviewPrepController');
const { getJob, resumeJob } = require('../src/controllers/generationJobsController');
const { createMemoryJobStore } = require('./support/memoryJobStore');

// Every LLM-backed stage is mocked; no test reaches the network or MongoDB.

const KIT_STAGE_NAMES = [
  'Requirement extraction',
  'Company research',
  'Question generation',
  'Coverage check',
  'Coverage gap filling',
  'Final coverage check',
  'Interview scheduling',
  'Saving kit',
];

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const question = (id, ref, overrides = {}) => ({
  id,
  question: `How have you used ${ref} in production (${id})?`,
  category: 'technical',
  difficulty: 'medium',
  why: `${ref} is a core requirement.`,
  expectedAnswerPoints: [`A concrete ${ref} example`],
  followUps: [],
  sources: [],
  requirementRefs: [ref],
  ...overrides,
});

const kitInput = (overrides = {}) => ({
  jobRole: 'Frontend Developer',
  jobDescription: 'Frontend role building React and TypeScript applications.',
  companyUrl: 'https://example.com/',
  interviewDays: 3,
  ...overrides,
});

const transient = () => new LlmError('LLM_PROVIDER_UNAVAILABLE', 'The model provider is temporarily unavailable.', 502);

// Pipeline stage mocks with call counters. `generate` may be replaced per test.
const pipelineMocks = () => {
  const calls = { extract: 0, research: 0, generate: 0, gapFill: 0 };
  const behaviour = { generate: async () => ({ questions: [question('q1', 'React'), question('q2', 'TypeScript')] }) };
  const deps = {
    extractRequirements: async () => {
      calls.extract += 1;
      return { role: 'Frontend Developer', seniority: 'mid', mustHaveSkills: ['React', 'TypeScript'], niceToHaveSkills: [], responsibilities: [], qualifications: [], interviewSignals: [] };
    },
    researchCompanyPipeline: async () => {
      calls.research += 1;
      return {
        companyUrl: 'https://example.com/',
        companyTitle: 'Example',
        sources: [{ url: 'https://example.com/', title: 'Example', text: 'Example builds developer tools for engineering teams.' }],
      };
    },
    generateQuestions: async (input) => {
      calls.generate += 1;
      return behaviour.generate(input, calls.generate);
    },
    fillCoverageGaps: async ({ questions, coverage }) => {
      calls.gapFill += 1;
      return { questions, coverage };
    },
  };
  return { calls, deps, behaviour };
};

const fakeKitModel = (storedKit) => {
  const model = {
    created: [],
    updates: [],
    create: async (doc) => {
      model.created.push(doc);
      return { _id: `kit-new-${model.created.length}` };
    },
    findOne: async (criteria) => (storedKit && criteria.userId === 'user-A' ? structuredClone(storedKit) : null),
    findOneAndUpdate: async (criteria, update) => {
      model.updates.push({ criteria, update });
      return { _id: criteria._id, ...update.$set };
    },
  };
  return model;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Lets queued work run; returns once `condition` holds (bounded).
const waitFor = async (condition, label) => {
  for (let step = 0; step < 500; step += 1) {
    if (await condition()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.fail(`timed out waiting for ${label}`);
};

const setup = ({ concurrency = 2, timeoutMs = 60_000, storedKit, serviceDeps } = {}) => {
  const store = createMemoryJobStore();
  const mocks = pipelineMocks();
  const kitModel = fakeKitModel(storedKit);
  const sleeps = [];
  const sleepHooks = [];
  const runner = createJobRunner({
    store,
    handlers: createJobHandlers({ pipelineDeps: mocks.deps, serviceDeps, kitModel }),
    sleep: async (ms) => {
      sleeps.push(ms);
      for (const hook of sleepHooks) await hook(ms);
    },
    readConfig: () => ({ concurrency, timeoutMs, resumeDelaysMs: [20_000, 60_000], maxAutoResumes: 2, problems: [] }),
  });
  return { store, mocks, kitModel, sleeps, sleepHooks, runner };
};

const startKitJob = async (runner, userId = 'user-A', body = kitInput()) => {
  const res = mockResponse();
  await generateInterviewPrep({ body, userId }, res, { jobRunner: runner });
  return res;
};

describe('generation jobs', () => {
  let logs;
  let originals;
  let unhandled;
  const onUnhandled = (reason) => { unhandled.push(reason); };

  beforeEach(() => {
    logs = [];
    unhandled = [];
    originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const level of ['log', 'info', 'warn', 'error']) {
      console[level] = (...args) => { logs.push(args.join(' ')); };
    }
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    Object.assign(console, originals);
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, [], 'job processing must never leak an unhandled rejection');
  });

  it('answers 202 with a jobId for valid input', async () => {
    const { runner, store } = setup();
    const res = await startKitJob(runner);
    assert.equal(res.statusCode, 202);
    assert.equal(typeof res.body.jobId, 'string');
    assert.ok(store.jobs.has(res.body.jobId));
    await runner.idle();
  });

  it('answers 400 for bad input and creates no job', async () => {
    const { runner, store } = setup();
    for (const body of [kitInput({ interviewDays: 0 }), kitInput({ companyUrl: 'http://127.0.0.1/' }), kitInput({ jobDescription: '' })]) {
      const res = await startKitJob(runner, 'user-A', body);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(store.jobs.size, 0);
  });

  it('runs the full kit lifecycle, saving a checkpoint after every stage and the kit at the end', async () => {
    const { runner, store, mocks, kitModel } = setup();
    const res = await startKitJob(runner);
    await runner.idle();

    const job = store.jobs.get(res.body.jobId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.stageCount, KIT_STAGE_NAMES.length);
    assert.equal(job.stage, 'Saving kit');
    assert.equal(job.stageIndex, KIT_STAGE_NAMES.length);
    assert.deepEqual(Object.keys(job.checkpoints), KIT_STAGE_NAMES);
    assert.deepEqual(job.attemptsByStage, Object.fromEntries(KIT_STAGE_NAMES.map((name) => [name, 1])));
    assert.deepEqual(job.result, { kitId: 'kit-new-1' });
    assert.ok(job.startedAt instanceof Date && job.finishedAt instanceof Date);
    assert.equal(job.activeKey, undefined, 'a finished job releases its active slot');
    assert.deepEqual(mocks.calls, { extract: 1, research: 1, generate: 1, gapFill: 1 });

    // The worker saved a structurally valid kit for the owner.
    assert.equal(kitModel.created.length, 1);
    const { userId, ...savedKit } = kitModel.created[0];
    assert.equal(userId, 'user-A');
    assert.equal(validateKitStructure(savedKit).valid, true);
    assert.equal(savedKit.role.title, 'Frontend Developer');
    assert.equal(savedKit.questions[0].status, 'generated');
    assert.equal(savedKit.flashcards.length, savedKit.questions.length);

    // The input stored on the job holds only what the pipeline needs.
    assert.deepEqual(Object.keys(job.input).sort(), ['companyUrl', 'hasResume', 'interviewDays', 'jobDescription', 'jobRole']);
    const status = toJobResponse(job);
    assert.equal(status.kitId, 'kit-new-1');
    assert.equal(status.error, null);
  });

  it('records the model that produced each stage and stores failed LLM attempts on the job', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { LLM_MAX_RETRIES: '1', LLM_RETRY_BASE_MS: '0', GEMINI_FALLBACK_MODELS: '', GEMINI_MODEL: 'test-model' });
    resetLlmCooldowns();
    try {
      const { runner, store, mocks } = setup();
      let geminiCalls = 0;
      const client = {
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            if (geminiCalls === 1) throw new ApiError({ message: 'busy', status: 503 });
            return { text: '{"ok":true}' };
          },
        },
      };
      mocks.behaviour.generate = async () => {
        await generateContent({ contents: 'x', client, stage: 'Question generation' });
        return { questions: [question('q1', 'React'), question('q2', 'TypeScript')] };
      };
      const res = await startKitJob(runner);
      await runner.idle();
      await waitFor(() => store.jobs.get(res.body.jobId).modelsUsed['Question generation'], 'modelsUsed');

      const job = store.jobs.get(res.body.jobId);
      assert.equal(job.status, 'succeeded');
      assert.deepEqual(job.modelsUsed, { 'Question generation': 'gemini:test-model' });
      const failed = job.events.filter((event) => event.type === 'attempt_failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].jobStage, 'Question generation');
      assert.equal(failed[0].status, 503);
      assert.equal(failed[0].action, 'retry');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      resetLlmCooldowns();
    }
  });

  it('auto-resumes after a transient failure at stage 3 without re-running stages 1 and 2', async () => {
    const { runner, store, mocks, sleeps, sleepHooks } = setup();
    mocks.behaviour.generate = async (input, call) => {
      if (call === 1) throw transient();
      return { questions: [question('q1', 'React'), question('q2', 'TypeScript')] };
    };
    let duringWait;
    const res = await startKitJob(runner);
    sleepHooks.push(async () => { duringWait = await store.findById(res.body.jobId); });
    await runner.idle();

    const job = store.jobs.get(res.body.jobId);
    assert.equal(job.status, 'succeeded');
    // Requirement extraction and company research ran once; their checkpoints were reused.
    assert.equal(mocks.calls.extract, 1);
    assert.equal(mocks.calls.research, 1);
    assert.equal(mocks.calls.generate, 2);
    assert.equal(job.attemptsByStage['Requirement extraction'], 1);
    assert.equal(job.attemptsByStage['Question generation'], 2);
    assert.equal(job.resumeCount, 1);
    assert.deepEqual(sleeps, [20_000]);
    assert.equal(duringWait.status, 'retrying');
    assert.ok(duringWait.nextRetryAt instanceof Date);
    const resumes = job.events.filter((event) => event.type === 'auto_resume');
    assert.deepEqual(resumes.map((event) => [event.stage, event.code, event.delayMs]), [
      ['Question generation', 'LLM_PROVIDER_UNAVAILABLE', 20_000],
    ]);
    assert.ok(logs.some((line) => line.startsWith('Generation job auto-resume scheduled.')));
  });

  it('fails with the final error code and stage once the auto-resume limit is reached', async () => {
    const { runner, store, mocks, sleeps } = setup();
    mocks.behaviour.generate = async () => { throw transient(); };
    const res = await startKitJob(runner);
    await runner.idle();

    const job = store.jobs.get(res.body.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'LLM_PROVIDER_UNAVAILABLE');
    assert.equal(job.error.stage, 'Question generation');
    assert.match(job.error.message, /temporarily unavailable/);
    assert.equal(job.resumeCount, 2);
    assert.deepEqual(sleeps, [20_000, 60_000]);
    assert.equal(mocks.calls.generate, 3);
    assert.equal(mocks.calls.extract, 1);
    assert.equal(job.activeKey, undefined);
    assert.ok(job.events.some((event) => event.type === 'job_failed' && event.stage === 'Question generation'));
    assert.equal(toJobResponse(job).canResume, true);
    assert.ok(logs.some((line) => line.startsWith('Generation job failed.')));
  });

  it('resumes a failed job from its checkpoints through POST /api/jobs/:id/resume', async () => {
    const { runner, store, mocks } = setup();
    mocks.behaviour.generate = async () => { throw transient(); };
    const res = await startKitJob(runner);
    await runner.idle();
    assert.equal(store.jobs.get(res.body.jobId).status, 'failed');

    // Another user cannot resume it.
    const foreign = mockResponse();
    await resumeJob({ params: { id: res.body.jobId }, userId: 'user-B' }, foreign, { jobRunner: runner });
    assert.equal(foreign.statusCode, 404);

    mocks.behaviour.generate = async () => ({ questions: [question('q1', 'React'), question('q2', 'TypeScript')] });
    const resumed = mockResponse();
    await resumeJob({ params: { id: res.body.jobId }, userId: 'user-A' }, resumed, { jobRunner: runner });
    assert.equal(resumed.statusCode, 202);
    assert.equal(resumed.body.status, 'queued');
    await runner.idle();

    const job = store.jobs.get(res.body.jobId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.error, undefined);
    assert.equal(mocks.calls.extract, 1, 'finished stages are not repeated');
    assert.equal(mocks.calls.research, 1);
    assert.equal(mocks.calls.generate, 4);
    assert.equal(job.resumeCount, 3);
    assert.ok(job.events.some((event) => event.type === 'manual_resume' && event.fromStage === 'Question generation'));

    // A succeeded job cannot be resumed.
    const again = mockResponse();
    await resumeJob({ params: { id: res.body.jobId }, userId: 'user-A' }, again, { jobRunner: runner });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.error.code, 'JOB_NOT_RESUMABLE');
  });

  it('fails immediately on a permanent error or a validation failure, without auto-resume', async () => {
    const { runner, store, mocks, sleeps } = setup();
    mocks.behaviour.generate = async () => { throw new LlmError('LLM_REQUEST_FAILED', 'The model request failed.', 502); };
    const first = await startKitJob(runner, 'user-A');
    await runner.idle();
    const permanent = store.jobs.get(first.body.jobId);
    assert.equal(permanent.status, 'failed');
    assert.equal(permanent.error.code, 'LLM_REQUEST_FAILED');
    assert.equal(permanent.error.stage, 'Question generation');
    assert.equal(permanent.resumeCount, 0);
    assert.equal(mocks.calls.generate, 1);
    assert.deepEqual(sleeps, []);

    // An insufficient extraction is a validation failure: no checkpoint, so it
    // cannot be resumed either.
    mocks.deps.extractRequirements = async () => ({ role: null, seniority: null, mustHaveSkills: [], niceToHaveSkills: [], responsibilities: [], qualifications: [], interviewSignals: [] });
    const second = await startKitJob(runner, 'user-B');
    await runner.idle();
    const invalid = store.jobs.get(second.body.jobId);
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.error.code, 'INSUFFICIENT_JOB_DESCRIPTION');
    assert.equal(invalid.error.stage, 'Requirement extraction');
    assert.deepEqual(invalid.checkpoints, {});
    assert.deepEqual(sleeps, []);
    const res = mockResponse();
    await resumeJob({ params: { id: second.body.jobId }, userId: 'user-B' }, res, { jobRunner: runner });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'JOB_NOT_RESUMABLE');
  });

  it('answers 409 JOB_ALREADY_RUNNING with the existing jobId for a duplicate request', async () => {
    const { runner, mocks } = setup();
    const gate = deferred();
    mocks.behaviour.generate = async () => {
      await gate.promise;
      return { questions: [question('q1', 'React'), question('q2', 'TypeScript')] };
    };
    const first = await startKitJob(runner, 'user-A');
    const duplicate = await startKitJob(runner, 'user-A');
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.error.code, 'JOB_ALREADY_RUNNING');
    assert.equal(duplicate.body.error.jobId, first.body.jobId);

    const otherUser = await startKitJob(runner, 'user-B');
    assert.equal(otherUser.statusCode, 202);

    gate.resolve();
    await runner.idle();
    const afterFinish = await startKitJob(runner, 'user-A');
    assert.equal(afterFinish.statusCode, 202, 'the slot is free again once the job finished');
    await runner.idle();
  });

  it('returns job status to its owner only (404 for another user or a malformed id)', async () => {
    const { runner } = setup();
    const res = await startKitJob(runner);
    await runner.idle();

    const own = mockResponse();
    await getJob({ params: { id: res.body.jobId }, userId: 'user-A' }, own, { jobRunner: runner });
    assert.equal(own.statusCode, 200);
    for (const field of ['type', 'status', 'stage', 'stageIndex', 'stageCount', 'kitId', 'error', 'resumeCount', 'nextRetryAt', 'createdAt', 'updatedAt']) {
      assert.ok(Object.hasOwn(own.body, field), field);
    }
    assert.equal(own.body.status, 'succeeded');
    assert.equal(Object.hasOwn(own.body, 'checkpoints'), false, 'checkpoints are not exposed');
    assert.equal(Object.hasOwn(own.body, 'input'), false, 'the job input is not exposed');

    for (const [id, userId] of [[res.body.jobId, 'user-B'], ['not a valid id', 'user-A'], ['job999', 'user-A']]) {
      const other = mockResponse();
      await getJob({ params: { id }, userId }, other, { jobRunner: runner });
      assert.equal(other.statusCode, 404);
      assert.equal(other.body.error.code, 'JOB_NOT_FOUND');
    }
  });

  it('requeues unfinished jobs from their checkpoints at startup and fails over-resumed ones', async () => {
    const { runner, store, mocks } = setup();
    const research = await mocks.deps.researchCompanyPipeline();
    const extracted = await mocks.deps.extractRequirements();
    mocks.calls.extract = 0;
    mocks.calls.research = 0;
    const base = { type: 'kit', input: { ...kitInput(), hasResume: false }, stageCount: 8, checkpoints: {}, attemptsByStage: {}, modelsUsed: {}, events: [] };
    const interrupted = await store.create({
      ...base, userId: 'user-A', activeKey: 'user-A:kit:', status: 'running', stage: 'Question generation', stageIndex: 3, resumeCount: 0,
      checkpoints: { 'Requirement extraction': extracted, 'Company research': research },
    });
    const waiting = await store.create({ ...base, userId: 'user-B', activeKey: 'user-B:kit:', status: 'queued', stage: null, stageIndex: 0, resumeCount: 0 });
    const exhausted = await store.create({ ...base, userId: 'user-C', activeKey: 'user-C:kit:', status: 'retrying', stage: 'Question generation', stageIndex: 3, resumeCount: 2 });

    const counts = await runner.recoverOnStartup();
    assert.deepEqual(counts, { found: 3, requeued: 2, failed: 1 });
    assert.ok(logs.some((line) => line.startsWith('Generation job recovery:')));
    await runner.idle();

    assert.equal(store.jobs.get(interrupted.id).status, 'succeeded');
    assert.equal(store.jobs.get(interrupted.id).resumeCount, 1);
    assert.equal(store.jobs.get(waiting.id).status, 'succeeded');
    assert.equal(store.jobs.get(waiting.id).resumeCount, 0);
    // Only the queued job ran extraction and research; the interrupted one reused its checkpoints.
    assert.equal(mocks.calls.extract, 1);
    assert.equal(mocks.calls.research, 1);
    assert.equal(mocks.calls.generate, 2);

    const failed = store.jobs.get(exhausted.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'JOB_INTERRUPTED');
    assert.equal(failed.error.stage, 'Question generation');
    assert.equal(failed.activeKey, undefined);
  });

  it('runs at most JOB_CONCURRENCY jobs at once; extra jobs stay queued', async () => {
    const { runner, store, mocks } = setup({ concurrency: 2 });
    const gate = deferred();
    mocks.behaviour.generate = async () => {
      await gate.promise;
      return { questions: [question('q1', 'React'), question('q2', 'TypeScript')] };
    };
    const ids = [];
    for (const user of ['user-1', 'user-2', 'user-3']) ids.push((await startKitJob(runner, user)).body.jobId);

    await waitFor(() => mocks.calls.generate === 2, 'two running jobs');
    const statuses = ids.map((id) => store.jobs.get(id).status);
    assert.deepEqual(statuses, ['running', 'running', 'queued']);
    assert.deepEqual(runner.stats(), { active: 2, queued: 1 });

    gate.resolve();
    await runner.idle();
    assert.deepEqual(ids.map((id) => store.jobs.get(id).status), ['succeeded', 'succeeded', 'succeeded']);
  });

  it('fails a job that exceeds JOB_TIMEOUT_MS with JOB_TIMEOUT and the stage it was in', async () => {
    const { runner, store, mocks, kitModel } = setup({ timeoutMs: 30 });
    const gate = deferred();
    mocks.behaviour.generate = async () => {
      await gate.promise;
      return { questions: [question('q1', 'React'), question('q2', 'TypeScript')] };
    };
    const res = await startKitJob(runner);
    await runner.idle();
    const job = store.jobs.get(res.body.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'JOB_TIMEOUT');
    assert.equal(job.error.stage, 'Question generation');

    // The abandoned run finishes later but can no longer write anything.
    gate.resolve();
    await waitFor(() => logs.some((line) => line.startsWith('Generation job run ended after the job was stopped.')), 'abandoned run');
    assert.equal(kitModel.created.length, 0);
    assert.equal(store.jobs.get(res.body.jobId).status, 'failed');
  });

  describe('kit change jobs', () => {
    const storedKit = () => ({
      source: { jobDescription: 'Backend role with Node.js and MongoDB.', companyUrl: 'https://example.com/' },
      company_brief: { name: 'Example', summary: 'Builds software.', sources: [{ url: 'https://example.com/', title: 'Example' }] },
      role: { title: 'Backend Developer', requirements: [{ id: 'Node.js' }, { id: 'MongoDB' }] },
      questions: [
        { ...question('q1', 'Node.js'), status: 'generated', pinned: false },
        { ...question('q2', 'Node.js', { category: 'behavioral' }), status: 'generated', pinned: true },
      ],
      flashcards: [{ id: 'f1', front: 'Node', back: 'Event loop', questionIds: ['q1'] }],
      schedule: { interviewDays: 2, days: [{ day: 1, question_ids: ['q1'] }, { day: 2, question_ids: ['q2'] }] },
      coverage: { coveragePercent: 50, coveredRequirements: ['Node.js'], missingRequirements: ['MongoDB'] },
    });

    it('runs a gapQuestions job and saves the added questions for the owner', async () => {
      const gapCalls = [];
      const { runner, store, kitModel } = setup({
        storedKit: storedKit(),
        serviceDeps: {
          fillCoverageGaps: async ({ questions, coverage }) => {
            gapCalls.push(coverage.missingRequirements);
            return { questions: [...questions, question('q3', 'MongoDB')], coverage: { missingRequirements: [] } };
          },
        },
      });
      const job = await runner.createJob({ userId: 'user-A', type: 'gapQuestions', kitId: 'kit-1', input: {} });
      await runner.idle();

      const done = store.jobs.get(job.id);
      assert.equal(done.status, 'succeeded');
      // The role title is a requirement too, and no question references it yet.
      // The title is role metadata, not a declared requirement, so it is never a gap.
      assert.deepEqual(gapCalls, [['MongoDB']]);
      assert.deepEqual(Object.keys(done.checkpoints), ['Coverage gap filling', 'Saving kit']);
      assert.equal(done.stageCount, 2);
      assert.equal(kitModel.updates.length, 1);
      assert.deepEqual(kitModel.updates[0].criteria, { _id: 'kit-1', userId: 'user-A' });
      assert.equal(kitModel.updates[0].update.$set.questions.length, 3);
      assert.deepEqual(done.result.summary.addedQuestionIds, ['q3']);
      assert.equal(toJobResponse(done).kitId, 'kit-1');
    });

    it('runs a regenerate job and saves the regenerated section for the owner', async () => {
      const { runner, store, kitModel } = setup({
        storedKit: storedKit(),
        serviceDeps: {
          generateQuestions: async () => ({ questions: [question('n1', 'Node.js', { question: 'How do you profile a slow Node.js endpoint?' })] }),
          fillCoverageGaps: async ({ questions, coverage }) => ({ questions, coverage }),
        },
      });
      const job = await runner.createJob({ userId: 'user-A', type: 'regenerate', kitId: 'kit-1', input: { category: 'technical' } });
      await runner.idle();

      const done = store.jobs.get(job.id);
      assert.equal(done.status, 'succeeded');
      assert.equal(kitModel.updates.length, 1);
      const saved = kitModel.updates[0].update.$set.questions;
      assert.equal(saved.find((entry) => entry.category === 'technical').question, 'How do you profile a slow Node.js endpoint?');
      assert.equal(saved.find((entry) => entry.pinned).id, 'q2', 'pinned questions are preserved');
      assert.deepEqual(done.result.summary.replacedQuestionIds, ['q1']);
    });

    it('fails a kit change job with KIT_NOT_FOUND when the kit is gone', async () => {
      const { runner, store } = setup({ storedKit: null });
      const job = await runner.createJob({ userId: 'user-A', type: 'gapQuestions', kitId: 'kit-1', input: {} });
      await runner.idle();
      assert.equal(store.jobs.get(job.id).error.code, 'KIT_NOT_FOUND');
    });
  });
});

describe('evaluation CLI path is unchanged', () => {
  it('runs every stage once without a context and returns the same result as with an empty context', async () => {
    const plain = pipelineMocks();
    const withoutContext = await generateInterviewPrepKit(kitInput(), plain.deps);
    assert.deepEqual(plain.calls, { extract: 1, research: 1, generate: 1, gapFill: 1 });

    const tracked = pipelineMocks();
    const stages = [];
    const saved = {};
    const withContext = await generateInterviewPrepKit(kitInput(), tracked.deps, {
      checkpoints: {},
      onStage: async (stage) => { stages.push(stage); },
      saveCheckpoint: async (stage, value) => { saved[stage] = value; },
    });
    assert.deepEqual(withContext, withoutContext);
    assert.deepEqual(stages, KIT_STAGE_NAMES.slice(0, -1));
    assert.deepEqual(Object.keys(saved), KIT_STAGE_NAMES.slice(0, -1));
  });

  it('keeps the evaluate script calling the pipeline with input and deps only', () => {
    const source = require('node:fs').readFileSync(require.resolve('../scripts/evaluate.js'), 'utf8');
    assert.doesNotMatch(source, /saveCheckpoint|onStage|createJobRunner/);
  });
});
