const test = require('node:test');
const assert = require('node:assert/strict');

const practiceService = require('../src/services/practiceService');

const {
  PracticeError,
  isValidConfidence,
  normalizePracticeState,
  applyFlashcardPracticeDefaults,
  applyKitPracticeDefaults,
  withPracticeDefaults,
  mergeStoredFlashcardPractice,
  practiceFlashcardView,
  buildPracticeItems,
  computeProgress,
  parsePracticeUpdate,
  updatePracticeState,
} = practiceService;

const buildSampleKit = (cardOverrides = []) => ({
  company_brief: { name: 'Acme', industry: 'Tech', culture: [] },
  role: { title: 'Engineer', level: 'Mid', requirements: [] },
  questions: [
    { id: 'q1', category: 'behavioral', difficulty: 2, prompt: 'Prompt 1', answer_guidelines: 'Guide 1' },
    { id: 'q2', category: 'technical', difficulty: 3, prompt: 'Prompt 2', answer_guidelines: 'Guide 2' },
    { id: 'q3', category: 'system-design', difficulty: 3, prompt: 'Prompt 3', answer_guidelines: 'Guide 3' },
    { id: 'q4', category: 'coding', difficulty: 2, prompt: 'Prompt 4', answer_guidelines: 'Guide 4' },
  ],
  flashcards: cardOverrides.length > 0 ? cardOverrides : [
    { id: 'f1', front: 'Front 1', back: 'Back 1', questionIds: ['q1'] },
    { id: 'f2', front: 'Front 2', back: 'Back 2', questionIds: ['q2'] },
    { id: 'f3', front: 'Front 3', back: 'Back 3', questionIds: ['q3'] },
    { id: 'f4', front: 'Front 4', back: 'Back 4', questionIds: ['q4'] },
  ],
  schedule: { interviewDays: 7, days: [] },
  coverage: { behavioral: 1, technical: 1, 'system-design': 1, coding: 1 },
});

test('practice state defaults and normalization', async (t) => {
  await t.test('isValidConfidence accepts null and integers 1 to 5 only', () => {
    assert.equal(isValidConfidence(null), true);
    assert.equal(isValidConfidence(1), true);
    assert.equal(isValidConfidence(3), true);
    assert.equal(isValidConfidence(5), true);
    assert.equal(isValidConfidence(0), false);
    assert.equal(isValidConfidence(6), false);
    assert.equal(isValidConfidence(2.5), false);
    assert.equal(isValidConfidence('3'), false);
    assert.equal(isValidConfidence(undefined), false);
  });

  await t.test('normalizePracticeState defaults missing and invalid fields', () => {
    assert.deepEqual(normalizePracticeState(undefined), {
      confidence: null,
      covered: false,
      lastReviewedAt: null,
    });
    assert.deepEqual(normalizePracticeState({ confidence: 0, covered: 'yes' }), {
      confidence: null,
      covered: false,
      lastReviewedAt: null,
    });
    assert.deepEqual(
      normalizePracticeState({ confidence: 4, covered: true, lastReviewedAt: '2026-04-18T12:00:00.000Z' }),
      { confidence: 4, covered: true, lastReviewedAt: '2026-04-18T12:00:00.000Z' }
    );
  });

  await t.test('applyKitPracticeDefaults preserves content and adds default practice', () => {
    const kit = buildSampleKit();
    const defaulted = applyKitPracticeDefaults(kit);
    assert.equal(defaulted.flashcards.length, 4);
    for (const card of defaulted.flashcards) {
      assert.deepEqual(card.practice, {
        confidence: null,
        covered: false,
        lastReviewedAt: null,
      });
      assert.ok(card.front);
      assert.ok(card.back);
    }
  });

  await t.test('withPracticeDefaults leaves non-kit objects untouched', () => {
    assert.equal(withPracticeDefaults(null), null);
    assert.deepEqual(withPracticeDefaults({ foo: 'bar' }), { foo: 'bar' });
  });
});

