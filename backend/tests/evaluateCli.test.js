const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const evaluator = require('../scripts/evaluate');
const { BATCH_FIXTURE_CONTEXT } = require('../src/services/batchFixtureContext');
const { generateInterviewPrepKit, buildFinalKit } = require('../src/services/interviewPrepPipelineService');
const { researchCompanyPipeline } = require('../src/services/companyResearchPipelineService');
const { researchCompany } = require('../src/services/companyResearchService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const { assertSafeUrl } = require('../src/services/urlSecurityService');

const validCase = (overrides = {}) => ({
  id: 'case-01',
  jd: 'Senior Backend Engineer with Node.js, MongoDB, and API design experience.',
  company_url: 'https://example.com',
  days: 2,
  ...overrides,
});

const validQuestion = (overrides = {}) => ({
  id: 'q1',
  question: 'Explain the Node.js event loop.',
  category: 'technical',
  difficulty: 'medium',
  why: 'Node.js is a required skill.',
  expectedAnswerPoints: ['Event-loop phases'],
  followUps: [],
  sources: [],
  requirementRefs: ['Node.js'],
  ...overrides,
});

const validKit = (input = validCase(), overrides = {}) => {
  const normalized = input.company_url
    ? input
    : { jd: input.jobDescription, company_url: input.companyUrl, days: input.interviewDays };
  return {
    source: {
      jobDescription: normalized.jd,
      companyUrl: normalized.company_url,
      interviewDays: normalized.days,
    },
    company_brief: {
      name: 'Example',
      summary: 'Builds software products.',
      sources: [{ url: normalized.company_url, title: 'Example' }],
    },
    role: {
      title: 'Backend Engineer',
      level: 'senior',
      requirements: [{ id: 'Node.js' }],
    },
    questions: [validQuestion()],
    flashcards: [{ id: 'f1', front: 'Node.js event loop', back: 'Event-loop phases.', questionIds: ['q1'] }],
    schedule: {
      interviewDays: normalized.days,
      days: [
        { day: 1, questions: ['q1'] },
        ...Array.from({ length: Math.max(0, normalized.days - 1) }, (_, index) => ({ day: index + 2, questions: [] })),
      ],
    },
    coverage: {
      coveragePercent: 100,
      coveredRequirements: ['Node.js'],
      missingRequirements: [],
    },
    ...overrides,
  };
};

const makeTempDir = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-eval-b-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const writeJson = (filePath, value) =>
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const collectingLogger = () => {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (...values) => logs.push(values.join(' ')),
    error: (...values) => errors.push(values.join(' ')),
  };
};

const assertEnvelope = (report) => {
  assert.deepEqual(Object.keys(report), ['version', 'generated_at', 'kits']);
  assert.equal(report.version, '1.0');
  assert.equal(Number.isNaN(Date.parse(report.generated_at)), false);
  assert.ok(Array.isArray(report.kits));
  for (const result of report.kits) {
    assert.deepEqual(Object.keys(result), ['id', 'status', 'kit', 'error']);
    assert.ok(['ok', 'failed'].includes(result.status));
    if (result.status === 'ok') {
      assert.equal(result.error, null);
      assert.equal(validateKitStructure(result.kit).valid, true);
    } else {
      assert.equal(result.kit, null);
      assert.equal(typeof result.error, 'object');
      assert.equal(typeof result.error.code, 'string');
      assert.equal(typeof result.error.message, 'string');
    }
  }
};

const successfulPipelineDeps = (overrides = {}) => ({
  extractRequirements: async () => ({
    role: 'Backend Engineer',
    seniority: 'senior',
    mustHaveSkills: ['Node.js'],
    niceToHaveSkills: [],
    responsibilities: [],
    qualifications: [],
    interviewSignals: [],
  }),
  researchCompanyPipeline: async ({ companyUrl }) => ({
    companyUrl,
    companyTitle: 'Example',
    sources: [{ url: companyUrl, title: 'Example', text: 'Builds software products.' }],
  }),
  generateQuestions: async () => ({ questions: [validQuestion()] }),
  fillCoverageGaps: async ({ questions }) => ({ questions }),
  ...overrides,
});

