const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generateInterviewPrepKit, buildFinalKit } = require('../src/services/interviewPrepPipelineService');
const { checkCoverage } = require('../src/services/coverageService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const builder = require('../src/services/kitBuilderService');
const { createKit } = require('../src/controllers/interviewPrepKitsController');
const InterviewPrepKit = require('../src/models/InterviewPrepKit');

const RESUME_TEXT = [
  'Sudhanshu Rao',
  'LibVerse: a library management platform built with Node.js, Express and MongoDB.',
  'Implemented JWT authentication with refresh tokens and role-based access control.',
  'React admin dashboard; Docker for local development.',
].join('\n');

const input = (overrides = {}) => ({
  jobRole: 'Backend Engineer',
  jobDescription: 'Backend engineer with Node.js, MongoDB and AWS.',
  companyUrl: 'https://example.com/',
  interviewDays: 3,
  ...overrides,
});

const jdQuestion = {
  id: 'q1',
  question: 'Explain the Node.js event loop.',
  category: 'technical',
  difficulty: 1,
  why: 'Core runtime knowledge.',
  expectedAnswerPoints: ['Phases'],
  followUps: [],
  sources: ['https://example.com/'],
  requirementRefs: ['Node.js'],
};

const jdDeps = (overrides = {}) => ({
  extractRequirements: async () => ({
    role: 'Backend Engineer',
    seniority: 'junior',
    mustHaveSkills: ['Node.js', 'MongoDB', 'AWS'],
    niceToHaveSkills: [],
    responsibilities: [],
    qualifications: [],
    interviewSignals: [],
  }),
  researchCompanyPipeline: async ({ companyUrl }) => ({
    companyUrl,
    companyTitle: 'Example',
    sources: [{ url: companyUrl, title: 'Example', text: 'Builds reliable software for engineering teams.' }],
  }),
  generateQuestions: async () => ({ questions: [{ ...jdQuestion }] }),
  fillCoverageGaps: async ({ questions, coverage }) => ({ questions, coverage }),
  ...overrides,
});

const resumeQuestion = {
  id: 'q2',
  question: 'Why did you choose MongoDB for LibVerse?',
  category: 'resume',
  difficulty: 'medium',
  why: 'Database trade-offs are a common follow-up.',
  expectedAnswerPoints: ['Schema flexibility'],
  followUps: [],
  sources: [],
  requirementRefs: ['MongoDB'],
};

const resumeDeps = (overrides = {}) =>
  jdDeps({
    analyzeResumeMatch: async () => ({
      matches: [
        { requirement: 'Node.js', status: 'matched', evidence: 'built with Node.js' },
        { requirement: 'MongoDB', status: 'matched', evidence: 'built with MongoDB' },
        { requirement: 'AWS', status: 'missing', evidence: null },
      ],
      matchedRequirements: ['Node.js', 'MongoDB'],
      partialRequirements: [],
      missingRequirements: ['AWS'],
      matchPercent: 67,
    }),
    generateResumeQuestions: async () => ({
      projects: ['LibVerse'],
      questions: [{ ...resumeQuestion }],
      summary: { generatedCount: 1, acceptedCount: 1, rejectedCount: 0, category: 'resume' },
    }),
    ...overrides,
  });

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

describe('JD-only pipeline stays unchanged', () => {
  it('returns exactly the established production response shape', async () => {
    const result = await generateInterviewPrepKit(input(), jdDeps());
    assert.deepEqual(Object.keys(result).sort(), ['coverage', 'questions', 'requirements', 'research', 'schedule']);
    assert.deepEqual(Object.keys(result.coverage).sort(), ['coveragePercent', 'coveredRequirements', 'missingRequirements']);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].category, 'technical');
  });

  it('never runs the resume stages without a resume', async () => {
    let resumeStages = 0;
    await generateInterviewPrepKit(input(), jdDeps({
      analyzeResumeMatch: async () => { resumeStages += 1; return {}; },
      generateResumeQuestions: async () => { resumeStages += 1; return { questions: [] }; },
    }));
    assert.equal(resumeStages, 0);
  });

  it('produces the same kit as before, without resume sections', async () => {
    const result = await generateInterviewPrepKit(input(), jdDeps());
    const kit = buildFinalKit(input(), result);
    assert.equal('resume' in kit, false);
    assert.equal('resume_analysis' in kit, false);
    assert.equal(JSON.stringify(kit).includes('LibVerse'), false);
    assert.equal(validateKitStructure(kit).valid, true, JSON.stringify(validateKitStructure(kit).errors));
  });
});

