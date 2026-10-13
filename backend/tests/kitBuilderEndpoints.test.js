const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const kitBuilderService = require('../src/services/kitBuilderService');
const { JobConflictError } = require('../src/services/generationJobService');
const {
  updateKitQuestion,
  reorderKitQuestions,
  setKitQuestionPinned,
  regenerateKitSection,
} = require('../src/controllers/interviewPrepKitBuilderController');

const buildKit = () => ({
  source: {
    jobDescription: 'Junior Backend Developer with Node.js and MongoDB.',
    companyUrl: 'https://example.com/',
  },
  company_brief: {
    name: 'Example Company',
    summary: 'Builds software products.',
    sources: [{ url: 'https://example.com/', title: 'Example Company' }],
  },
  role: {
    title: 'Junior Backend Developer',
    level: 'junior',
    requirements: [{ id: 'Node.js' }, { id: 'MongoDB' }],
  },
  questions: [
    {
      id: 'q1',
      question: 'Explain the Node.js event loop.',
      category: 'technical',
      difficulty: 1,
      why: 'Core Node.js knowledge.',
      expectedAnswerPoints: ['Loop phases'],
      followUps: [],
      sources: [],
      requirementRefs: ['Node.js'],
      status: 'generated',
      pinned: false,
    },
    {
      id: 'q2',
      question: 'How do you model data in MongoDB?',
      category: 'technical',
      difficulty: 2,
      why: 'Schema trade-offs.',
      expectedAnswerPoints: ['Embed vs reference'],
      followUps: [],
      sources: [],
      requirementRefs: ['MongoDB'],
      status: 'generated',
      pinned: false,
    },
    {
      id: 'q3',
      question: 'Describe a time you shipped under pressure.',
      category: 'behavioral',
      difficulty: 2,
      why: 'Ownership signals.',
      expectedAnswerPoints: ['STAR'],
      followUps: [],
      sources: [],
      requirementRefs: ['Node.js'],
      status: 'generated',
      pinned: true,
    },
  ],
  flashcards: [{ id: 'f1', front: 'Event loop', back: 'Async work.', questionIds: ['q1', 'q3'] }],
  schedule: {
    interviewDays: 2,
    days: [
      { day: 1, question_ids: ['q1', 'q2'] },
      { day: 2, question_ids: ['q3'] },
    ],
  },
  coverage: {
    coveragePercent: 100,
    coveredRequirements: ['Node.js', 'MongoDB'],
    missingRequirements: [],
  },
});

const buildRequest = (overrides = {}) => ({
  userId: 'user-A',
  params: { id: 'kit-1' },
  body: {},
  ...overrides,
});

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const withModelStubs = (t, stubs) => {
  const methods = ['create', 'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete'];
  const originals = {};
  for (const method of methods) {
    originals[method] = InterviewPrepKit[method];
    if (stubs[method] !== undefined) InterviewPrepKit[method] = stubs[method];
  }
  t.after(() => {
    for (const method of methods) InterviewPrepKit[method] = originals[method];
  });
};

// Stubs the model with a stored kit and records every write.
const withStoredKit = (t, kit = buildKit()) => {
  const calls = { findOne: [], findOneAndUpdate: [] };
  withModelStubs(t, {
    findOne: async (criteria) => {
      calls.findOne.push(criteria);
      return { toObject: () => kit };
    },
    findOneAndUpdate: async (criteria, patch, options) => {
      calls.findOneAndUpdate.push({ criteria, patch, options });
      return { _id: 'kit-1', ...patch.$set };
    },
  });
  return calls;
};

const storedKitOf = (calls) => calls.findOneAndUpdate[0].patch.$set;

