const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const builder = require('../src/services/kitBuilderService');
const { regenerateKitSection } = require('../src/services/kitRegenerationService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');

// A complete, valid Appendix A kit with builder state:
// q1/q2 are generated technical questions, q3 is pinned, q4 was edited by the user.
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
      why: 'Core Node.js runtime knowledge.',
      expectedAnswerPoints: ['Loop phases', 'Microtasks'],
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
      why: 'Schema design trade-offs.',
      expectedAnswerPoints: ['Embed vs reference'],
      followUps: ['When would you embed?'],
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
      expectedAnswerPoints: ['STAR structure'],
      followUps: [],
      sources: [],
      requirementRefs: ['Node.js'],
      status: 'generated',
      pinned: true,
    },
    {
      id: 'q4',
      question: 'How would you debug a slow MongoDB query?',
      category: 'behavioral',
      difficulty: 3,
      why: 'User-tuned question.',
      expectedAnswerPoints: ['Explain plan'],
      followUps: [],
      sources: [],
      requirementRefs: ['MongoDB'],
      status: 'edited',
      pinned: false,
    },
  ],
  flashcards: [{ id: 'f1', front: 'Event loop', back: 'Async work.', questionIds: ['q1', 'q3'] }],
  schedule: {
    interviewDays: 2,
    days: [
      { day: 1, question_ids: ['q1', 'q2'] },
      { day: 2, question_ids: ['q3', 'q4'] },
    ],
  },
  coverage: {
    coveragePercent: 100,
    coveredRequirements: ['Node.js', 'MongoDB'],
    missingRequirements: [],
  },
});

const expectBuilderError = async (run, code) => {
  await assert.rejects(run, (error) => {
    assert.equal(error.name, 'KitBuilderError', `expected a KitBuilderError, got ${error.name}`);
    assert.equal(error.code, code);
    return true;
  });
};

const expectThrowsCode = (run, code) => {
  assert.throws(run, (error) => {
    assert.equal(error.name, 'KitBuilderError');
    assert.equal(error.code, code);
    return true;
  });
};

const generatedQuestion = (overrides = {}) => ({
  id: 'g1',
  question: 'Which Node.js concurrency primitive would you pick?',
  category: 'technical',
  difficulty: 'medium',
  why: 'Concurrency is core to the role.',
  expectedAnswerPoints: ['Worker threads'],
  followUps: [],
  sources: ['https://example.com/'],
  requirementRefs: ['Node.js'],
  ...overrides,
});

const idsOf = (questions) => questions.map((question) => question.id);

describe('kit builder metadata', () => {
  it('defaults questions to status generated and pinned false without destroying fields', () => {
    const question = { id: 'q1', question: 'Text', difficulty: 1, customField: 'keep me' };
    const normalized = builder.applyQuestionMetadata(question);
    assert.deepEqual(normalized, {
      id: 'q1',
      question: 'Text',
      difficulty: 1,
      customField: 'keep me',
      status: 'generated',
      pinned: false,
    });
    assert.equal(question.status, undefined); // the input object is never mutated
  });

  it('preserves explicit edited status and pinned flags', () => {
    const normalized = builder.applyQuestionMetadata({ id: 'q1', status: 'edited', pinned: true });
    assert.equal(normalized.status, 'edited');
    assert.equal(normalized.pinned, true);
  });

  it('normalizes every question of a kit and leaves non-kits untouched', () => {
    const kit = builder.applyKitQuestionMetadata(buildKit());
    assert.deepEqual(
      kit.questions.map((question) => [question.status, question.pinned]),
      [
        ['generated', false],
        ['generated', false],
        ['generated', true],
        ['edited', false],
      ]
    );
    assert.equal(builder.applyKitQuestionMetadata({ questions: 'nope' }).questions, 'nope');
  });

  it('carries stored status/pinned over a whole-kit PUT payload', () => {
    const stored = buildKit();
    const incoming = buildKit();
    incoming.questions = incoming.questions.map(({ status, pinned, ...rest }) => rest);
    const merged = builder.mergeStoredQuestionMetadata(stored, incoming);
    assert.equal(merged.questions[2].pinned, true);
    assert.equal(merged.questions[3].status, 'edited');
    assert.equal(merged.questions[0].status, undefined); // defaults applied afterwards
  });

  it('lets explicit PUT values win over stored metadata', () => {
    const stored = buildKit();
    const incoming = buildKit();
    incoming.questions[2] = { ...incoming.questions[2], pinned: false };
    incoming.questions[3] = { ...incoming.questions[3], status: 'generated' };
    const merged = builder.mergeStoredQuestionMetadata(stored, incoming);
    assert.equal(merged.questions[2].pinned, false);
    assert.equal(merged.questions[3].status, 'generated');
  });

  it('reads mongoose-style documents through toObject()', () => {
    const plain = builder.withBuilderMetadata({ toObject: () => buildKit() });
    assert.equal(plain.questions.length, 4);
    assert.deepEqual(
      plain.questions.map((question) => question.status),
      ['generated', 'generated', 'generated', 'edited']
    );
  });

  it('writes back only the Appendix A sections', () => {
    const picked = builder.pickKitSections({ ...buildKit(), _id: 'kit-1', userId: 'user-A', __v: 3 });
    assert.deepEqual(Object.keys(picked).sort(), [
      'company_brief',
      'coverage',
      'flashcards',
      'questions',
      'role',
      'schedule',
      'source',
    ]);
  });
});


