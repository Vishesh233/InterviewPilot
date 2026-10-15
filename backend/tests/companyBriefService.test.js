const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { resetLlmCooldowns } = require('../src/services/geminiClient');
const { generateCompanyBrief, parseBrief, companyBriefFields } = require('../src/services/companyBriefService');
const { generateInterviewPrepKit, KIT_PIPELINE_STAGES } = require('../src/services/interviewPrepPipelineService');
const { kitFromPipeline } = require('../src/services/pipelineKitService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');

// Two-model chain; every test injects a scripted client, so no test can reach
// the network.
const TEST_ENV = {
  GEMINI_MODEL: 'model-a',
  GEMINI_FALLBACK_MODELS: 'model-b',
  GEMINI_THINKING: '',
  GEMINI_THINKING_OVERRIDES: '',
  LLM_MAX_RETRIES: '1',
  LLM_RETRY_BASE_MS: '0',
  LLM_COOLDOWN_MS: '60000',
};

const scriptedClient = (script) => {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (request) => {
        calls.push(request.model);
        const answer = script[request.model];
        if (answer instanceof Error) throw answer;
        return { text: answer ?? '{}' };
      },
    },
  };
};

const research = {
  companyUrl: 'https://vercel.com/',
  companyTitle: 'Agentic Infrastructure - Vercel',
  companyName: 'Vercel',
  sources: [{
    url: 'https://vercel.com/',
    title: 'Agentic Infrastructure - Vercel',
    description: 'The autonomous stack for every app and agent.',
    text: 'Deploy now Talk to sales Build agents on infrastructure that thinks like them.',
  }],
};

const GOOD_BRIEF = {
  about: 'Vercel provides a cloud platform for building and deploying web applications. Developers use its frameworks, workflows and infrastructure to ship frontend projects and AI features. The platform handles hosting, preview deployments and performance monitoring for engineering teams of every size and stage.',
  offerings: ['Hosting and deployment for web applications', 'Preview deployments for every code change', 'An SDK for building AI features'],
  roleRelevance: ['Next.js, React and Core Web Vitals in the job description are central to how Vercel customers build.'],
};

const providerError = () => Object.assign(new Error('Service Unavailable'), { status: 503 });

const briefArgs = (client) => ({ companyName: 'Vercel', research, jobRole: 'Frontend Developer', jobDescription: 'Frontend Developer working with Next.js and React.', client });