test('practice state persistence across whole-kit updates', async (t) => {
  await t.test('mergeStoredFlashcardPractice preserves stored practice for existing cards and defaults new ones', () => {
    const storedKit = buildSampleKit([
      { id: 'f1', front: 'Front 1', back: 'Back 1', practice: { confidence: 4, covered: true, lastReviewedAt: '2026-01-01' } },
      { id: 'f2', front: 'Front 2', back: 'Back 2', practice: { confidence: 1, covered: false, lastReviewedAt: '2026-01-02' } },
    ]);

    const putPayload = buildSampleKit([
      { id: 'f2', front: 'Front 2 Updated', back: 'Back 2 Updated' },
      { id: 'f3', front: 'Front 3 Fresh', back: 'Back 3 Fresh' },
    ]);

    const merged = mergeStoredFlashcardPractice(storedKit, putPayload);
    assert.equal(merged.flashcards.length, 2);

    const f2 = merged.flashcards.find((c) => c.id === 'f2');
    assert.deepEqual(f2.practice, {
      confidence: 1,
      covered: false,
      lastReviewedAt: '2026-01-02',
    });
    assert.equal(f2.front, 'Front 2 Updated');

    const f3 = merged.flashcards.find((c) => c.id === 'f3');
    assert.deepEqual(f3.practice, {
      confidence: null,
      covered: false,
      lastReviewedAt: null,
    });
  });
});

test('deterministic next-session ordering', async (t) => {
  await t.test('orders by uncovered first, then unrated/lower confidence, with stable tie-break', () => {
    // Example from requirements:
    // f1: conf 5, covered: true
    // f2: conf 2, covered: false
    // f3: conf null, covered: false
    // f4: conf 4, covered: false
    // Expected next-session order: f3 (uncovered unrated), f2 (uncovered 2), f4 (uncovered 4), f1 (covered 5)
    const kit = buildSampleKit([
      { id: 'f1', front: 'Card 1', back: 'B1', practice: { confidence: 5, covered: true } },
      { id: 'f2', front: 'Card 2', back: 'B2', practice: { confidence: 2, covered: false } },
      { id: 'f3', front: 'Card 3', back: 'B3', practice: { confidence: null, covered: false } },
      { id: 'f4', front: 'Card 4', back: 'B4', practice: { confidence: 4, covered: false } },
    ]);

    const items = buildPracticeItems(kit);
    const order = items.map((i) => i.flashcard.id);
    assert.deepEqual(order, ['f3', 'f2', 'f4', 'f1']);
  });

  await t.test('breaks ties using original kit array order', () => {
    const kit = buildSampleKit([
      { id: 'fA', front: 'A', back: 'A', practice: { confidence: 3, covered: false } },
      { id: 'fB', front: 'B', back: 'B', practice: { confidence: 3, covered: false } },
      { id: 'fC', front: 'C', back: 'C', practice: { confidence: 3, covered: false } },
    ]);

    const items = buildPracticeItems(kit);
    assert.deepEqual(items.map((i) => i.flashcard.id), ['fA', 'fB', 'fC']);
  });

  await t.test('sorts covered cards with lower confidence before covered cards with higher confidence', () => {
    const kit = buildSampleKit([
      { id: 'c3', front: 'C3', back: 'C3', practice: { confidence: 3, covered: true } },
      { id: 'c1', front: 'C1', back: 'C1', practice: { confidence: 1, covered: true } },
      { id: 'u5', front: 'U5', back: 'U5', practice: { confidence: 5, covered: false } },
    ]);

    const items = buildPracticeItems(kit);
    assert.deepEqual(items.map((i) => i.flashcard.id), ['u5', 'c1', 'c3']);
  });
});

test('deterministic progress calculation', async (t) => {
  await t.test('computes total, covered, uncovered, rated, unrated, and averageConfidence (rounded 2 decimals)', () => {
    const items = [
      { flashcard: { id: '1' }, practice: { confidence: 4, covered: true } },
      { flashcard: { id: '2' }, practice: { confidence: 2, covered: false } },
      { flashcard: { id: '3' }, practice: { confidence: 3, covered: true } },
      { flashcard: { id: '4' }, practice: { confidence: null, covered: false } },
    ];

    const progress = computeProgress(items);
    assert.deepEqual(progress, {
      total: 4,
      covered: 2,
      uncovered: 2,
      rated: 3,
      unrated: 1,
      averageConfidence: 3, // (4 + 2 + 3) / 3 = 3.00
    });
  });

  await t.test('handles empty flashcard list without division by zero', () => {
    const progress = computeProgress([]);
    assert.deepEqual(progress, {
      total: 0,
      covered: 0,
      uncovered: 0,
      rated: 0,
      unrated: 0,
      averageConfidence: null,
    });
  });

  await t.test('averageConfidence is null when all items are unrated', () => {
    const items = [
      { flashcard: { id: '1' }, practice: { confidence: null, covered: true } },
      { flashcard: { id: '2' }, practice: { confidence: null, covered: false } },
    ];
    const progress = computeProgress(items);
    assert.equal(progress.rated, 0);
    assert.equal(progress.averageConfidence, null);
  });
});