describe('kit builder question editing', () => {
  it('marks the question edited and keeps id, pinned state, refs and sources', () => {
    const kit = buildKit();
    const original = kit.questions[0];
    const { kit: nextKit, question } = builder.editQuestion({
      kit,
      questionId: 'q1',
      changes: { question: 'Explain the event loop phases.', expectedAnswerPoints: ['Timers', 'Poll'] },
    });

    assert.equal(question.id, 'q1');
    assert.equal(question.status, 'edited');
    assert.equal(question.pinned, false);
    assert.equal(question.category, 'technical'); // untouched fields survive
    assert.deepEqual(question.requirementRefs, original.requirementRefs);
    assert.deepEqual(question.sources, original.sources);
    assert.equal(nextKit.questions[0].question, 'Explain the event loop phases.');
    assert.equal(nextKit.questions[1].question, 'How do you model data in MongoDB?');
    // every other question is returned untouched
    assert.equal(nextKit.questions[3].question, 'How would you debug a slow MongoDB query?');
    assert.equal(nextKit.questions[3].status, 'edited');
  });

  it('preserves the pinned flag of a pinned question while editing it', () => {
    const kit = buildKit();
    const { question } = builder.editQuestion({ kit, questionId: 'q3', changes: { why: 'Sharper reason.' } });
    assert.equal(question.pinned, true);
    assert.equal(question.status, 'edited');
  });

  it('accepts prompt/answerOutline aliases and persists canonical fields', () => {
    const kit = buildKit();
    const { question } = builder.editQuestion({
      kit,
      questionId: 'q2',
      changes: { prompt: 'How do you model documents?', answerOutline: ['Embed', 'Reference'] },
    });
    assert.equal(question.question, 'How do you model documents?');
    assert.deepEqual(question.expectedAnswerPoints, ['Embed', 'Reference']);
    assert.equal(question.prompt, undefined);
    assert.equal(question.answerOutline, undefined);
  });

  it('ignores id, status, pinned and userId in the payload', () => {
    const kit = buildKit();
    const { question } = builder.editQuestion({
      kit,
      questionId: 'q1',
      changes: { id: 'hacked', status: 'generated', pinned: true, userId: 'attacker', question: 'Edited text.' },
    });
    assert.equal(question.id, 'q1');
    assert.equal(question.status, 'edited');
    assert.equal(question.pinned, false);
    assert.equal(question.userId, undefined);
  });

  it('rejects edits of unknown questions with 404 semantics', () => {
    expectThrowsCode(
      () => builder.editQuestion({ kit: buildKit(), questionId: 'nope', changes: { question: 'x' } }),
      'QUESTION_NOT_FOUND'
    );
  });

  it('rejects payloads without editable fields', () => {
    expectThrowsCode(
      () => builder.editQuestion({ kit: buildKit(), questionId: 'q1', changes: { category: undefined } }),
      'BUILDER_NO_UPDATABLE_FIELDS'
    );
  });

  it('recomputes coverage when requirement references change', () => {
    const kit = buildKit();
    kit.role.requirements = [{ id: 'Node.js' }, { id: 'MongoDB' }, { id: 'Docker' }];
    kit.questions[3] = { ...kit.questions[3], requirementRefs: ['Docker'] };
    kit.coverage = { coveragePercent: 100, coveredRequirements: ['Node.js', 'MongoDB', 'Docker'], missingRequirements: [] };

    const { kit: nextKit } = builder.editQuestion({
      kit,
      questionId: 'q4',
      changes: { requirementRefs: ['Node.js'] },
    });
    assert.equal(nextKit.coverage.coveragePercent, 67);
    assert.deepEqual(nextKit.coverage.missingRequirements, ['Docker']);
  });
});


