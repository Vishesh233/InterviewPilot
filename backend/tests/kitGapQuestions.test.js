const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const { generateGapQuestions } = require('../src/services/kitGapQuestionService');
const { fillCoverageGaps } = require('../src/services/gapFillService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const { validateQuestion } = require('../src/services/questionSchema');
const kitGapQuestionService = require('../src/services/kitGapQuestionService');
const { generateKitGapQuestions } = require('../src/controllers/interviewPrepKitBuilderController');
const routes = require('../src/routes/interviewPrepKitsRoutes');

const fakeClient = (text) => ({
  models: { generateContent: async () => ({ text: typeof text === 'function' ? text() : text }) },
});

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

// Model-shaped gap response used by the real gap-fill stage.
const modelResponse = (questions) =>
  JSON.stringify({
    questions: questions.map((item) => ({
      question: item.question,
      category: 'technical',
      difficulty: 'medium',
      why: 'Uncovered requirement.',
      expectedAnswerPoints: ['Point'],
      followUps: [],
      sources: [],
      requirementRefs: item.requirementRefs,
    })),
  });

const buildKit = (overrides = {}) => ({
  _id: 'kit_abc',
  userId: 'user_123',
  source: { jobDescription: 'Backend role with Node.js and MongoDB.', companyUrl: 'https://example.com/' },
  company_brief: { name: 'Example', summary: 'Builds software products.', sources: [{ url: 'https://example.com/', title: 'Example' }] },
  role: { title: 'Backend Engineer', level: 'junior', requirements: [{ id: 'Backend Engineer' }, { id: 'junior' }, { id: 'Node.js' }, { id: 'MongoDB' }, { id: 'AWS' }] },
  questions: [
    { id: 'q1', question: 'Explain the Node.js event loop.', category: 'technical', difficulty: 1, why: 'Core runtime.', expectedAnswerPoints: ['Phases'], followUps: [], sources: [], requirementRefs: ['Node.js'], status: 'generated', pinned: false },
    { id: 'q2', question: 'How do you model book documents in MongoDB?', category: 'technical', difficulty: 2, why: 'Schema design.', expectedAnswerPoints: ['Embed vs reference'], followUps: [], sources: [], requirementRefs: ['MongoDB'], status: 'generated', pinned: false },
  ],
  flashcards: [
    { id: 'f1', front: 'Event loop', back: 'Phases', questionIds: ['q1'] },
    { id: 'f2', front: 'MongoDB models', back: 'Embed vs reference', questionIds: ['q2'] },
  ],
  schedule: { interviewDays: 2, days: [{ day: 1, question_ids: ['q1'] }, { day: 2, question_ids: ['q2'] }] },
  coverage: { coveragePercent: 40, coveredRequirements: ['Backend Engineer', 'junior', 'Node.js', 'MongoDB'], missingRequirements: ['AWS'] },
  ...overrides,
});

// The role and seniority requirements are declared but no question references them,
// so the deterministic coverage check reports exactly these gaps.
const gapFixture = () => buildKit({
  questions: [
    { id: 'q1', question: 'Explain the Node.js event loop.', category: 'technical', difficulty: 1, why: 'Core runtime.', expectedAnswerPoints: ['Phases'], followUps: [], sources: [], requirementRefs: ['Node.js'], status: 'generated', pinned: false },
  ],
  flashcards: [{ id: 'f1', front: 'Event loop', back: 'Phases', questionIds: ['q1'] }],
  schedule: { interviewDays: 2, days: [{ day: 1, question_ids: ['q1'] }, { day: 2, question_ids: [] }] },
  coverage: { coveragePercent: 20, coveredRequirements: ['Node.js'], missingRequirements: ['AWS', 'Backend Engineer', 'junior', 'MongoDB'] },
});

// A complete, Appendix A-valid question (the gap stage rejects anything less).
const gapQuestion = (overrides = {}) => ({
  question: 'What would you deploy to AWS for this workload?',
  category: 'technical',
  difficulty: 2,
  why: 'AWS is an uncovered requirement.',
  expectedAnswerPoints: ['Choose a managed service'],
  followUps: [],
  sources: [],
  requirementRefs: ['AWS'],
  ...overrides,
});

// Every declared requirement is referenced by a question, so the deterministic
// coverage check reports no gaps at all.
const fullyCoveredKit = () => buildKit({
  role: { title: 'Backend Engineer', level: 'junior', requirements: [{ id: 'Backend Engineer' }, { id: 'junior' }, { id: 'Node.js' }, { id: 'MongoDB' }] },
  questions: [
    { id: 'q1', question: 'Explain the Node.js event loop for this backend role.', category: 'technical', difficulty: 1, why: 'Core runtime.', expectedAnswerPoints: ['Phases'], followUps: [], sources: [], requirementRefs: ['Node.js', 'Backend Engineer'], status: 'generated', pinned: false },
    { id: 'q2', question: 'How do you model MongoDB documents for a junior backend engineer?', category: 'technical', difficulty: 2, why: 'Schema design.', expectedAnswerPoints: ['Embed vs reference'], followUps: [], sources: [], requirementRefs: ['MongoDB', 'junior'], status: 'generated', pinned: false },
  ],
  flashcards: [
    { id: 'f1', front: 'Event loop', back: 'Phases', questionIds: ['q1'] },
    { id: 'f2', front: 'MongoDB models', back: 'Embed vs reference', questionIds: ['q2'] },
  ],
  coverage: { coveragePercent: 100, coveredRequirements: ['Backend Engineer', 'junior', 'Node.js', 'MongoDB'], missingRequirements: [] },
});

describe('gap question generation for a saved kit', () => {
  it('appends questions for uncovered requirements only and keeps existing ones untouched', async () => {
    const kit = gapFixture();
    const before = JSON.parse(JSON.stringify(kit.questions));
    let gapInput = null;

    const { kit: next, summary } = await generateGapQuestions({
      kit,
      deps: {
        fillCoverageGaps: async (input) => {
          gapInput = input;
          return { questions: [...input.questions, { ...gapQuestion(), id: 'q2' }], coverage: input.coverage };
        },
      },
    });

    // The gap stage receives the deterministic uncovered requirements, nothing else.
    assert.deepEqual(gapInput.coverage.missingRequirements, ['Backend Engineer', 'junior', 'MongoDB', 'AWS']);
    assert.equal(gapInput.research.sources[0].url, 'https://example.com/');

    assert.deepEqual(next.questions.slice(0, 1), before, 'existing questions must not change');
    assert.equal(next.questions.length, 2);
    assert.equal(next.questions[1].id, 'q2');
    assert.equal(next.questions[1].status, 'generated');
    assert.equal(next.questions[1].pinned, false);
    assert.deepEqual(summary.addedQuestionIds, ['q2']);
    assert.equal(summary.gapCount, 4);
    assert.equal(summary.remainingGaps.includes('AWS'), false, 'the filled gap is no longer missing');

    // Flashcards, schedule and coverage stay consistent with the new question.
    assert.equal(next.flashcards.length, 2);
    assert.deepEqual(next.flashcards[1], {
      id: 'f2',
      front: next.questions[1].question,
      back: 'Choose a managed service',
      questionIds: ['q2'],
    });
    assert.equal(next.schedule.days.flatMap((day) => day.question_ids).includes('q2'), true);
    assert.equal(next.coverage.coveredRequirements.includes('AWS'), true);
    assert.equal(validateKitStructure(next).valid, true, JSON.stringify(validateKitStructure(next).errors));
  });

  it('does nothing when the kit has no gaps', async () => {
    const kit = fullyCoveredKit();
    let called = false;
    await assert.rejects(
      () => generateGapQuestions({ kit, deps: { fillCoverageGaps: async () => { called = true; return {}; } } }),
      (error) => {
        assert.equal(error.code, 'KIT_NO_COVERAGE_GAPS');
        assert.equal(error.status, 409);
        return true;
      }
    );
    assert.equal(called, false, 'no LLM call for a fully covered kit');
  });

  it('drops a generated question that duplicates an existing one and reports it', async () => {
    const { kit: next, summary } = await generateGapQuestions({
      kit: gapFixture(),
      deps: {
        fillCoverageGaps: async ({ questions }) => ({
          questions: [
            ...questions,
            { ...gapQuestion({ question: questions[0].question, requirementRefs: ['AWS'] }), id: 'q2' },
            { ...gapQuestion(), id: 'q3' },
          ],
          coverage: { missingRequirements: ['AWS'] },
        }),
      },
    });
    assert.deepEqual(summary.addedQuestionIds, ['q3']);
    assert.deepEqual(summary.droppedDuplicateQuestionIds, ['q2']);
    assert.equal(next.questions.some((item) => item.id === 'q2'), false);
  });

  it('refuses to write when every generated question was a duplicate', async () => {
    const kit = gapFixture();
    const snapshot = JSON.parse(JSON.stringify(kit));
    await assert.rejects(
      () => generateGapQuestions({
        kit,
        deps: {
          fillCoverageGaps: async ({ questions }) => ({
            questions: [...questions, { ...gapQuestion({ question: questions[0].question }), id: 'q2' }],
            coverage: { missingRequirements: ['AWS'] },
          }),
        },
      }),
      (error) => {
        assert.equal(error.code, 'KIT_NO_NEW_GAP_QUESTIONS');
        assert.equal(error.status, 409);
        return true;
      }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(kit)), snapshot, 'the stored kit is untouched');
  });

  it('reassigns ids that would collide with existing questions', async () => {
    const kit = gapFixture();
    kit.questions.push({ ...kit.questions[0], id: 'q2' });
    kit.flashcards.push({ id: 'f2', front: 'x', back: 'y', questionIds: ['q2'] });
    kit.schedule.days = [{ day: 1, question_ids: ['q1', 'q2'] }, { day: 2, question_ids: [] }];
    const { kit: next } = await generateGapQuestions({
      kit,
      deps: { fillCoverageGaps: async ({ questions }) => ({ questions: [...questions, { ...gapQuestion(), id: 'q2' }] }) },
    });
    const ids = next.questions.map((item) => item.id);
    assert.deepEqual(ids, ['q1', 'q2', 'q3']);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(next.flashcards.map((card) => card.id), ['f1', 'f2', 'f3']);
    assert.equal(validateKitStructure(next).valid, true);
  });

  it('surfaces a gap-fill failure without leaking provider internals', async () => {
    await assert.rejects(
      () => generateGapQuestions({
        kit: gapFixture(),
        deps: {
          fillCoverageGaps: async () => {
            throw Object.assign(new Error('provider key sk-live leaked'), { code: 'LLM_REQUEST_FAILED', isPublic: false, status: 502 });
          },
        },
      }),
      (error) => {
        assert.equal(error.code, 'KIT_GAP_GENERATION_FAILED');
        assert.equal(error.status, 500);
        assert.equal(error.message.includes('sk-live'), false);
        return true;
      }
    );
  });
});

