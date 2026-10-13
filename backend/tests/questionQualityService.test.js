const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  reportQuestionQuality,
  findExactDuplicates,
  findNearDuplicates,
  findRedundantRequirementCoverage,
  findUnrelatedQuestions,
  findRepetitiveCategories,
  dropExactDuplicates,
  normalizeQuestionText,
} = require('../src/services/questionQualityService');

const question = (id, overrides = {}) => ({
  id,
  question: `Question ${id}`,
  category: 'technical',
  why: 'Because it matters for the role.',
  expectedAnswerPoints: [],
  followUps: [],
  sources: [],
  requirementRefs: ['Node.js'],
  ...overrides,
});

const codes = (report) => report.issues.map((issue) => issue.code);

describe('deterministic question quality checks', () => {
  it('reports a clean bank as ok', () => {
    const report = reportQuestionQuality({
      questions: [
        question('q1', { question: 'Explain the Node.js event loop phases.', requirementRefs: ['Node.js'] }),
        question('q2', { question: 'How do you model book documents in MongoDB?', category: 'role_specific', requirementRefs: ['MongoDB'] }),
        question('q3', { question: 'Describe how you designed REST APIs for a production service.', category: 'behavioral', requirementRefs: ['Design REST APIs'] }),
      ],
    });
    assert.deepEqual(report.issues, []);
    assert.equal(report.ok, true);
    assert.equal(report.summary.totalQuestions, 3);
  });

  it('detects duplicate questions regardless of punctuation and case', () => {
    const questions = [
      question('q1', { question: 'Explain the Node.js event loop.' }),
      question('q2', { question: 'Explain  the node.js event loop!!!' }),
    ];
    assert.deepEqual(findExactDuplicates(questions), ['q2']);
    const report = reportQuestionQuality({ questions });
    assert.ok(codes(report).includes('DUPLICATE_QUESTION'));
    assert.equal(normalizeQuestionText('Explain the Node.js event loop.'), normalizeQuestionText('explain the  node.js event loop!'));
  });

  it('detects near-duplicate questions', () => {
    const questions = [
      question('q1', { question: 'Explain the Node.js event loop phases.' }),
      question('q2', { question: 'Explain Node.js event loop phases and timers.' }),
    ];
    const pairs = findNearDuplicates(questions);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0].questionIds, ['q1', 'q2']);
    assert.ok(pairs[0].similarity >= 0.8);
    assert.ok(codes(reportQuestionQuality({ questions })).includes('NEAR_DUPLICATE_QUESTION'));
  });

  it('detects questions with identical requirement coverage in one category', () => {
    const groups = findRedundantRequirementCoverage([
      question('q1', { requirementRefs: ['Node.js', 'MongoDB'] }),
      question('q2', { requirementRefs: ['MongoDB', 'Node.js'] }),
      question('q3', { category: 'behavioral', requirementRefs: ['Node.js', 'MongoDB'] }),
    ]);
    assert.equal(groups.length, 1, 'a different category is a different coverage set');
    assert.deepEqual(groups[0].questionIds, ['q1', 'q2']);
    assert.ok(codes(reportQuestionQuality({ questions: [
      question('q1', { requirementRefs: ['Node.js'] }),
      question('q2', { requirementRefs: ['Node.js'] }),
    ] })).includes('REDUNDANT_REQUIREMENT_COVERAGE'));
  });

  it('detects questions that do not meaningfully cover their requirement', () => {
    const unrelated = findUnrelatedQuestions([
      question('q1', { question: 'Describe your favourite hobby outside work.', requirementRefs: ['MongoDB'] }),
      question('q2', { question: 'Explain how you index a MongoDB collection.', requirementRefs: ['MongoDB'] }),
      question('q3', { requirementRefs: [] }),
    ]);
    assert.deepEqual(unrelated.map((entry) => entry.questionId), ['q1']);
    assert.ok(codes(reportQuestionQuality({ questions: [
      question('q1', { question: 'Describe your favourite hobby outside work.', requirementRefs: ['MongoDB'] }),
    ] })).includes('UNRELATED_REQUIREMENT_COVERAGE'));
  });

  it('detects excessive repetition across a category', () => {
    const repetitive = findRepetitiveCategories([
      question('q1'), question('q2'), question('q3'), question('q4'),
      question('q5', { category: 'behavioral' }), question('q6', { category: 'behavioral' }),
    ]);
    assert.equal(repetitive.length, 1);
    assert.equal(repetitive[0].category, 'technical');
    assert.equal(repetitive[0].count, 4);
    // A small bank is never flagged, and a balanced bank is not flagged either.
    assert.deepEqual(findRepetitiveCategories([question('q1'), question('q2')]), []);
    assert.deepEqual(findRepetitiveCategories([
      question('q1'), question('q2', { category: 'behavioral' }), question('q3', { category: 'company' }),
    ]), []);
  });

  it('drops only exact duplicates and reports which ids were dropped', () => {
    const { kept, dropped } = dropExactDuplicates([
      question('q1', { question: 'Explain the Node.js event loop.' }),
      question('q2', { question: 'Explain  the Node.js event loop' }),
      question('q3', { question: 'How do you model book documents in MongoDB?' }),
    ]);
    assert.deepEqual(kept.map((item) => item.id), ['q1', 'q3']);
    assert.deepEqual(dropped, ['q2']);
  });

  it('requires an array of questions', () => {
    assert.throws(() => reportQuestionQuality({ questions: 'nope' }), /array/);
  });
});