describe('kit builder reordering', () => {
  it('applies the new order without losing or duplicating questions', () => {
    const kit = buildKit();
    const { kit: nextKit } = builder.reorderQuestions({
      kit,
      questionIds: ['q4', 'q2', 'q1', 'q3'],
    });
    assert.deepEqual(idsOf(nextKit.questions), ['q4', 'q2', 'q1', 'q3']);
    assert.deepEqual(new Set(idsOf(nextKit.questions)), new Set(['q1', 'q2', 'q3', 'q4']));
    // content and builder metadata are not touched by a reorder
    assert.equal(nextKit.questions[0].question, 'How would you debug a slow MongoDB query?');
    assert.equal(nextKit.questions[0].status, 'edited');
    assert.equal(nextKit.questions[3].pinned, true);
  });

  it('keeps the schedule consistent with the new order and its day key', () => {
    const kit = buildKit();
    const { kit: nextKit } = builder.reorderQuestions({ kit, questionIds: ['q3', 'q1', 'q4', 'q2'] });
    assert.equal(nextKit.schedule.interviewDays, 2);
    const scheduled = nextKit.schedule.days.flatMap((day) => day.question_ids);
    assert.deepEqual(scheduled, ['q3', 'q1', 'q4', 'q2']);
    assert.equal(nextKit.schedule.days.length, 2);
  });

  it('keeps a "questions" schedule day key when that is what the kit uses', () => {
    const kit = buildKit();
    kit.schedule.days = [{ day: 1, questions: ['q1', 'q2'] }, { day: 2, questions: ['q3', 'q4'] }];
    const { kit: nextKit } = builder.reorderQuestions({ kit, questionIds: ['q2', 'q1', 'q4', 'q3'] });
    assert.deepEqual(nextKit.schedule.days, [
      { day: 1, questions: ['q2', 'q1'] },
      { day: 2, questions: ['q4', 'q3'] },
    ]);
  });

  it('rejects duplicate ids', () => {
    expectThrowsCode(
      () => builder.reorderQuestions({ kit: buildKit(), questionIds: ['q1', 'q2', 'q3', 'q3'] }),
      'BUILDER_DUPLICATE_QUESTION_IDS'
    );
  });

  it('rejects unknown ids', () => {
    expectThrowsCode(
      () => builder.reorderQuestions({ kit: buildKit(), questionIds: ['q1', 'q2', 'q3', 'q9'] }),
      'BUILDER_UNKNOWN_QUESTION_IDS'
    );
  });

  it('rejects orders that omit questions', () => {
    expectThrowsCode(
      () => builder.reorderQuestions({ kit: buildKit(), questionIds: ['q1', 'q2', 'q3'] }),
      'BUILDER_MISSING_QUESTION_IDS'
    );
  });

  it('rejects non-array orders and empty entries', () => {
    expectThrowsCode(() => builder.reorderQuestions({ kit: buildKit(), questionIds: 'q1' }), 'BUILDER_INVALID_ORDER');
    expectThrowsCode(
      () => builder.reorderQuestions({ kit: buildKit(), questionIds: ['q1', 'q2', 'q3', ''] }),
      'BUILDER_INVALID_ORDER'
    );
  });
});