describe('Appendix B evaluator contract', () => {
  it('keeps the mandatory command and documents the exact input fields', () => {
    const options = evaluator.parseCliArgs(['--input', 'C:\\cases\\cases.json', '--output', 'D:\\kits.json']);
    assert.equal(options.input, 'C:\\cases\\cases.json');
    assert.equal(options.output, 'D:\\kits.json');
    assert.match(evaluator.HELP, /npm run evaluate -- --input <cases\.json> --output <kits\.json>/);
    for (const field of ['id', 'jd', 'company_url', 'days']) assert.match(evaluator.HELP, new RegExp(`\\b${field}\\b`));
  });

  it('maps Appendix B fields to the production pipeline names and returns an exact success result', async () => {
    const calls = [];
    const report = await evaluator.runBatchEvaluation([validCase()], {
      generateInterviewPrepKit: async (input) => {
        calls.push(input);
        return { kit: validKit(input) };
      },
    });
    assertEnvelope(report);
    assert.equal(report.kits.length, 1);
    assert.equal(report.kits[0].id, 'case-01');
    assert.equal(report.kits[0].status, 'ok');
    assert.equal(report.kits[0].error, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].jobDescription, validCase().jd);
    assert.equal(calls[0].companyUrl, validCase().company_url);
    assert.equal(calls[0].interviewDays, validCase().days);
  });

  it('accepts the same production pipeline when research has only a homepage source', async () => {
    const report = await evaluator.runBatchEvaluation([validCase({ id: 'partial-research' })], {
      generateInterviewPrepKit: async (input) => {
        const partialResearchPipeline = (args) => researchCompanyPipeline(args, {
          researchCompany: async ({ companyUrl, includeHtml }) => {
            if (companyUrl.includes('/broken-careers')) {
              const error = new Error('The discovered careers page was unavailable.');
              error.code = 'RESEARCH_UPSTREAM_HTTP_ERROR';
              throw error;
            }
            return {
              companyUrl,
              title: 'Example',
              text: 'Builds software products.',
              ...(includeHtml ? { html: '<a href="/broken-careers">Careers</a>' } : {}),
            };
          },
        });
        const pipelineResult = await generateInterviewPrepKit(input, successfulPipelineDeps({
          researchCompanyPipeline: partialResearchPipeline,
        }));
        return { kit: buildFinalKit(input, pipelineResult) };
      },
    });
    assertEnvelope(report);
    assert.equal(report.kits[0].status, 'ok');
    assert.equal(report.kits[0].kit.company_brief.sources.length, 1);
  });

  it('marks malformed and duplicate cases failed without stopping later cases', async () => {
    let calls = 0;
    const report = await evaluator.runBatchEvaluation([
      validCase({ id: 'bad-jd', jd: '  ' }),
      validCase({ id: 'duplicate' }),
      validCase({ id: 'duplicate' }),
      validCase({ id: 'later' }),
      { id: 'extra', jd: 'Role', company_url: 'https://example.com', days: 1, extra: true },
    ], {
      generateInterviewPrepKit: async (input) => {
        calls += 1;
        return { kit: validKit(input) };
      },
    });
    assertEnvelope(report);
    assert.equal(calls, 2);
    assert.deepEqual(report.kits.map((result) => result.id), ['bad-jd', 'duplicate', 'duplicate', 'later', 'extra']);
    assert.deepEqual(report.kits.map((result) => result.status), ['failed', 'ok', 'failed', 'ok', 'failed']);
    assert.equal(report.kits[2].error.code, 'DUPLICATE_CASE_ID');
    assert.equal(report.kits[0].error.code, 'INVALID_CASE');
    assert.equal(report.kits[4].error.code, 'INVALID_CASE');
  });

  it('rejects an invalid generated kit and never exposes it', async () => {
    const report = await evaluator.runBatchEvaluation([validCase({ id: 'invalid-kit' })], {
      generateInterviewPrepKit: async () => ({ kit: { source: {} } }),
    });
    assertEnvelope(report);
    assert.deepEqual(report.kits[0], {
      id: 'invalid-kit',
      status: 'failed',
      kit: null,
      error: { code: 'KIT_VALIDATION_FAILED', message: 'Generated kit failed kitStructureValidator (8 validation errors).' },
    });
  });

  it('keeps errors free of credentials, stack traces, and filesystem paths', async (t) => {
    const previous = process.env.EVALUATOR_CONTRACT_SECRET;
    process.env.EVALUATOR_CONTRACT_SECRET = 'contract-secret-value-12345';
    t.after(() => {
      if (previous === undefined) delete process.env.EVALUATOR_CONTRACT_SECRET;
      else process.env.EVALUATOR_CONTRACT_SECRET = previous;
    });
    const error = new Error('provider secret contract-secret-value-12345 at C:\\private\\provider.js');
    error.code = 'RESEARCH_NETWORK_ERROR';
    error.stack = 'SecretStackFrame at provider.js:1:1';
    const report = await evaluator.runBatchEvaluation([validCase({ id: 'safe-error' })], {
      generateInterviewPrepKit: async () => { throw error; },
    });
    assertEnvelope(report);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /contract-secret-value-12345|SecretStackFrame|C:\\\\private/);
    assert.equal(report.kits[0].error.code, 'COMPANY_UNREACHABLE');
  });

  it('writes the exact output envelope from the CLI and uses the required input fields', async (t) => {
    const directory = makeTempDir(t);
    const inputPath = path.join(directory, 'cases.json');
    const outputPath = path.join(directory, 'kits.json');
    const input = [validCase({ id: 'case-01' }), validCase({ id: 'case-02', days: 5 })];
    writeJson(inputPath, input);
    const code = await evaluator.runCli(['--input', inputPath, '--output', outputPath], {
      cwd: directory,
      logger: collectingLogger(),
      generateInterviewPrepKit: async (pipelineInput) => ({ kit: validKit(pipelineInput) }),
    });
    assert.equal(code, evaluator.EXIT_SUCCESS);
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assertEnvelope(report);
    assert.deepEqual(report.kits.map((result) => result.id), ['case-01', 'case-02']);
    assert.equal(fs.readFileSync(inputPath, 'utf8'), `${JSON.stringify(input, null, 2)}\n`);
  });

  it('keeps production SSRF protections unchanged while allowing the evaluator loopback context', () => {
    assert.throws(() => assertSafeUrl('http://localhost:8099/acme/'));
    const parsed = evaluator.parseCaseInput(validCase({ company_url: 'http://localhost:8099/acme/' }), 0);
    assert.equal(parsed.companyUrl, 'http://localhost:8099/acme/');
    assert.equal(parsed.jobDescription, validCase().jd);
  });

  it('runs a real loopback fixture URL through the unchanged production research and pipeline stages', async (t) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>Acme</title></head><body>Acme builds reliable backend infrastructure for engineering teams.</body></html>');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(8099, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const input = validCase({ id: 'loopback-case', company_url: 'http://localhost:8099/acme/' });
    const report = await evaluator.runBatchEvaluation([input], {
      generateInterviewPrepKit: async (pipelineInput) => {
        const pipelineResult = await generateInterviewPrepKit(pipelineInput, successfulPipelineDeps({
          researchCompanyPipeline: (args) => researchCompanyPipeline(args, { researchCompany }),
        }));
        return { kit: buildFinalKit(pipelineInput, pipelineResult) };
      },
    });
    assertEnvelope(report);
    assert.equal(report.kits[0].status, 'ok');
    assert.equal(report.kits[0].kit.source.companyUrl, input.company_url);
  });

  it('resolves a local fixture through the private evaluator mechanism', async (t) => {
    const directory = makeTempDir(t);
    const fixturePath = path.join(directory, 'company.html');
    const inputPath = path.join(directory, 'cases.json');
    fs.writeFileSync(fixturePath, '<html><title>Fixture Co</title><body>Builds tools.</body></html>', 'utf8');
    writeJson(inputPath, [validCase({ company_url: 'company.html' })]);
    let pipelineInput;
    const code = await evaluator.runCli(['--input', inputPath, '--output', path.join(directory, 'kits.json')], {
      cwd: directory,
      logger: collectingLogger(),
      generateInterviewPrepKit: async (input) => {
        pipelineInput = input;
        assert.match(input.companyUrl, /^http:\/\/127\.0\.0\.1:\d+\/fixtures\/\d+$/);
        assert.equal(input[BATCH_FIXTURE_CONTEXT], BATCH_FIXTURE_CONTEXT);
        return { kit: validKit(input) };
      },
    });
    assert.equal(code, evaluator.EXIT_SUCCESS);
    assert.ok(pipelineInput);
  });

  it('rejects malformed top-level JSON before creating an output report', async (t) => {
    const directory = makeTempDir(t);
    const inputPath = path.join(directory, 'cases.json');
    const outputPath = path.join(directory, 'kits.json');
    fs.writeFileSync(inputPath, '{not-json', 'utf8');
    const logger = collectingLogger();
    assert.equal(await evaluator.runCli(['--input', inputPath, '--output', outputPath], { cwd: directory, logger }), evaluator.EXIT_USAGE);
    assert.match(logger.errors.join('\n'), /Error reading input/);
    assert.equal(fs.existsSync(outputPath), false);
  });
});
