const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateContent, resetLlmCooldowns, LlmError } = require('../src/services/geminiClient');
const { generateQuestions } = require('../src/services/questionGenerationService');
const { extractRequirements } = require('../src/services/requirementExtractionService');
const { fillCoverageGaps } = require('../src/services/gapFillService');
const { regenerateKitSection } = require('../src/services/kitRegenerationService');

// Three-model chain; every test injects a scripted client, so the chain is
// limited to injected clients and no test can reach the network.
const TEST_ENV = {
  GEMINI_MODEL: 'model-a',
  GEMINI_FALLBACK_MODELS: 'model-b,model-c',
  GEMINI_THINKING: '',
  GEMINI_THINKING_OVERRIDES: '',
  LLM_MAX_RETRIES: '2',
  LLM_RETRY_BASE_MS: '0',
  LLM_COOLDOWN_MS: '60000',
};

// Each model answers with its scripted text (the last entry repeats).
const scriptedClient = (script) => {
  const calls = [];
  const counts = {};
  return {
    calls,
    models: {
      generateContent: async (request) => {
        calls.push(request.model);
        const answers = script[request.model] || ['{}'];
        const index = Math.min(counts[request.model] || 0, answers.length - 1);
        counts[request.model] = (counts[request.model] || 0) + 1;
        return { text: answers[index] };
      },
    },
  };
};

const question = (overrides = {}) => ({
  question: 'Which Node.js concurrency primitive would you pick?',
  category: 'technical',
  difficulty: 'medium',
  why: 'Concurrency is core to the role.',
  expectedAnswerPoints: ['Worker threads'],
  followUps: [],
  sources: [],
  requirementRefs: ['Node.js'],
  ...overrides,
});
const questionsJson = (...items) => JSON.stringify({ questions: items });