describe('kit builder pin and unpin', () => {
  it('pins a question without changing its content or status', () => {
    const kit = buildKit();
    const before = kit.questions[0];
    const { question } = builder.setQuestionPinned({ kit, questionId: 'q1', pinned: true });
    assert.equal(question.pinned, true);
    assert.equal(question.status, 'generated');
    assert.deepEqual(question, { ...before, pinned: true });
  });

  it('unpins a pinned question', () => {
    const { question } = builder.setQuestionPinned({ kit: buildKit(), questionId: 'q3', pinned: false });
    assert.equal(question.pinned, false);
    assert.equal(question.status, 'generated');
  });

  it('keeps edited status while pinning', () => {
    const { question } = builder.setQuestionPinned({ kit: buildKit(), questionId: 'q4', pinned: true });
    assert.equal(question.pinned, true);
    assert.equal(question.status, 'edited');
  });

  it('rejects a non-boolean pinned value', () => {
    expectThrowsCode(
      () => builder.setQuestionPinned({ kit: buildKit(), questionId: 'q1', pinned: 'yes' }),
      'BUILDER_INVALID_PIN_PAYLOAD'
    );
    expectThrowsCode(
      () => builder.setQuestionPinned({ kit: buildKit(), questionId: 'q1', pinned: undefined }),
      'BUILDER_INVALID_PIN_PAYLOAD'
    );
  });

  it('rejects pinning an unknown question', () => {
    expectThrowsCode(
      () => builder.setQuestionPinned({ kit: buildKit(), questionId: 'q9', pinned: true }),
      'QUESTION_NOT_FOUND'
    );
  });
});


describe('kit builder regeneration inputs', () => {
  it('derives requirement ids and the generation inputs from the saved kit', () => {
    const kit = buildKit();
    assert.deepEqual(builder.requirementIdsFromKit(kit), ['Node.js', 'MongoDB']);
    assert.deepEqual(builder.builderRequirementsFrom(kit), {
      role: 'Junior Backend Developer',
      seniority: 'junior',
      mustHaveSkills: ['Node.js', 'MongoDB'],
    });
  });

  it('derives research from company_brief and only allows those URLs', () => {
    const kit = buildKit();
    const research = builder.builderResearchFrom(kit);
    assert.equal(research.companyTitle, 'Example Company');
    assert.deepEqual(research.sources, [
      { url: 'https://example.com/', title: 'Example Company', category: 'other', text: '' },
    ]);
    assert.deepEqual([...builder.allowedSourceUrls(kit)], ['https://example.com/']);
  });

  it('supports string requirement entries', () => {
    const kit = buildKit();
    kit.role.requirements = ['Node.js', 'MongoDB', 'Node.js'];
    assert.deepEqual(builder.requirementIdsFromKit(kit), ['Node.js', 'MongoDB']);
  });
});