describe('structured company brief', () => {
  let savedEnv;
  let warnings;
  let originalWarn;
  let originalInfo;

  beforeEach(() => {
    savedEnv = Object.fromEntries(Object.keys(TEST_ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, TEST_ENV);
    resetLlmCooldowns();
    warnings = [];
    originalWarn = console.warn;
    originalInfo = console.info;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    console.info = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.info = originalInfo;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLlmCooldowns();
  });

  it('returns the validated brief from one model call', async () => {
    const client = scriptedClient({ 'model-a': JSON.stringify(GOOD_BRIEF) });
    const brief = await generateCompanyBrief(briefArgs(client));
    assert.deepEqual(brief, { ...GOOD_BRIEF, generated: true });
    assert.deepEqual(client.calls, ['model-a']);
  });

  it('falls back to the meta description when every model returns invalid output', async () => {
    const withCta = { ...GOOD_BRIEF, offerings: ['Deploy now and talk to sales', 'Preview deployments'] };
    const client = scriptedClient({ 'model-a': JSON.stringify(withCta), 'model-b': 'not json' });
    const brief = await generateCompanyBrief(briefArgs(client));
    assert.deepEqual(brief, { about: 'The autonomous stack for every app and agent.', offerings: [], roleRelevance: [], generated: false });
    assert.deepEqual(client.calls, ['model-a', 'model-b'], 'an invalid answer moves to the next model');
    assert.ok(warnings.some((line) => line.startsWith('Company brief: using the meta description fallback.')), 'the fallback is logged');
  });

  it('falls back to the meta description when the provider fails', async () => {
    const client = scriptedClient({ 'model-a': providerError(), 'model-b': providerError() });
    const brief = await generateCompanyBrief(briefArgs(client));
    assert.equal(brief.generated, false);
    assert.equal(brief.about, 'The autonomous stack for every app and agent.');
    assert.ok(warnings.some((line) => line.includes('Company brief: using the meta description fallback.')));
  });

  it('rejects navigation/CTA text, URLs, superlatives and out-of-range lengths', () => {
    const answer = (overrides) => JSON.stringify({ ...GOOD_BRIEF, ...overrides });
    assert.deepEqual(parseBrief(answer({})), GOOD_BRIEF);
    for (const bad of [
      { about: `${GOOD_BRIEF.about} Get started today.` },
      { about: `${GOOD_BRIEF.about.slice(0, -1)} at https://vercel.com.` },
      { about: 'Vercel is the industry-leading cloud. It is used by developers everywhere to deploy web apps quickly and safely across many regions worldwide today and every day of the year for everyone.' },
      { about: 'Vercel builds a platform for web apps. It is fast.' },
      { about: GOOD_BRIEF.about.replace(/\./g, ',') },
      { offerings: ['Only one offering'] },
      { offerings: ['One', 'Two', 'Three', 'Four'] },
      { offerings: ['A very long offering description that clearly goes past the twelve word limit set', 'Two'] },
      { roleRelevance: [] },
      { roleRelevance: ['Learn more about the role'] },
    ]) {
      assert.throws(() => parseBrief(answer(bad)), (error) => error.name === 'LlmError', JSON.stringify(bad).slice(0, 80));
    }
  });

  it('is its own checkpointed pipeline stage, skipped on resume', async () => {
    let briefCalls = 0;
    const deps = {
      extractRequirements: async () => ({ role: 'Frontend Developer', mustHaveSkills: ['React'], niceToHaveSkills: [], responsibilities: [], qualifications: [], interviewSignals: [] }),
      researchCompanyPipeline: async () => research,
      generateCompanyBrief: async () => { briefCalls += 1; return { ...GOOD_BRIEF, generated: true }; },
      generateQuestions: async () => ({ questions: [{ id: 'q1', question: 'React?', category: 'technical', difficulty: 'medium', why: 'w', expectedAnswerPoints: ['a'], followUps: [], sources: [], requirementRefs: ['React'] }] }),
      fillCoverageGaps: async ({ questions, coverage }) => ({ questions, coverage }),
    };
    const input = { jobRole: 'Frontend Developer', jobDescription: 'Frontend Developer building React apps with accessible UI.', companyUrl: 'https://vercel.com/', interviewDays: 2 };
    const checkpoints = {};
    const stages = [];
    const context = { checkpoints, onStage: async (stage) => { stages.push(stage); }, saveCheckpoint: async (stage, output) => { checkpoints[stage] = output; } };
    const result = await generateInterviewPrepKit(input, deps, context);
    assert.equal(briefCalls, 1);
    assert.deepEqual(stages.slice(0, 3), [KIT_PIPELINE_STAGES.EXTRACTION, KIT_PIPELINE_STAGES.RESEARCH, KIT_PIPELINE_STAGES.COMPANY_BRIEF]);
    assert.deepEqual(checkpoints['Company brief'], { ...GOOD_BRIEF, generated: true });

    await generateInterviewPrepKit(input, deps, { ...context, checkpoints: { ...checkpoints } });
    assert.equal(briefCalls, 1, 'a resumed job reuses the brief checkpoint');

    const kit = kitFromPipeline(input, result);
    assert.deepEqual(kit.company_brief, {
      name: 'Vercel',
      summary: GOOD_BRIEF.about,
      about: GOOD_BRIEF.about,
      offerings: GOOD_BRIEF.offerings,
      roleRelevance: GOOD_BRIEF.roleRelevance,
      sources: [{ url: 'https://vercel.com/', title: 'Agentic Infrastructure - Vercel' }],
    });
    const validation = validateKitStructure(kit);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });

  it('uses the fallback fields when a pipeline result carries no usable brief', () => {
    assert.deepEqual(companyBriefFields({ companyName: 'Vercel', companyBrief: { about: '' }, research }), {
      name: 'Vercel',
      summary: 'The autonomous stack for every app and agent.',
      about: 'The autonomous stack for every app and agent.',
      offerings: [],
      roleRelevance: [],
    });
  });
});