describe('resume-enabled pipeline', () => {
  const resumeInput = () => input({
    resume: { text: RESUME_TEXT, fileName: 'cv.pdf', fileType: 'pdf', charCount: RESUME_TEXT.length },
  });

  it('adds resume metadata and the grounded match analysis', async () => {
    const result = await generateInterviewPrepKit(resumeInput(), resumeDeps());
    assert.deepEqual(result.resume, { provided: true, fileName: 'cv.pdf', fileType: 'pdf', charCount: RESUME_TEXT.length });
    assert.deepEqual(result.resume_analysis.matchedRequirements, ['Node.js', 'MongoDB']);
    assert.deepEqual(result.resume_analysis.missingRequirements, ['AWS']);
    assert.deepEqual(result.resume_analysis.projects, ['LibVerse']);
    assert.equal(JSON.stringify(result.resume).includes('LibVerse'), false, 'no raw resume text in the metadata');
  });

  it('appends resume questions after the deterministic coverage check', async () => {
    const jdOnly = await generateInterviewPrepKit(input(), jdDeps());
    const withResume = await generateInterviewPrepKit(resumeInput(), resumeDeps());

    assert.deepEqual(withResume.questions.map((question) => question.id), ['q1', 'q2']);
    assert.equal(withResume.questions[1].category, 'resume');
    assert.deepEqual(withResume.questions[0], jdOnly.questions[0], 'JD questions are untouched');
    // Coverage is still derived from the JD questions only: the resume question
    // references MongoDB but must not silently change the coverage metric.
    assert.deepEqual(withResume.coverage, jdOnly.coverage);
    assert.equal(withResume.coverage.missingRequirements.includes('MongoDB'), true);
    assert.equal(withResume.coverage.missingRequirements.includes('AWS'), true);
    assert.equal(withResume.schedule.days.flatMap((day) => day.questions).includes('q2'), true);
  });

  it('keeps the kit valid and carries the resume sections through', async () => {
    const request = resumeInput();
    const kit = buildFinalKit(request, await generateInterviewPrepKit(request, resumeDeps()));
    assert.equal(kit.resume.provided, true);
    assert.equal(kit.resume_analysis.matchPercent, 67);
    assert.equal(kit.questions.length, 2);
    assert.equal(kit.flashcards.length, 2, 'resume questions get flashcards like every other question');
    assert.equal(kit.flashcards[1].questionIds[0], 'q2');
    const validation = validateKitStructure(kit);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));

    // Builder and practice writes must not drop the resume sections.
    const picked = builder.pickKitSections(kit);
    assert.equal(picked.resume.provided, true);
    assert.equal(picked.resume_analysis.matchPercent, 67);
  });

  it('never lets the raw resume text reach the kit', async () => {
    const request = resumeInput();
    const kit = buildFinalKit(request, await generateInterviewPrepKit(request, resumeDeps()));
    const serialized = JSON.stringify(kit);
    assert.equal(serialized.includes('refresh tokens'), false);
    assert.equal(serialized.includes('library management platform'), false);
  });
});