describe('kit builder section regeneration', () => {
  it('replaces only generated, unpinned questions of the requested section', async () => {
    const kit = buildKit();
    const deps = {
      generateQuestions: async () => ({
        questions: [
          generatedQuestion({ id: 'q1', question: 'What is a Node.js stream?' }),
          generatedQuestion({ id: 'q2', question: 'How do indexes work in MongoDB?', requirementRefs: ['MongoDB'] }),
        ],
      }),
    };

    const { kit: nextKit, summary } = await regenerateKitSection({ kit, category: 'technical', deps });

    assert.deepEqual(summary.replacedQuestionIds, ['q1', 'q2']);
    assert.deepEqual(summary.replacementQuestionIds, ['q5', 'q6']);
    assert.equal(summary.preservedQuestionIds.length, 0);
    assert.deepEqual(idsOf(nextKit.questions), ['q5', 'q6', 'q3', 'q4']);
    assert.equal(nextKit.questions[0].question, 'What is a Node.js stream?');
    assert.equal(nextKit.questions[0].status, 'generated');
    assert.equal(nextKit.questions[0].pinned, false);
    assert.deepEqual(nextKit.questions[0].requirementRefs, ['Node.js']);
  });

  it('never overwrites pinned or edited content', async () => {
    const kit = buildKit();
    const pinned = kit.questions[2];
    const edited = kit.questions[3];
    const deps = {
      generateQuestions: async () => ({
        questions: [
          generatedQuestion(),
          generatedQuestion({ id: 'g2' }),
          // candidates for another section must be ignored entirely
          generatedQuestion({ id: 'g3', category: 'behavioral' }),
        ],
      }),
    };

    // "behavioral" holds only a pinned and an edited question -> structured refusal
    await expectBuilderError(
      regenerateKitSection({ kit, category: 'behavioral', deps }),
      'BUILDER_NO_REPLACEABLE_QUESTIONS'
    );

    const { kit: nextKit } = await regenerateKitSection({ kit, category: 'technical', deps });
    assert.deepEqual(nextKit.questions[2], pinned);
    assert.deepEqual(nextKit.questions[3], edited);
    assert.equal(nextKit.questions[3].status, 'edited');
  });

  it('refuses to regenerate a section without replaceable questions', async () => {
    let generateCalled = false;
    const deps = {
      generateQuestions: async () => {
        generateCalled = true;
        return { questions: [] };
      },
    };

    await expectBuilderError(
      regenerateKitSection({ kit: buildKit(), category: 'behavioral', deps }),
      'BUILDER_NO_REPLACEABLE_QUESTIONS'
    );
    assert.equal(generateCalled, false);
  });

  it('refuses when generation yields no usable questions for the section', async () => {
    const deps = {
      generateQuestions: async () => ({
        questions: [
          generatedQuestion({ category: 'behavioral' }),
          generatedQuestion({ requirementRefs: ['Invented requirement'] }),
          generatedQuestion({ question: '' }),
        ],
      }),
    };

    await expectBuilderError(
      regenerateKitSection({ kit: buildKit(), category: 'technical', deps }),
      'BUILDER_NO_REPLACEMENTS_GENERATED'
    );
  });
});