describe('unusable model output falls back to the next model', () => {
  let logs;
  let savedEnv;
  const originals = {};

  beforeEach(() => {
    savedEnv = Object.fromEntries(Object.keys(TEST_ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, TEST_ENV);
    resetLlmCooldowns();
    logs = [];
    for (const level of ['warn', 'info']) {
      originals[level] = console[level];
      console[level] = (...args) => { logs.push(args.join(' ')); };
    }
  });

  afterEach(() => {
    for (const level of ['warn', 'info']) console[level] = originals[level];
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLlmCooldowns();
  });

  const lines = (prefix) => logs.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));

  it('moves to model B when model A returns unusable output, without a same-model retry, and logs stage + reason', async () => {
    const client = scriptedClient({ 'model-a': ['{"questions":[]}'], 'model-b': [questionsJson(question())] });
    const result = await generateQuestions({
      requirements: { role: 'Engineer', mustHaveSkills: ['Node.js'] },
      research: { sources: [] },
      client,
      stage: undefined,
    });
    assert.equal(result.questions.length, 1);
    assert.deepEqual(client.calls, ['model-a', 'model-b'], 'no retry on model A');
    const [unusable] = lines('LLM output unusable.');
    assert.equal(unusable.model, 'model-a');
    assert.equal(unusable.classification, 'bad_output');
    assert.equal(unusable.reason, 'LLM_NO_USABLE_ITEMS');
    assert.equal(unusable.action, 'fallback');
    assert.deepEqual(lines('LLM fallback.'), [{ from: 'gemini:model-a', to: 'gemini:model-b', reason: 'bad_output', stage: null }]);
    assert.equal(lines('LLM attempt succeeded.')[0].model, 'model-b');
  });

  it('logs the real stage on a bad-output fallback', async () => {
    const client = scriptedClient({ 'model-a': ['not json'], 'model-b': ['{"ok":true}'] });
    const result = await generateContent({
      contents: 'x',
      client,
      stage: 'Requirement extraction',
      acceptOutput: (text) => {
        try { return JSON.parse(text); } catch (error) { throw new LlmError('LLM_INVALID_JSON', 'The model returned malformed or truncated JSON.', 502); }
      },
    });
    assert.deepEqual(result.value, { ok: true });
    assert.equal(lines('LLM output unusable.')[0].stage, 'Requirement extraction');
    assert.equal(lines('LLM output unusable.')[0].reason, 'LLM_INVALID_JSON');
  });

  it('falls back for requirement extraction on invalid JSON', async () => {
    const valid = JSON.stringify({
      role: 'Engineer', seniority: null, yearsExperience: null, mustHaveSkills: ['Node.js'],
      niceToHaveSkills: [], responsibilities: [], qualifications: [], interviewSignals: [],
    });
    const client = scriptedClient({ 'model-a': ['{"role":'], 'model-b': [valid] });
    const result = await extractRequirements({ jobDescription: 'We need a Node.js engineer to build APIs.', client });
    assert.deepEqual(result.mustHaveSkills, ['Node.js']);
    assert.deepEqual(client.calls, ['model-a', 'model-b']);
  });

  it('fails with a clear, actionable error only after every model returned unusable output', async () => {
    const client = scriptedClient({ 'model-a': ['   '], 'model-b': ['not json'], 'model-c': ['{"questions":[{"question":"x"}]}'] });
    await assert.rejects(
      () => generateQuestions({ requirements: { role: 'Engineer', mustHaveSkills: ['Node.js'] }, research: { sources: [] }, client }),
      (error) => {
        assert.equal(error.code, 'LLM_NO_USABLE_OUTPUT');
        assert.equal(error.causeCode, 'LLM_INVALID_STRUCTURE', 'the last model\'s problem is kept');
        assert.equal(error.isPublic, true);
        assert.match(error.message, /try again in a minute/);
        return true;
      }
    );
    assert.deepEqual(client.calls, ['model-a', 'model-b', 'model-c']);
    assert.deepEqual(lines('LLM output unusable.').map((line) => [line.model, line.reason, line.action]), [
      ['model-a', 'LLM_EMPTY_RESPONSE', 'fallback'],
      ['model-b', 'LLM_INVALID_JSON', 'fallback'],
      ['model-c', 'LLM_INVALID_STRUCTURE', 'give-up'],
    ]);
  });

  it('keeps the existing questions (gaps stay visible) when no model can fill a gap', async () => {
    const existing = [{ id: 'q1', ...question() }];
    // A valid gap question that only duplicates an existing one is dropped, so
    // each answer adds nothing usable.
    const duplicate = questionsJson(question({ requirementRefs: ['MongoDB'] }));
    const client = scriptedClient({ 'model-a': [duplicate], 'model-b': [duplicate], 'model-c': [duplicate] });
    const result = await fillCoverageGaps({
      requirements: { role: 'Engineer', mustHaveSkills: ['Node.js', 'MongoDB'] },
      research: { sources: [] },
      questions: existing,
      coverage: { coveredRequirements: ['Node.js'], missingRequirements: ['MongoDB'], coveragePercent: 50 },
      client,
    });
    assert.deepEqual(client.calls, ['model-a', 'model-b', 'model-c'], 'every model was tried');
    assert.deepEqual(result.questions, existing);
    assert.deepEqual(result.coverage.missingRequirements, ['MongoDB']);
  });

  describe('section regenerate', () => {
    const kit = () => ({
      source: { jobDescription: 'Backend Developer with Node.js and MongoDB.', companyUrl: 'https://example.com/' },
      company_brief: { name: 'Example', summary: 'Builds software.', sources: [{ url: 'https://example.com/', title: 'Example' }] },
      role: { title: 'Backend Developer', requirements: [{ id: 'Node.js' }, { id: 'MongoDB' }] },
      questions: [
        { id: 'q1', ...question({ requirementRefs: ['Node.js', 'MongoDB'] }), status: 'generated', pinned: false },
        { id: 'q2', ...question({ category: 'behavioral', question: 'Describe a hard production incident you owned.', requirementRefs: ['Node.js'] }), status: 'generated', pinned: false },
      ],
      flashcards: [{ id: 'f1', front: 'x', back: 'y', questionIds: ['q1'] }, { id: 'f2', front: 'x', back: 'y', questionIds: ['q2'] }],
      schedule: { interviewDays: 2, days: [{ day: 1, question_ids: ['q1'] }, { day: 2, question_ids: ['q2'] }] },
      coverage: { coveredRequirements: ['Node.js', 'MongoDB'], missingRequirements: [], coveragePercent: 100 },
    });
    const behavioral = question({ category: 'behavioral', question: 'Tell me about a time you improved an on-call process.', requirementRefs: ['Node.js', 'MongoDB'] });
    const wrongCategory = questionsJson(question({ requirementRefs: ['Node.js', 'MongoDB'] }), question({ category: 'role_specific', requirementRefs: ['MongoDB'] }));
    const deps = (client, prompts) => ({
      generateQuestions: (args) => { prompts.push(args.category); return generateQuestions({ ...args, client }); },
      fillCoverageGaps: async ({ questions, coverage }) => ({ questions, coverage, droppedDuplicateQuestionIds: [] }),
    });

    it('asks for the section category and falls back when model A answers in the wrong category', async () => {
      const client = scriptedClient({ 'model-a': [wrongCategory], 'model-b': [questionsJson(behavioral)] });
      const prompts = [];
      const { kit: next } = await regenerateKitSection({ kit: kit(), category: 'behavioral', deps: deps(client, prompts) });
      assert.deepEqual(prompts, ['behavioral']);
      assert.deepEqual(client.calls, ['model-a', 'model-b']);
      const regenerated = next.questions.filter((item) => item.category === 'behavioral');
      assert.equal(regenerated.length, 1);
      assert.equal(regenerated[0].question, behavioral.question);
      // Only the behavioral section changed: the technical q1 is untouched.
      assert.deepEqual(next.questions.find((item) => item.id === 'q1')?.question, kit().questions[0].question);
      assert.equal(lines('LLM output unusable.')[0].detail, 'The model returned no usable "behavioral" questions.');
    });

    it('fails with REGENERATE_NO_USABLE_QUESTIONS and a next step when every model answers in the wrong category', async () => {
      const client = scriptedClient({ 'model-a': [wrongCategory], 'model-b': [wrongCategory], 'model-c': [wrongCategory] });
      await assert.rejects(
        () => regenerateKitSection({ kit: kit(), category: 'behavioral', deps: deps(client, []) }),
        (error) => {
          assert.equal(error.code, 'REGENERATE_NO_USABLE_QUESTIONS');
          assert.match(error.message, /no usable "behavioral" questions.*try again in a minute/);
          return true;
        }
      );
      assert.deepEqual(client.calls, ['model-a', 'model-b', 'model-c']);
    });
  });
});