describe('resume sections in the kit validator', () => {
  const baseKit = () => buildFinalKit(input(), {
    requirements: { role: 'Backend Engineer', seniority: 'junior', mustHaveSkills: ['Node.js'] },
    research: { companyUrl: 'https://example.com/', companyTitle: 'Example', sources: [{ url: 'https://example.com/', title: 'Example', text: 'Builds software.' }] },
    questions: [{ ...jdQuestion, requirementRefs: ['Node.js'] }],
    coverage: { coveragePercent: 100, coveredRequirements: ['Node.js'], missingRequirements: [] },
    schedule: { interviewDays: 2, days: [{ day: 1, questions: ['q1'] }, { day: 2, questions: [] }] },
  });

  it('accepts a valid resume analysis and still accepts a legacy kit', () => {
    const kit = baseKit();
    assert.equal(validateKitStructure(kit).valid, true, 'a kit without resume sections stays valid');
    kit.resume = { provided: true, fileName: 'cv.pdf', fileType: 'pdf', charCount: 420 };
    kit.resume_analysis = {
      matchPercent: 50,
      matchedRequirements: ['Node.js'],
      partialRequirements: [],
      missingRequirements: ['AWS'],
      projects: ['LibVerse'],
      matches: [
        { requirement: 'Node.js', status: 'matched', evidence: 'built with Node.js' },
        { requirement: 'AWS', status: 'missing', evidence: null },
      ],
    };
    assert.equal(validateKitStructure(kit).valid, true, JSON.stringify(validateKitStructure(kit).errors));
  });

  it('rejects an unknown match status or malformed resume metadata', () => {
    const kit = baseKit();
    kit.resume = { provided: 'yes', fileType: 'docx', charCount: -1 };
    kit.resume_analysis = { matchPercent: 120, matches: [{ requirement: '', status: 'guessed', evidence: 42 }] };
    const codes = validateKitStructure(kit).errors.map((error) => error.code);
    for (const expected of ['INVALID_TYPE', 'INVALID_VALUE', 'MISSING_FIELD']) {
      assert.ok(codes.includes(expected), `${expected} should be reported, got ${JSON.stringify(codes)}`);
    }
  });

  it('keeps the evaluator-facing coverage schema untouched', () => {
    assert.deepEqual(
      Object.keys(checkCoverage({
        requirements: { role: 'Backend Engineer', mustHaveSkills: ['Node.js', 'AWS'] },
        questions: [{ id: 'q1', requirementRefs: ['Node.js'] }],
      })).sort(),
      ['coveragePercent', 'coveredRequirements', 'missingRequirements']
    );
  });
});

