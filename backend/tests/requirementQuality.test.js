const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('@google/genai');

const { refineRequirements, optionalSectionText } = require('../src/services/requirementPostProcessing');
const { extractRequirements, buildPrompt } = require('../src/services/requirementExtractionService');
const { kitFromPipeline } = require('../src/services/pipelineKitService');
const { buildFinalKit } = require('../src/services/interviewPrepPipelineService');
const { summarizeCompanyBrief } = require('../src/services/companyBriefSanitizer');
const { extractMetaDescription } = require('../src/services/companyResearchService');
const { researchCompanyPipeline } = require('../src/services/companyResearchPipelineService');
const { checkCoverage } = require('../src/services/coverageService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const { runCheckpointedStage } = require('../src/services/stageCheckpoint');
const { generateContent, resetLlmCooldowns } = require('../src/services/geminiClient');
const kitBuilderService = require('../src/services/kitBuilderService');

// ---- fixtures: the two JDs and the raw extractions of the last real run ----

const FRONTEND_JD = `Frontend Developer (React / Next.js) - Mid Level

Responsibilities:
- Build and maintain UI features in React and TypeScript with Next.js (App Router and server-side rendering).
- Write unit and integration tests with Jest and React Testing Library, and end-to-end tests with Playwright.
- Meet WCAG 2.1 AA accessibility: semantic HTML, keyboard navigation and screen-reader support.
- Improve performance: Core Web Vitals, code splitting, image optimization and bundle size.

Requirements:
- 3+ years of professional experience with React and modern JavaScript.
- Strong TypeScript, HTML and CSS skills.

Nice to have: Tailwind CSS, design systems, GraphQL.`;

const BACKEND_JD = `Backend Developer (Node.js) - Mid Level

Responsibilities:
- Design, build and maintain REST APIs with Node.js, Express and TypeScript.
- Model data in PostgreSQL and MongoDB, write efficient queries and manage migrations.
- Implement authentication and authorization with JWT and OAuth 2.0.
- Build background processing with message queues such as Redis or RabbitMQ.
- Containerize services with Docker and deploy them to AWS (ECS, Lambda, S3).
- Write unit and integration tests with Jest and keep CI pipelines green.

Requirements:
- 3+ years of professional backend experience with Node.js.
- Strong understanding of REST API design, HTTP and security best practices.
- Familiarity with Git and code reviews.

Nice to have:
- GraphQL
- Kubernetes
- Terraform`;

// What the model returned before this change (role metadata in the lists,
// Redis/RabbitMQ as nice-to-have, reworded interview signals).
const backendRawExtraction = () => ({
  role: 'Backend Developer',
  seniority: 'mid',
  mustHaveSkills: ['Backend Developer', 'Node.js', 'Express', 'TypeScript', 'PostgreSQL', 'MongoDB', 'JWT', 'OAuth 2.0', 'Docker', 'AWS', 'Jest', 'Git', 'REST API design', 'HTTP', 'security best practices'],
  niceToHaveSkills: ['Redis', 'RabbitMQ', 'GraphQL', 'Kubernetes', 'Terraform', 'node.js'],
  responsibilities: [
    'Design, build and maintain REST APIs with Node.js, Express and TypeScript',
    'Model data in PostgreSQL and MongoDB, write efficient queries and manage migrations',
    'Implement authentication and authorization with JWT and OAuth 2.0',
    'Build background processing with message queues such as Redis or RabbitMQ',
    'Containerize services with Docker and deploy them to AWS (ECS, Lambda, S3)',
    'Write unit and integration tests with Jest and keep CI pipelines green',
  ],
  qualifications: [
    '3+ years of professional backend experience with Node.js',
    'Strong understanding of REST API design, HTTP and security best practices',
    'Familiarity with Git and code reviews',
  ],
  interviewSignals: [
    'Ability to design and maintain REST APIs',
    'Proficiency in modeling data in PostgreSQL and MongoDB',
    'Experience implementing security protocols like JWT and OAuth 2.0',
    'Familiarity with deployment and containerization using AWS and Docker',
    'Experience with testing frameworks like Jest',
    'Calm, structured debugging under on-call pressure',
  ],
});

const frontendRawExtraction = () => ({
  role: 'Frontend Developer',
  seniority: 'Mid Level',
  mustHaveSkills: ['React', 'TypeScript', 'Next.js', 'Jest', 'React Testing Library', 'Playwright', 'WCAG', 'Core Web Vitals', 'HTML', 'CSS', 'Mid Level'],
  niceToHaveSkills: ['Tailwind CSS', 'design systems', 'GraphQL'],
  responsibilities: ['Build and maintain UI features in React and TypeScript with Next.js (App Router and server-side rendering).'],
  qualifications: ['3+ years of professional experience with React and modern JavaScript'],
  interviewSignals: [],
});

const allItems = (result) =>
  ['mustHaveSkills', 'niceToHaveSkills', 'responsibilities', 'qualifications', 'interviewSignals'].flatMap((field) => result[field]);

describe('requirement post-processing (deterministic)', () => {
  it('removes the job title, seniority and years-of-experience lines and keeps them as metadata', () => {
    const result = refineRequirements(frontendRawExtraction(), { jobDescription: FRONTEND_JD });
    const items = allItems(result);
    for (const metadata of ['Frontend Developer', 'Mid Level', '3+ years of professional experience with React and modern JavaScript']) {
      assert.equal(items.includes(metadata), false, `${metadata} must not be a requirement`);
    }
    assert.equal(result.role, 'Frontend Developer');
    assert.equal(result.seniority, 'Mid Level');
    assert.equal(result.yearsExperience, '3+ years');
  });

  it('removes plain seniority words and year ranges in any list', () => {
    const result = refineRequirements({
      role: null,
      seniority: null,
      mustHaveSkills: ['Senior', 'senior-level', 'Go'],
      niceToHaveSkills: [],
      responsibilities: [],
      qualifications: ['3-5 years in fintech', '5 or more years of Go'],
      interviewSignals: ['Junior'],
    });
    assert.deepEqual(allItems(result), ['Go']);
    assert.equal(result.yearsExperience, '3–5 years');
  });

  it('keeps an explicitly stated yearsExperience over one found in the lists', () => {
    const result = refineRequirements({ ...frontendRawExtraction(), yearsExperience: '3+ years of React' });
    assert.equal(result.yearsExperience, '3+ years of React');
  });

  it('keeps every named tool as its own requirement', () => {
    const result = refineRequirements(frontendRawExtraction(), { jobDescription: FRONTEND_JD });
    for (const tool of ['Next.js', 'Jest', 'React Testing Library', 'Playwright', 'WCAG', 'Core Web Vitals']) {
      assert.ok(result.mustHaveSkills.includes(tool), tool);
    }
  });

  it('moves items the JD lists under responsibilities from nice-to-have to required', () => {
    const result = refineRequirements(backendRawExtraction(), { jobDescription: BACKEND_JD });
    assert.ok(result.mustHaveSkills.includes('Redis'));
    assert.ok(result.mustHaveSkills.includes('RabbitMQ'));
    assert.deepEqual(result.niceToHaveSkills, ['GraphQL', 'Kubernetes', 'Terraform']);
  });

  it('keeps nice-to-have items from an inline nice-to-have line', () => {
    const result = refineRequirements(frontendRawExtraction(), { jobDescription: FRONTEND_JD });
    assert.deepEqual(result.niceToHaveSkills, ['Tailwind CSS', 'design systems', 'GraphQL']);
  });

  it('drops interview signals and qualifications that only reword other requirements, and exact duplicates', () => {
    const raw = backendRawExtraction();
    const result = refineRequirements(raw, { jobDescription: BACKEND_JD });
    assert.deepEqual(result.interviewSignals, ['Calm, structured debugging under on-call pressure']);
    assert.equal(result.qualifications.includes('Strong understanding of REST API design, HTTP and security best practices'), false);
    assert.ok(result.qualifications.includes('Familiarity with Git and code reviews'), 'code reviews adds something');
    assert.equal(result.niceToHaveSkills.includes('node.js'), false, 'case-insensitive duplicate of Node.js');
    assert.ok(allItems(result).length < allItems(raw).length);
    assert.equal(new Set(allItems(result).map((item) => item.toLowerCase())).size, allItems(result).length);
  });

  it('is idempotent', () => {
    const once = refineRequirements(backendRawExtraction(), { jobDescription: BACKEND_JD });
    const twice = refineRequirements(once, { jobDescription: BACKEND_JD });
    assert.deepEqual(twice, once);
  });

  it('finds bulleted and inline optional sections only', () => {
    const text = optionalSectionText(BACKEND_JD);
    assert.match(text, /graphql/);
    assert.match(text, /terraform/);
    assert.doesNotMatch(text, /redis/);
  });
});

describe('requirement extraction with a mocked LLM', () => {
  const fakeClient = (payload) => ({ models: { generateContent: async () => ({ text: JSON.stringify(payload) }) } });

  it('asks for named tools, role metadata and strict nice-to-have rules', () => {
    const prompt = buildPrompt('JD');
    assert.match(prompt, /Next\.js", "Jest", "React Testing Library", "Playwright", "WCAG", "Core Web Vitals", "Git"/);
    assert.match(prompt, /role metadata, NOT requirements/);
    assert.match(prompt, /ONLY items the description explicitly marks as nice to have/);
    assert.match(prompt, /never reword an existing item/);
  });

  it('runs the deterministic clean-up on the model output', async () => {
    const result = await extractRequirements({
      jobDescription: BACKEND_JD,
      client: fakeClient({ ...backendRawExtraction(), yearsExperience: null }),
    });
    assert.equal(result.yearsExperience, '3+ years');
    assert.equal(allItems(result).includes('Backend Developer'), false);
    assert.ok(result.mustHaveSkills.includes('Redis'));
  });
});

describe('kits built with the new requirement shape', () => {
  const research = {
    companyUrl: 'https://example.com/',
    companyTitle: 'Example',
    sources: [{
      url: 'https://example.com/',
      title: 'Example',
      description: 'Example builds developer tools for fast, accessible web apps.',
      text: 'Get a Demo Log In Sign Up Dashboard Products Agent Stack AI SDK AI Gateway Sandbox Docs About Blog Pricing Example powers millions of deployments every day.',
    }],
  };
  const requirements = refineRequirements(frontendRawExtraction(), { jobDescription: FRONTEND_JD });
  const question = (id, refs) => ({
    id, category: 'technical', difficulty: 'medium', question: `Question ${id}?`, why: 'w',
    expectedAnswerPoints: ['a'], followUps: [], sources: [], requirementRefs: refs,
  });
  const questions = [question('q1', ['Next.js', 'Jest']), question('q2', ['WCAG'])];
  const pipelineResult = {
    requirements,
    research,
    questions,
    coverage: checkCoverage({ requirements, questions }),
    schedule: { interviewDays: 2, days: [{ day: 1, question_ids: ['q1'] }, { day: 2, question_ids: ['q2'] }] },
  };
  const input = { jobRole: 'Frontend Developer', jobDescription: FRONTEND_JD, companyUrl: 'https://example.com/', interviewDays: 2 };

  for (const [name, build] of [['web/job path (kitFromPipeline)', kitFromPipeline], ['evaluation path (buildFinalKit)', buildFinalKit]]) {
    it(`${name}: role metadata in the header fields, never in requirements, and a valid kit`, () => {
      const kit = build(input, pipelineResult);
      assert.equal(kit.role.title, 'Frontend Developer');
      assert.equal(kit.role.level, 'Mid Level');
      assert.equal(kit.role.yearsExperience, '3+ years');
      const ids = kit.role.requirements.map((entry) => entry.id);
      for (const metadata of ['Frontend Developer', 'Mid Level']) assert.equal(ids.includes(metadata), false, metadata);
      assert.deepEqual([...kit.coverage.coveredRequirements, ...kit.coverage.missingRequirements].sort(), [...ids].sort());
      const validation = validateKitStructure(kit);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    });

    it(`${name}: the company brief leads with the meta description and drops navigation runs`, () => {
      const kit = build(input, pipelineResult);
      assert.equal(
        kit.company_brief.summary,
        'Example builds developer tools for fast, accessible web apps. Example powers millions of deployments every day.'
      );
      assert.doesNotMatch(kit.company_brief.summary, /Log In|Sign Up|Pricing/);
    });
  }

  it('both paths produce the same company brief summary', () => {
    assert.equal(kitFromPipeline(input, pipelineResult).company_brief.summary, buildFinalKit(input, pipelineResult).company_brief.summary);
  });

  it('builder coverage (gaps / regenerate) ignores the title and level for new kits', () => {
    const kit = kitFromPipeline(input, pipelineResult);
    const recomputed = kitBuilderService.withRecomputedCoverage(kit, kit.questions).coverage;
    const reported = [...recomputed.coveredRequirements, ...recomputed.missingRequirements];
    assert.equal(reported.includes('Frontend Developer'), false);
    assert.equal(reported.includes('Mid Level'), false);
    assert.equal(reported.length, kit.role.requirements.length);
  });

  it('an old kit that stored the title and level as requirements still validates and keeps them in coverage', () => {
    const oldKit = {
      ...kitFromPipeline(input, pipelineResult),
      role: {
        title: 'Frontend Developer',
        level: 'Mid Level',
        requirements: [{ id: 'Frontend Developer', kind: 'role' }, { id: 'Next.js', kind: 'must_have' }, { id: 'Mid Level', kind: 'seniority' }],
      },
    };
    oldKit.questions = [question('q1', ['Next.js', 'Frontend Developer'])];
    oldKit.flashcards = [];
    oldKit.schedule = { interviewDays: 1, days: [{ day: 1, question_ids: ['q1'] }] };
    const recomputed = kitBuilderService.withRecomputedCoverage(oldKit, oldKit.questions).coverage;
    assert.deepEqual(recomputed.coveredRequirements, ['Frontend Developer', 'Next.js']);
    assert.deepEqual(recomputed.missingRequirements, ['Mid Level']);
    const validation = validateKitStructure({ ...oldKit, coverage: recomputed });
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
});

describe('company brief summary', () => {
  it('keeps prose and drops a navigation-like run with no description', () => {
    const summary = summarizeCompanyBrief({
      text: 'Home Products Solutions Pricing Docs Blog Careers Log In Sign Up. Acme builds payment APIs for marketplaces. Features Global Delivery Web Application Firewall Custom SSL Host platforms that serve every customer with Acme.',
    });
    assert.equal(summary, 'Acme builds payment APIs for marketplaces. Host platforms that serve every customer with Acme.');
  });

  it('falls back to the sanitized text when there is no prose sentence', () => {
    assert.equal(summarizeCompanyBrief({ text: 'Acme Payments Platform' }), 'Acme Payments Platform');
    assert.equal(summarizeCompanyBrief({ text: 'Home | About | Careers | Contact Us' }), '');
  });

  it('reads the meta description, preferring name=description over og:description', () => {
    const html = '<head><meta property="og:description" content="OG text that is long enough."><meta content="Acme builds payment APIs &amp; tools." name="description"></head>';
    assert.equal(extractMetaDescription(html), 'Acme builds payment APIs & tools.');
    assert.equal(extractMetaDescription('<meta property="og:description" content="Only OG here.">'), 'Only OG here.');
    assert.equal(extractMetaDescription('<title>x</title>'), null);
  });

  it('carries the homepage description through company research', async () => {
    const result = await researchCompanyPipeline({ companyUrl: 'https://example.com/' }, {
      researchCompany: async () => ({ companyUrl: 'https://example.com/', title: 'Example', description: 'Example builds tools.', text: 'Example builds tools for teams.', html: '' }),
    });
    assert.equal(result.sources[0].description, 'Example builds tools.');
  });
});

describe('LLM log lines name the real stage and the real fallback target', () => {
  const TEST_ENV = {
    GEMINI_MODEL: 'primary-model',
    GEMINI_FALLBACK_MODELS: 'fallback-a,fallback-b',
    GEMINI_THINKING: '',
    GEMINI_THINKING_OVERRIDES: '',
    LLM_MAX_RETRIES: '0',
    LLM_RETRY_BASE_MS: '0',
    LLM_COOLDOWN_MS: '60000',
  };
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
  const scripted = (script) => ({
    calls: [],
    models: {
      generateContent: async function generate(request) {
        this.calls?.push(request.model);
        const outcome = (script[request.model] || []).shift();
        if (outcome instanceof Error) throw outcome;
        return { text: '{"ok":true}' };
      },
    },
  });

  it('uses the stage of the surrounding pipeline stage', async () => {
    const client = scripted({});
    await runCheckpointedStage(undefined, 'Requirement extraction', {
      isValid: () => true,
      run: () => generateContent({ contents: 'x', client }),
    });
    assert.equal(lines('LLM attempt succeeded.')[0].stage, 'Requirement extraction');
    await generateContent({ contents: 'x', client, stage: 'Explicit stage' });
    assert.equal(lines('LLM attempt succeeded.')[1].stage, 'Explicit stage');
    await generateContent({ contents: 'x', client });
    assert.equal(lines('LLM attempt succeeded.')[2].stage, null, 'outside any stage');
  });

  it('names the next model that is actually attempted, and logs the cooldown skip separately', async () => {
    const notFound = () => new ApiError({ message: 'model not found', status: 404 });
    const overloaded = () => new ApiError({ message: 'overloaded', status: 503 });
    // Call 1: primary 404 (no cooldown), fallback-a 503 (enters cooldown), fallback-b answers.
    const client = scripted({ 'primary-model': [notFound(), notFound()], 'fallback-a': [overloaded()] });
    await generateContent({ contents: 'first', client });
    logs.length = 0;

    // Call 2: primary 404 again; fallback-a is in cooldown, so fallback-b is next.
    await generateContent({ contents: 'second', client, stage: 'Question generation' });
    assert.deepEqual(lines('LLM fallback.'), [
      { from: 'gemini:primary-model', to: 'gemini:fallback-b', reason: 'model_not_found', stage: 'Question generation' },
    ]);
    assert.deepEqual(lines('LLM model skipped.').map((line) => [line.model, line.action]), [['fallback-a', 'cooldown-skip']]);
  });
});
