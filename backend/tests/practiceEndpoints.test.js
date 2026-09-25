const test = require('node:test');
const assert = require('node:assert/strict');

const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const routes = require('../src/routes/interviewPrepKitsRoutes');
const {
  getKitPractice,
  updateKitPractice,
} = require('../src/controllers/interviewPrepPracticeController');

const buildMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
};

const makeSampleKitDoc = (userId = 'user_123', overrides = {}) => ({
  _id: 'kit_abc',
  userId,
  company_brief: { name: 'Acme', industry: 'Tech', culture: [] },
  role: { title: 'Engineer', level: 'Mid', requirements: [] },
  questions: [
    { id: 'q1', category: 'behavioral', difficulty: 2, prompt: 'Prompt 1', answer_guidelines: 'G1' },
  ],
  flashcards: [
    { id: 'f1', front: 'Front 1', back: 'Back 1', questionIds: ['q1'], practice: { confidence: 5, covered: true } },
    { id: 'f2', front: 'Front 2', back: 'Back 2', questionIds: ['q1'], practice: { confidence: 2, covered: false } },
    { id: 'f3', front: 'Front 3', back: 'Back 3', questionIds: ['q1'], practice: { confidence: null, covered: false } },
  ],
  schedule: { interviewDays: 7, days: [] },
  coverage: { behavioral: 1 },
  ...overrides,
});

test('route registration', async (t) => {
  await t.test('registers GET and PATCH practice endpoints with requireAuth', () => {
    const routeLayers = routes.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
        stackLength: layer.route.stack.length,
      }));

    const getPractice = routeLayers.find((r) => r.path === '/api/kits/:id/practice');
    assert.ok(getPractice, 'GET /api/kits/:id/practice route should exist');
    assert.ok(getPractice.methods.includes('get'));
    assert.ok(getPractice.stackLength >= 2, 'Should include requireAuth middleware');

    const patchPractice = routeLayers.find((r) => r.path === '/api/kits/:id/practice/:flashcardId');
    assert.ok(patchPractice, 'PATCH /api/kits/:id/practice/:flashcardId route should exist');
    assert.ok(patchPractice.methods.includes('patch'));
    assert.ok(patchPractice.stackLength >= 2, 'Should include requireAuth middleware');
  });
});

test('GET /api/kits/:id/practice controller endpoint', async (t) => {
  await t.test('returns ordered practice items and progress for owned kit', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async (query) => {
        if (query._id === 'kit_abc' && query.userId === 'user_123') {
          return makeSampleKitDoc('user_123');
        }
        return null;
      };

      const req = {
        params: { id: 'kit_abc' },
        userId: 'user_123',
      };
      const res = buildMockRes();

      await getKitPractice(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.kitId, 'kit_abc');
      // Ordered: f3 (uncovered null), f2 (uncovered 2), f1 (covered 5)
      assert.deepEqual(
        res.body.items.map((i) => i.flashcard.id),
        ['f3', 'f2', 'f1']
      );
      assert.deepEqual(res.body.progress, {
        total: 3,
        covered: 1,
        uncovered: 2,
        rated: 2,
        unrated: 1,
        averageConfidence: 3.5, // (5 + 2) / 2
      });
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });

  await t.test('returns 404 KIT_NOT_FOUND when kit is not owned by requesting user', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async () => null;

      const req = {
        params: { id: 'kit_foreign' },
        userId: 'attacker_user',
      };
      const res = buildMockRes();

      await getKitPractice(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });
});

test('PATCH /api/kits/:id/practice/:flashcardId controller endpoint', async (t) => {
  await t.test('updates confidence and covered, persists to database, and returns updated item + progress', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    const originalFindOneAndUpdate = InterviewPrepKit.findOneAndUpdate;
    let persistedDoc = null;

    try {
      InterviewPrepKit.findOne = async (query) => {
        if (query._id === 'kit_abc' && query.userId === 'user_123') {
          return makeSampleKitDoc('user_123');
        }
        return null;
      };

      InterviewPrepKit.findOneAndUpdate = async (query, update) => {
        if (query._id === 'kit_abc' && query.userId === 'user_123') {
          persistedDoc = update.$set;
          return { _id: 'kit_abc', ...persistedDoc };
        }
        return null;
      };

      const req = {
        params: { id: 'kit_abc', flashcardId: 'f2' },
        userId: 'user_123',
        body: { confidence: 4, covered: true },
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.kitId, 'kit_abc');
      assert.equal(res.body.item.flashcard.id, 'f2');
      assert.equal(res.body.item.practice.confidence, 4);
      assert.equal(res.body.item.practice.covered, true);
      assert.ok(res.body.item.practice.lastReviewedAt);
      assert.equal(res.body.progress.covered, 2);

      // Verify DB persistence occurred with updated flashcards
      assert.ok(persistedDoc, 'Should have persisted via findOneAndUpdate');
      const persistedF2 = persistedDoc.flashcards.find((c) => c.id === 'f2');
      assert.equal(persistedF2.practice.confidence, 4);
      assert.equal(persistedF2.practice.covered, true);
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
      InterviewPrepKit.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  await t.test('returns 404 PRACTICE_FLASHCARD_NOT_FOUND for non-existent flashcard id without persisting', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    const originalFindOneAndUpdate = InterviewPrepKit.findOneAndUpdate;
    let updateCalled = false;

    try {
      InterviewPrepKit.findOne = async () => makeSampleKitDoc('user_123');
      InterviewPrepKit.findOneAndUpdate = async () => {
        updateCalled = true;
        return null;
      };

      const req = {
        params: { id: 'kit_abc', flashcardId: 'f_unknown' },
        userId: 'user_123',
        body: { confidence: 3 },
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'PRACTICE_FLASHCARD_NOT_FOUND');
      assert.equal(updateCalled, false);
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
      InterviewPrepKit.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  await t.test('returns 400 PRACTICE_INVALID_CONFIDENCE for invalid confidence value', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async () => makeSampleKitDoc('user_123');

      const req = {
        params: { id: 'kit_abc', flashcardId: 'f1' },
        userId: 'user_123',
        body: { confidence: 7 },
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'PRACTICE_INVALID_CONFIDENCE');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });

  await t.test('returns 400 PRACTICE_INVALID_COVERED for non-boolean covered', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async () => makeSampleKitDoc('user_123');

      const req = {
        params: { id: 'kit_abc', flashcardId: 'f1' },
        userId: 'user_123',
        body: { covered: 'not-a-bool' },
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'PRACTICE_INVALID_COVERED');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });

  await t.test('returns 400 PRACTICE_NO_UPDATABLE_FIELDS for empty body', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async () => makeSampleKitDoc('user_123');

      const req = {
        params: { id: 'kit_abc', flashcardId: 'f1' },
        userId: 'user_123',
        body: {},
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'PRACTICE_NO_UPDATABLE_FIELDS');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });

  await t.test('returns 404 KIT_NOT_FOUND when updating another user kit', async () => {
    const originalFindOne = InterviewPrepKit.findOne;
    try {
      InterviewPrepKit.findOne = async () => null;

      const req = {
        params: { id: 'kit_foreign', flashcardId: 'f1' },
        userId: 'attacker_user',
        body: { confidence: 5 },
      };
      const res = buildMockRes();

      await updateKitPractice(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'KIT_NOT_FOUND');
    } finally {
      InterviewPrepKit.findOne = originalFindOne;
    }
  });
});