describe('resume text length is bounded by the single MAX_RESUME_TEXT_LENGTH limit', () => {
  const { MAX_RESUME_TEXT_LENGTH } = require('../src/services/resumeTextExtractor');
  const { MAX_TEXT_LENGTH } = require('../src/services/inputValidationService');

  // The generic per-field text cap that must NOT be used for resume text.
  const OLD_INCORRECT_LIMIT = MAX_TEXT_LENGTH;

  // Realistic, printable resume text of an exact character length. The repeated
  // sentence keeps printableRatioOf/countWordTokens happy, so the only variable
  // under test is the length bound itself.
  const resumeTextOfLength = (length) => {
    const unit = 'Owned Node.js and PostgreSQL services in production. ';
    let text = '';
    while (text.length < length) text += unit;
    return text.slice(0, length);
  };

  const requestWithResumeLength = (length) =>
    input({ resume: { text: resumeTextOfLength(length), fileName: 'cv.txt', fileType: 'text', charCount: length } });

  const runWith = (length) =>
    generateInterviewPrepKit(requestWithResumeLength(length), resumeDeps());

  it('uses the intended 40,000-character limit and never the generic text cap', () => {
    assert.equal(MAX_RESUME_TEXT_LENGTH, 40_000, 'the intended resume limit is unchanged');
    assert.equal(OLD_INCORRECT_LIMIT, 20_000, 'the generic cap is the one that was wrongly applied');
    assert.notEqual(MAX_RESUME_TEXT_LENGTH, OLD_INCORRECT_LIMIT);
  });

  it('accepts resume text at or below the old 20,000-character cap', async () => {
    const result = await runWith(20_000);
    assert.equal(result.resume.provided, true);
    assert.equal(result.resume.charCount, 20_000);
  });

  it('accepts resume text in the former 20,001-40,000 dead zone', async () => {
    for (const length of [20_001, 25_000, 30_000, 39_999, MAX_RESUME_TEXT_LENGTH]) {
      const result = await runWith(length);
      assert.equal(
        result.resume.charCount,
        length,
        `resume text of ${length} characters must pass pipeline input validation`
      );
      assert.equal(result.resume_analysis.matchPercent, 67, `resume stages still run at ${length}`);
    }
  });

  it('rejects resume text above the intended limit', async () => {
    await assert.rejects(
      () => runWith(MAX_RESUME_TEXT_LENGTH + 1),
      (error) => {
        assert.equal(error.name, 'Error');
        assert.equal(error.code, undefined);
        assert.equal(error.status, undefined);
        assert.equal(error.message, `resumeText must be a non-empty string no longer than ${MAX_RESUME_TEXT_LENGTH} characters.`);
        return true;
      }
    );
  });

  it('has no dead zone left: every length from 20,001 to 40,000 is accepted', async () => {
    // Walk the whole former dead zone plus the exact boundaries so a regression
    // anywhere inside it fails loudly rather than at the first bad value.
    const lengths = [20_001, 20_500, 21_000, 25_000, 30_000, 35_000, 39_000, 39_999, 40_000];
    for (const length of lengths) {
      assert.ok(
        length > OLD_INCORRECT_LIMIT && length <= MAX_RESUME_TEXT_LENGTH,
        `${length} must sit inside the former dead zone`
      );
      const result = await runWith(length);
      assert.equal(result.resume.charCount, length, `dead zone at ${length} characters is closed`);
    }
  });

  it('leaves the no-resume JD-only flow unchanged', async () => {
    const result = await generateInterviewPrepKit(input(), jdDeps());
    assert.deepEqual(Object.keys(result).sort(), ['coverage', 'questions', 'requirements', 'research', 'schedule']);
    assert.equal('resume' in result, false);
    assert.equal('resume_analysis' in result, false);
  });
});

describe('kits created with a resume through the CRUD controller', () => {
  it('stores the resume sections and returns them to the owner', async () => {
    const original = InterviewPrepKit.create;
    let stored = null;
    InterviewPrepKit.create = async (document) => {
      stored = document;
      return { ...document, _id: 'kit_1', toObject: () => document };
    };
    try {
      const kit = buildFinalKit(input(), {
        requirements: { role: 'Backend Engineer', seniority: 'junior', mustHaveSkills: ['Node.js'] },
        research: { companyUrl: 'https://example.com/', companyTitle: 'Example', sources: [{ url: 'https://example.com/', title: 'Example', text: 'Builds software.' }] },
        questions: [{ ...jdQuestion, requirementRefs: ['Node.js'] }],
        coverage: { coveragePercent: 100, coveredRequirements: ['Node.js'], missingRequirements: [] },
        schedule: { interviewDays: 2, days: [{ day: 1, questions: ['q1'] }, { day: 2, questions: [] }] },
      });
      kit.resume = { provided: true, fileName: 'cv.pdf', fileType: 'pdf', charCount: 420 };
      kit.resume_analysis = { matchPercent: 50, matchedRequirements: ['Node.js'], partialRequirements: [], missingRequirements: ['AWS'], projects: [], matches: [] };

      const res = mockResponse();
      await createKit({ body: kit, userId: 'user_123' }, res);
      assert.equal(res.statusCode, 201);
      assert.equal(stored.resume.provided, true);
      assert.equal(res.body.resume.fileName, 'cv.pdf');
      assert.equal(res.body.resume_analysis.matchPercent, 50);
    } finally {
      InterviewPrepKit.create = original;
    }
  });
});