describe('kit builder regeneration safety', () => {
  it('restricts replacement sources to the kit company_brief URLs', async () => {
    const deps = {
      generateQuestions: async () => ({
        questions: [generatedQuestion({ sources: ['https://example.com/', 'https://made-up.example.org/'] })],
      }),
    };

    const { kit: nextKit } = await regenerateKitSection({ kit: buildKit(), category: 'technical', deps });
    assert.deepEqual(nextKit.questions[0].sources, ['https://example.com/']);
  });

  it('re-maps flashcard references and keeps the kit structurally valid', async () => {
    const deps = {
      generateQuestions: async () => ({
        questions: [generatedQuestion(), generatedQuestion({ id: 'g2', requirementRefs: ['MongoDB'] })],
      }),
    };

    const { kit: nextKit } = await regenerateKitSection({ kit: buildKit(), category: 'technical', deps });
    assert.deepEqual(nextKit.flashcards[0].questionIds, ['q5', 'q3']);
    assert.equal(validateKitStructure(nextKit).valid, true);

    const questionIds = new Set(idsOf(nextKit.questions));
    const scheduled = nextKit.schedule.days.flatMap((day) => day.question_ids);
    assert.equal(scheduled.every((id) => questionIds.has(id)), true);
    assert.deepEqual(new Set(scheduled), questionIds);
  });

  it('re-checks coverage and gap-fills when regeneration opened a gap', async () => {
    const kit = buildKit();
    // MongoDB is only referenced by q2, so replacing q2 with a Node.js question
    // opens a coverage gap that the existing gap-fill stage has to close.
    kit.questions[3] = { ...kit.questions[3], requirementRefs: ['Node.js'] };
    const gapFillCalls = [];
    const deps = {
      generateQuestions: async () => ({
        questions: [generatedQuestion(), generatedQuestion({ id: 'g2', requirementRefs: ['Node.js'] })],
      }),
      fillCoverageGaps: async (input) => {
        gapFillCalls.push(input);
        return {
          questions: [
            ...input.questions,
            generatedQuestion({ id: 'q5', question: 'How do you model MongoDB data?', requirementRefs: ['MongoDB'] }),
          ],
        };
      },
    };

    const { kit: nextKit, summary } = await regenerateKitSection({ kit, category: 'technical', deps });

    assert.equal(gapFillCalls.length, 1);
    assert.deepEqual(gapFillCalls[0].coverage.missingRequirements, ['MongoDB']);
    // the gap-fill id "q5" collides with a replacement id and is re-allocated
    assert.deepEqual(summary.gapFilledQuestionIds, ['q7']);
    assert.equal(summary.coverage.coveragePercent, 100);
    assert.equal(nextKit.coverage.coveragePercent, 100);
    assert.deepEqual(idsOf(nextKit.questions), ['q5', 'q6', 'q3', 'q4', 'q7']);
    assert.equal(new Set(idsOf(nextKit.questions)).size, nextKit.questions.length);
    assert.equal(validateKitStructure(nextKit).valid, true);
  });

  it('does not gap-fill when coverage is still complete', async () => {
    let gapFillCalled = false;
    const deps = {
      generateQuestions: async () => ({
        questions: [generatedQuestion(), generatedQuestion({ id: 'g2', requirementRefs: ['MongoDB'] })],
      }),
      fillCoverageGaps: async () => {
        gapFillCalled = true;
        return { questions: [] };
      },
    };

    const { kit: nextKit } = await regenerateKitSection({ kit: buildKit(), category: 'technical', deps });
    assert.equal(gapFillCalled, false);
    assert.equal(nextKit.coverage.coveragePercent, 100);
  });

  it('never persists an invalid regeneration result', async () => {
    const kit = buildKit();
    kit.questions[3] = { ...kit.questions[3], requirementRefs: ['Node.js'] }; // opens a MongoDB gap
    const deps = {
      generateQuestions: async () => ({
        questions: [generatedQuestion(), generatedQuestion({ id: 'g2', requirementRefs: ['Node.js'] })],
      }),
      // a broken gap-fill stage that invents a requirement reference
      fillCoverageGaps: async (input) => ({
        questions: [
          ...input.questions,
          generatedQuestion({ id: 'q5', question: 'Ghost reference.', requirementRefs: ['Ghost requirement'] }),
        ],
      }),
    };

    await expectBuilderError(
      regenerateKitSection({ kit, category: 'technical', deps }),
      'KIT_REGENERATION_VALIDATION_FAILED'
    );
  });

  it('reports generation failures as a structured error', async () => {
    const deps = {
      generateQuestions: async () => {
        throw new Error('Gemini API request failed: quota');
      },
    };

    await expectBuilderError(
      regenerateKitSection({ kit: buildKit(), category: 'technical', deps }),
      'KIT_REGENERATION_GENERATION_FAILED'
    );
  });

  it('requires a category', async () => {
    await expectBuilderError(regenerateKitSection({ kit: buildKit(), category: '  ' }), 'BUILDER_INVALID_SECTION');
    await expectBuilderError(regenerateKitSection({ kit: buildKit() }), 'BUILDER_INVALID_SECTION');
  });

  it('is deterministic: the same inputs produce the same kit', async () => {
    const buildDeps = () => ({
      generateQuestions: async () => ({
        questions: [
          generatedQuestion({ question: 'Deterministic one.' }),
          generatedQuestion({ id: 'g2', question: 'Deterministic two.', requirementRefs: ['MongoDB'] }),
        ],
      }),
    });

    const first = await regenerateKitSection({ kit: buildKit(), category: 'technical', deps: buildDeps() });
    const second = await regenerateKitSection({ kit: buildKit(), category: 'technical', deps: buildDeps() });
    assert.deepEqual(first.kit, second.kit);
    assert.deepEqual(first.summary, second.summary);
  });

  it('leaves the stored kit object untouched (no destructive mutation)', async () => {
    const kit = buildKit();
    const snapshot = JSON.parse(JSON.stringify(kit));
    const deps = { generateQuestions: async () => ({ questions: [generatedQuestion()] }) };

    await regenerateKitSection({ kit, category: 'technical', deps });
    assert.deepEqual(kit, snapshot);
  });
});