describe('PATCH /api/kits/:id/questions/:questionId', () => {
  it('marks the question edited, keeps its id and pins state, and persists the kit', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({
        params: { id: 'kit-1', questionId: 'q3' },
        body: { question: 'Tell me about your toughest deadline.', why: 'Ownership.' },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.findOne[0], { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(calls.findOneAndUpdate[0].criteria, { _id: 'kit-1', userId: 'user-A' });
    assert.equal(calls.findOneAndUpdate[0].options.returnDocument, 'after');

    const persisted = storedKitOf(calls);
    assert.equal(persisted.questions[2].id, 'q3');
    assert.equal(persisted.questions[2].status, 'edited');
    assert.equal(persisted.questions[2].pinned, true);
    assert.deepEqual(persisted.questions[2].requirementRefs, ['Node.js']);
    assert.equal(res.body.questions[2].question, 'Tell me about your toughest deadline.');
    assert.deepEqual(Object.keys(persisted).sort(), [
      'company_brief',
      'coverage',
      'flashcards',
      'questions',
      'role',
      'schedule',
      'source',
    ]);
  });

  it('never accepts a client-supplied userId as ownership', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({
        params: { id: 'kit-1', questionId: 'q1' },
        body: { question: 'Edited.', userId: 'attacker', _id: 'other-kit' },
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.findOne[0], { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(calls.findOneAndUpdate[0].criteria, { _id: 'kit-1', userId: 'user-A' });
  });

  it('returns 404 for a question that is not in the kit', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({ params: { id: 'kit-1', questionId: 'q9' }, body: { question: 'Nope.' } }),
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'QUESTION_NOT_FOUND');
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('returns 404 for a kit the user does not own', async (t) => {
    const calls = { findOneAndUpdate: 0 };
    withModelStubs(t, {
      findOne: async () => null,
      findOneAndUpdate: async () => {
        calls.findOneAndUpdate += 1;
        return null;
      },
    });
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { question: 'Nope.' } }),
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    assert.equal(calls.findOneAndUpdate, 0);
  });

  it('returns 400 and does not persist when the edited kit fails validation', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { question: '   ' } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'KIT_VALIDATION_FAILED');
    assert.ok(res.body.error.details.length > 0);
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('returns 400 when no editable field is provided', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await updateKitQuestion(
      buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { pinned: true, id: 'q9' } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_NO_UPDATABLE_FIELDS');
    assert.equal(calls.findOneAndUpdate.length, 0);
  });
});


describe('PATCH /api/kits/:id/questions/reorder', () => {
  it('persists the new order and keeps every question', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(
      buildRequest({ params: { id: 'kit-1' }, body: { questionIds: ['q3', 'q1', 'q2'] } }),
      res
    );
    assert.equal(res.statusCode, 200);
    const persisted = storedKitOf(calls);
    assert.deepEqual(
      persisted.questions.map((question) => question.id),
      ['q3', 'q1', 'q2']
    );
    // content and builder metadata survive a pure reorder
    assert.equal(persisted.questions[1].question, 'Explain the Node.js event loop.');
    assert.equal(persisted.questions[0].status, 'generated');
    assert.equal(persisted.questions[0].pinned, true);
    // schedule follows the new order without new question ids
    assert.deepEqual(persisted.schedule.days.flatMap((day) => day.question_ids), ['q3', 'q1', 'q2']);
  });

  it('accepts the "order" alias', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(
      buildRequest({ params: { id: 'kit-1' }, body: { order: ['q2', 'q3', 'q1'] } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      storedKitOf(calls).questions.map((question) => question.id),
      ['q2', 'q3', 'q1']
    );
  });

  it('rejects duplicate ids without touching the kit', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(
      buildRequest({ params: { id: 'kit-1' }, body: { questionIds: ['q1', 'q1', 'q2'] } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_DUPLICATE_QUESTION_IDS');
    assert.deepEqual(res.body.error.details.duplicateQuestionIds, ['q1']);
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('rejects unknown ids without touching the kit (reorder is not parsed as a question id)', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(
      buildRequest({ params: { id: 'kit-1' }, body: { questionIds: ['q1', 'q2', 'nope'] } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_UNKNOWN_QUESTION_IDS');
    assert.deepEqual(res.body.error.details.unknownQuestionIds, ['nope']);
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('rejects orders that drop a question', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(
      buildRequest({ params: { id: 'kit-1' }, body: { questionIds: ['q1', 'q2'] } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_MISSING_QUESTION_IDS');
    assert.deepEqual(res.body.error.details.missingQuestionIds, ['q3']);
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('rejects a missing questionIds field', async (t) => {
    withStoredKit(t);
    const res = mockResponse();
    await reorderKitQuestions(buildRequest({ params: { id: 'kit-1' }, body: {} }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_INVALID_ORDER');
  });

  it('returns 404 for another user kit', async (t) => {
    withModelStubs(t, { findOne: async () => null });
    const res = mockResponse();
    await reorderKitQuestions(buildRequest({ params: { id: 'kit-9' }, body: { questionIds: ['q1'] } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
  });
});

describe('PATCH /api/kits/:id/questions/:questionId/pin', () => {
  it('pins a question without editing it', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await setKitQuestionPinned(
      buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { pinned: true } }),
      res
    );
    assert.equal(res.statusCode, 200);
    const persisted = storedKitOf(calls);
    assert.equal(persisted.questions[0].pinned, true);
    assert.equal(persisted.questions[0].status, 'generated');
    assert.equal(persisted.questions[0].question, 'Explain the Node.js event loop.');
  });

  it('unpins a pinned question', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await setKitQuestionPinned(
      buildRequest({ params: { id: 'kit-1', questionId: 'q3' }, body: { pinned: false } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(storedKitOf(calls).questions[2].pinned, false);
  });

  it('rejects non-boolean payloads', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await setKitQuestionPinned(
      buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { pinned: 'yes' } }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_INVALID_PIN_PAYLOAD');
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('returns 404 for an unknown question', async (t) => {
    const calls = withStoredKit(t);
    const res = mockResponse();
    await setKitQuestionPinned(
      buildRequest({ params: { id: 'kit-1', questionId: 'q9' }, body: { pinned: true } }),
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'QUESTION_NOT_FOUND');
    assert.equal(calls.findOneAndUpdate.length, 0);
  });

  it('returns 404 for a foreign kit', async (t) => {
    withModelStubs(t, { findOne: async () => null });
    const res = mockResponse();
    await setKitQuestionPinned(
      buildRequest({ params: { id: 'other', questionId: 'q1' }, body: { pinned: true } }),
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
  });
});


// The regeneration itself runs as a background job; its persistence rules
// (validate before write, owner-only update) are covered in generationJobs.test.js.
const fakeRunner = (impl) => {
  const specs = [];
  return {
    specs,
    createJob: async (spec) => {
      specs.push(spec);
      if (impl) return impl(spec);
      return { id: 'job-1' };
    },
  };
};

describe('POST /api/kits/:id/regenerate', () => {
  it('runs the synchronous checks, then starts a regenerate job (202)', async (t) => {
    const calls = withStoredKit(t);
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-1' }, body: { category: ' technical ' } }), res, { jobRunner: runner });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { jobId: 'job-1' });
    assert.deepEqual(calls.findOne[0], { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(runner.specs, [{ userId: 'user-A', type: 'regenerate', kitId: 'kit-1', input: { category: 'technical' } }]);
    assert.equal(calls.findOneAndUpdate.length, 0, 'nothing is written by the request itself');
  });

  it('accepts the "section" alias', async (t) => {
    withStoredKit(t);
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-1' }, body: { section: 'technical' } }), res, { jobRunner: runner });
    assert.equal(res.statusCode, 202);
    assert.equal(runner.specs[0].input.category, 'technical');
  });

  it('returns 400 for a missing category and never touches the kit', async (t) => {
    const calls = withStoredKit(t);
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-1' }, body: {} }), res, { jobRunner: runner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BUILDER_INVALID_SECTION');
    assert.equal(calls.findOneAndUpdate.length, 0);
    assert.equal(runner.specs.length, 0);
  });

  it('returns 409 synchronously when there is nothing safe to replace', async (t) => {
    // The only behavioral question (q3) is pinned.
    const calls = withStoredKit(t);
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-1' }, body: { category: 'behavioral' } }), res, { jobRunner: runner });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'BUILDER_NO_REPLACEABLE_QUESTIONS');
    assert.equal(res.body.error.details.category, 'behavioral');
    assert.equal(calls.findOneAndUpdate.length, 0);
    assert.equal(runner.specs.length, 0);
  });

  it('answers 409 JOB_ALREADY_RUNNING with the existing job id', async (t) => {
    withStoredKit(t);
    const runner = fakeRunner(() => { throw new JobConflictError('job-existing'); });
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-1' }, body: { category: 'technical' } }), res, { jobRunner: runner });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'JOB_ALREADY_RUNNING');
    assert.equal(res.body.error.jobId, 'job-existing');
  });

  it('returns 404 for another user kit before starting anything', async (t) => {
    withModelStubs(t, { findOne: async () => null });
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(buildRequest({ params: { id: 'kit-9' }, body: { category: 'technical' } }), res, { jobRunner: runner });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    assert.equal(runner.specs.length, 0);
  });
});


describe('kit builder ownership and error mapping', () => {
  it('returns 404 and never writes for every builder endpoint when the kit is foreign', async (t) => {
    let writes = 0;
    withModelStubs(t, {
      findOne: async () => null,
      findOneAndUpdate: async () => {
        writes += 1;
        return null;
      },
    });

    const requests = [
      (res) =>
        updateKitQuestion(buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { question: 'x' } }), res),
      (res) => reorderKitQuestions(buildRequest({ params: { id: 'kit-1' }, body: { questionIds: ['q1'] } }), res),
      (res) =>
        setKitQuestionPinned(buildRequest({ params: { id: 'kit-1', questionId: 'q1' }, body: { pinned: true } }), res),
      (res) =>
        regenerateKitSection(
          buildRequest({ params: { id: 'kit-1' }, body: { category: 'technical' } }),
          res
        ),
    ];

    for (const run of requests) {
      const res = mockResponse();
      await run(res);
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    }
    assert.equal(writes, 0);
  });

  it('maps a malformed kit id to 404 on every builder endpoint', async (t) => {
    const castError = new Error('bad id');
    castError.name = 'CastError';
    withModelStubs(t, {
      findOne: async () => {
        throw castError;
      },
    });

    const requests = [
      (res) => updateKitQuestion(buildRequest({ params: { id: 'bad', questionId: 'q1' }, body: { question: 'x' } }), res),
      (res) => reorderKitQuestions(buildRequest({ params: { id: 'bad' }, body: { questionIds: ['q1'] } }), res),
      (res) =>
        setKitQuestionPinned(buildRequest({ params: { id: 'bad', questionId: 'q1' }, body: { pinned: true } }), res),
      (res) => regenerateKitSection(buildRequest({ params: { id: 'bad' }, body: { category: 'technical' } }), res),
    ];

    for (const run of requests) {
      const res = mockResponse();
      await run(res);
      assert.equal(res.statusCode, 404);
    }
  });

  it('ignores a client-supplied userId on regeneration', async (t) => {
    const calls = withStoredKit(t);
    const runner = fakeRunner();
    const res = mockResponse();
    await regenerateKitSection(
      buildRequest({ params: { id: 'kit-1' }, body: { category: 'technical', userId: 'attacker' } }),
      res,
      { jobRunner: runner }
    );
    assert.deepEqual(calls.findOne[0], { _id: 'kit-1', userId: 'user-A' });
    assert.equal(runner.specs[0].userId, 'user-A');
  });
});