describe('gap fill stage duplicate guard', () => {
  const requirements = {
    role: null,
    seniority: null,
    mustHaveSkills: ['Node.js', 'AWS'],
    niceToHaveSkills: [],
    responsibilities: [],
    qualifications: [],
    interviewSignals: [],
  };
  const questions = [
    { id: 'q1', question: 'Explain the Node.js event loop.', category: 'technical', difficulty: 1, why: 'Core runtime.', expectedAnswerPoints: ['Phases'], followUps: [], sources: [], requirementRefs: ['Node.js'] },
  ];
  const coverage = { missingRequirements: ['AWS'], coveredRequirements: ['Node.js'], coveragePercent: 50 };

  it('never appends a question identical to one already in the kit', async () => {
    const result = await fillCoverageGaps({
      requirements,
      research: { companyTitle: 'Example', sources: [] },
      questions,
      coverage,
      client: fakeClient(modelResponse([gapQuestion({ question: questions[0].question }), gapQuestion()])),
    });
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.droppedDuplicateQuestionIds, ['q2']);
    assert.equal(result.questions[1].id, 'q3');
    assert.deepEqual(result.coverage.missingRequirements, []);
    assert.equal(validateQuestion(result.questions[1]).valid, true, 'existing question validation still passes');
  });

  it('reports no gaps and makes no call when nothing is missing', async () => {
    let called = false;
    const full = { missingRequirements: [], coveredRequirements: ['Node.js'], coveragePercent: 100 };
    const result = await fillCoverageGaps({
      requirements,
      research: {},
      questions,
      coverage: full,
      client: { models: { generateContent: async () => { called = true; return { text: '{}' }; } } },
    });
    assert.deepEqual(result, { questions, coverage: full, droppedDuplicateQuestionIds: [] });
    assert.equal(called, false);
  });

  it('rejects a gap question that references an already covered requirement', async () => {
    await assert.rejects(
      () => fillCoverageGaps({
        requirements,
        research: { companyTitle: 'Example', sources: [] },
        questions,
        coverage,
        client: fakeClient(modelResponse([gapQuestion({ requirementRefs: ['Node.js'] })])),
      }),
      (error) => {
        assert.equal(error.code, 'LLM_INVALID_STRUCTURE');
        assert.equal(error.isPublic, true);
        return true;
      }
    );
  });
});

