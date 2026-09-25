const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateKitStructure } = require('../src/services/kitStructureValidator');

const buildValidKit = () => ({
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
    { id: 'q1', question: 'Explain the Node.js event loop.', difficulty: 1, requirementRefs: ['Node.js'] },
    { id: 'q2', question: 'How do you model data in MongoDB?', difficulty: 'medium', requirementRefs: ['MongoDB'] },
  ],
  flashcards: [
    { id: 'f1', front: 'Node.js event loop', back: 'Handles async work.', questionIds: ['q1'] },
  ],
  schedule: {
    interviewDays: 2,
    days: [
      { day: 1, question_ids: ['q1'] },
      { day: 2, question_ids: ['q2'] },
    ],
  },
  coverage: {
    coveragePercent: 100,
    coveredRequirements: ['Node.js', 'MongoDB'],
    missingRequirements: [],
  },
});

describe('validateKitStructure', () => {
  it('accepts a valid Appendix A kit', () => {
    const result = validateKitStructure(buildValidKit());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('accepts numeric and label difficulties within 1-3', () => {
    const kit = buildValidKit();
    kit.questions[0].difficulty = 3;
    kit.questions[1].difficulty = 'hard';
    assert.equal(validateKitStructure(kit).valid, true);
  });

  it('reports every missing top-level section without throwing', () => {
    const result = validateKitStructure({});
    assert.equal(result.valid, false);
    const paths = result.errors.map((error) => error.path).sort();
    assert.deepEqual(paths, [
      '$.company_brief',
      '$.coverage',
      '$.flashcards',
      '$.questions',
      '$.role',
      '$.schedule',
      '$.source',
    ]);
    for (const error of result.errors) {
      assert.ok(error.path && error.message && error.code);
    }
  });

  it('rejects duplicate question ids', () => {
    const kit = buildValidKit();
    kit.questions[1].id = 'q1';
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'DUPLICATE_ID'));
  });

  it('rejects difficulty outside 1-3', () => {
    const kit = buildValidKit();
    kit.questions[0].difficulty = 5;
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.path === '$.questions[0].difficulty'));
  });

  it('rejects schedule ids that do not exist', () => {
    const kit = buildValidKit();
    kit.schedule.days[0].question_ids = ['missing-q'];
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'UNKNOWN_REFERENCE'));
  });

  it('rejects interviewDays outside 1-60', () => {
    const kit = buildValidKit();
    kit.schedule.interviewDays = 61;
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.path === '$.schedule.interviewDays'));
  });

  it('rejects requirement references that do not exist', () => {
    const kit = buildValidKit();
    kit.questions[0].requirementRefs = ['Unknown skill'];
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'UNKNOWN_REFERENCE'));
  });

  it('rejects flashcard question references that do not exist', () => {
    const kit = buildValidKit();
    kit.flashcards[0].questionIds = ['missing-q'];
    const result = validateKitStructure(kit);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.path.includes('$.flashcards[0]')));
  });
});