test('practice payload validation and error codes', async (t) => {
  await t.test('parsePracticeUpdate accepts valid confidence and covered', () => {
    assert.deepEqual(parsePracticeUpdate({ confidence: 5 }), { confidence: 5 });
    assert.deepEqual(parsePracticeUpdate({ confidence: null, covered: true }), { confidence: null, covered: true });
    assert.deepEqual(parsePracticeUpdate({ covered: false }), { covered: false });
  });

  await t.test('rejects non-object body with PRACTICE_INVALID_PAYLOAD (400)', () => {
    assert.throws(
      () => parsePracticeUpdate('not-an-object'),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_PAYLOAD' && err.status === 400
    );
    assert.throws(
      () => parsePracticeUpdate([1, 2, 3]),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_PAYLOAD' && err.status === 400
    );
  });

  await t.test('rejects confidence out of range or non-integer with PRACTICE_INVALID_CONFIDENCE (400)', () => {
    assert.throws(
      () => parsePracticeUpdate({ confidence: 0 }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_CONFIDENCE' && err.status === 400
    );
    assert.throws(
      () => parsePracticeUpdate({ confidence: 6 }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_CONFIDENCE' && err.status === 400
    );
    assert.throws(
      () => parsePracticeUpdate({ confidence: 2.5 }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_CONFIDENCE' && err.status === 400
    );
    assert.throws(
      () => parsePracticeUpdate({ confidence: '4' }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_CONFIDENCE' && err.status === 400
    );
  });

  await t.test('rejects non-boolean covered with PRACTICE_INVALID_COVERED (400)', () => {
    assert.throws(
      () => parsePracticeUpdate({ covered: 'true' }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_COVERED' && err.status === 400
    );
    assert.throws(
      () => parsePracticeUpdate({ covered: 1 }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_COVERED' && err.status === 400
    );
  });

  await t.test('rejects empty payload with PRACTICE_NO_UPDATABLE_FIELDS (400)', () => {
    assert.throws(
      () => parsePracticeUpdate({}),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_NO_UPDATABLE_FIELDS' && err.status === 400
    );
  });
});

test('updatePracticeState operation and immutability', async (t) => {
  await t.test('updates confidence and covered, sets lastReviewedAt, and leaves input kit untouched', () => {
    const originalKit = buildSampleKit();
    const result = updatePracticeState({
      kit: originalKit,
      flashcardId: 'f2',
      changes: { confidence: 3, covered: true },
    });

    // Output correctness
    assert.equal(result.item.flashcard.id, 'f2');
    assert.equal(result.item.practice.confidence, 3);
    assert.equal(result.item.practice.covered, true);
    assert.ok(result.item.practice.lastReviewedAt);
    assert.equal(result.progress.covered, 1);
    assert.equal(result.progress.rated, 1);
    assert.equal(result.progress.averageConfidence, 3);

    // Input kit was NOT mutated
    assert.equal(originalKit.flashcards[1].practice, undefined);
  });

  await t.test('throws PRACTICE_FLASHCARD_NOT_FOUND (404) for unknown flashcard id', () => {
    const kit = buildSampleKit();
    assert.throws(
      () => updatePracticeState({ kit, flashcardId: 'nonexistent', changes: { covered: true } }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_FLASHCARD_NOT_FOUND' && err.status === 404
    );
  });

  await t.test('throws PRACTICE_INVALID_KIT (409) when kit has no flashcards array', () => {
    assert.throws(
      () => updatePracticeState({ kit: { flashcards: null }, flashcardId: 'f1', changes: { covered: true } }),
      (err) => err instanceof PracticeError && err.code === 'PRACTICE_INVALID_KIT' && err.status === 409
    );
  });
});