describe('gap question endpoint', () => {
  it('registers POST /api/kits/:id/gaps behind requireAuth', () => {
    const route = routes.stack
      .filter((layer) => layer.route)
      .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods), stackLength: layer.route.stack.length }))
      .find((entry) => entry.path === '/api/kits/:id/gaps');
    assert.ok(route, 'the gap route must exist');
    assert.ok(route.methods.includes('post'));
    assert.ok(route.stackLength >= 2, 'the route must be authenticated');
  });

  it('checks for gaps synchronously, then starts a gapQuestions job for the owner (202)', async () => {
    const kit = gapFixture();
    const originalFindOne = InterviewPrepKit.findOne;
    const originalUpdate = InterviewPrepKit.findOneAndUpdate;
    const specs = [];
    let writes = 0;
    InterviewPrepKit.findOne = async (filter) => (filter.userId === 'user_123' ? kit : null);
    InterviewPrepKit.findOneAndUpdate = async () => { writes += 1; return null; };
    try {
      const res = mockResponse();
      await generateKitGapQuestions({ params: { id: 'kit_abc' }, userId: 'user_123' }, res, {
        jobRunner: { createJob: async (spec) => { specs.push(spec); return { id: 'job-9' }; } },
      });
      assert.equal(res.statusCode, 202);
      assert.deepEqual(res.body, { jobId: 'job-9' });
      assert.deepEqual(specs, [{ userId: 'user_123', type: 'gapQuestions', kitId: 'kit_abc', input: {} }]);
      assert.equal(writes, 0, 'the request itself writes nothing');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
      InterviewPrepKit.findOneAndUpdate = originalUpdate;
    }
  });

  it('answers 409 synchronously when the kit has no gaps', async () => {
    const kit = fullyCoveredKit();
    const originalFindOne = InterviewPrepKit.findOne;
    let started = false;
    InterviewPrepKit.findOne = async () => kit;
    try {
      const res = mockResponse();
      await generateKitGapQuestions({ params: { id: 'kit_abc' }, userId: 'user_123' }, res, {
        jobRunner: { createJob: async () => { started = true; return { id: 'x' }; } },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'KIT_NO_COVERAGE_GAPS');
      assert.equal(started, false);
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });

  it('returns 404 for a kit owned by somebody else', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    InterviewPrepKit.findOne = async () => null;
    try {
      const res = mockResponse();
      await generateKitGapQuestions({ params: { id: 'kit_abc' }, userId: 'user_999' }, res);
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });
});