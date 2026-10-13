const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const { getKitById } = require('../src/controllers/interviewPrepKitsController');
const kitBuilderService = require('../src/services/kitBuilderService');
const practiceService = require('../src/services/practiceService');

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const question = (id, text, points = ['Point A']) => ({
  id, category: 'technical', difficulty: 'medium', question: text, why: `Why ${id}`,
  expectedAnswerPoints: points, followUps: ['Follow-up'], sources: [], requirementRefs: ['Node.js'],
});

// A stored kit whose flashcards were copied from the questions at generation time.
const storedKit = () => ({
  role: { title: 'Backend Developer', requirements: [{ id: 'Node.js' }] },
  questions: [question('q1', 'Explain the event loop.'), question('q2', 'How do you index MongoDB?')],
  flashcards: [
    { id: 'f1', front: 'Explain the event loop.', back: 'Point A\nFollow-up', questionIds: ['q1'], practice: { confidence: 4, covered: true, lastReviewedAt: '2026-10-01T00:00:00.000Z' } },
    { id: 'f2', front: 'How do you index MongoDB?', back: 'Point A\nFollow-up', questionIds: ['q2'] },
    { id: 'f3', front: 'Own card', back: 'Own answer', questionIds: [] },
  ],
});

describe('flashcards follow their linked questions', () => {
  it('shows an edited question text and answer in the kit response, keeping practice state', async (t) => {
    const kit = storedKit();
    kit.questions[0] = question('q1', 'Explain the Node.js event loop phases.', ['Timers', 'Poll']);
    const original = InterviewPrepKit.findOne;
    InterviewPrepKit.findOne = async () => kit;
    t.after(() => { InterviewPrepKit.findOne = original; });

    const res = mockResponse();
    await getKitById({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    const [card] = res.body.flashcards;
    assert.equal(card.front, 'Explain the Node.js event loop phases.');
    assert.equal(card.back, 'Timers\nPoll\nFollow-up');
    assert.deepEqual(card.practice, { confidence: 4, covered: true, lastReviewedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('follows a regenerated question once the card is remapped to the new id', () => {
    const kit = storedKit();
    kit.questions[1] = question('q3', 'Design a compound index for a feed query.');
    const remapped = kitBuilderService.withRemappedFlashcardRefs(kit, new Map([['q2', 'q3']]));
    const card = kitBuilderService.withBuilderMetadata(remapped).flashcards[1];
    assert.deepEqual(card.questionIds, ['q3']);
    assert.equal(card.front, 'Design a compound index for a feed query.');
  });

  it('keeps a card that has no linked question as it is', () => {
    const card = kitBuilderService.withBuilderMetadata(storedKit()).flashcards[2];
    assert.equal(card.front, 'Own card');
    assert.equal(card.back, 'Own answer');
  });

  it('keeps a card whose linked question no longer exists as it is', () => {
    const kit = storedKit();
    kit.questions = kit.questions.slice(1);
    const card = kitBuilderService.withBuilderMetadata(kit).flashcards[0];
    assert.equal(card.front, 'Explain the event loop.');
  });

  it('shows the current question text in Practice Mode, with ratings unchanged', () => {
    const kit = storedKit();
    kit.questions[0] = question('q1', 'Explain the Node.js event loop phases.');
    const items = practiceService.buildPracticeItems(practiceService.withPracticeDefaults(kit));
    const item = items.find((entry) => entry.flashcard.id === 'f1');
    assert.equal(item.flashcard.front, 'Explain the Node.js event loop phases.');
    assert.equal(item.practice.confidence, 4);
    assert.equal(item.practice.covered, true);
  });
});
