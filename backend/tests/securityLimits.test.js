const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');

const app = require('../src/server');
const User = require('../src/models/User');
const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const { register, login } = require('../src/controllers/authController');
const { createKit, updateKit } = require('../src/controllers/interviewPrepKitsController');
const { generateInterviewPrep } = require('../src/controllers/interviewPrepController');
const { createRateLimiters, readRateLimitConfig, RATE_LIMIT_DEFAULTS } = require('../src/middleware/rateLimiters');
const { createShutdown, createCrashHandlers } = require('../src/config/processLifecycle');
const {
  extractResumeText,
  MAX_RESUME_TEXT_LENGTH,
  MAX_PDF_PAGES,
} = require('../src/services/resumeTextExtractor');
const { analyzeResumeMatch } = require('../src/services/resumeMatchService');
const { generateResumeQuestions } = require('../src/services/resumeQuestionService');
const { researchCompanyPipeline } = require('../src/services/companyResearchPipelineService');
const { generateInterviewPrepKit } = require('../src/services/interviewPrepPipelineService');

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

// Gemini-shaped fake client: no real LLM call is ever made.
const fakeClient = (text) => ({ models: { generateContent: async () => ({ text }) } });

const stub = (t, target, method, value) => {
  const original = target[method];
  target[method] = value;
  t.after(() => { target[method] = original; });
};

const resumeTextOfLength = (length) => {
  const unit = 'Owned Node.js and PostgreSQL services in production. ';
  let text = '';
  while (text.length < length) text += unit;
  return text.slice(0, length);
};

const withServer = async (expressApp, run) => {
  const server = http.createServer(expressApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

describe('resume length: one limit, typed errors', () => {
  const baseBody = {
    jobRole: 'Backend Engineer',
    jobDescription: 'Backend Engineer with Node.js and PostgreSQL. You will design REST APIs and own production services.',
    companyUrl: 'https://example.com/',
    interviewDays: 3,
  };
  const fakeRunner = () => {
    const specs = [];
    return { specs, createJob: async (spec) => { specs.push(spec); return { job: { id: 'job-1' } }; } };
  };

  it('rejects over-limit resume text at the API boundary with 400 RESUME_TOO_LONG stating the limit', async () => {
    const res = mockResponse();
    const runner = fakeRunner();
    await generateInterviewPrep({ userId: 'u1', body: { ...baseBody, resume: { text: resumeTextOfLength(MAX_RESUME_TEXT_LENGTH + 1) } } }, res, { jobRunner: runner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'RESUME_TOO_LONG');
    assert.match(res.body.error.message, /40,000 characters/);
    assert.equal(runner.specs.length, 0, 'no job is started');
  });

  it('accepts resume text exactly at the limit at the API boundary', async () => {
    const res = mockResponse();
    const runner = fakeRunner();
    await generateInterviewPrep({ userId: 'u1', body: { ...baseBody, resume: { text: resumeTextOfLength(MAX_RESUME_TEXT_LENGTH) } } }, res, { jobRunner: runner });
    assert.equal(res.statusCode, 202);
    assert.equal(runner.specs.length, 1);
  });

  it('lets both resume LLM services accept text between 20,000 and 40,000 characters (the former 500)', async () => {
    const requirements = { role: 'Backend Engineer', mustHaveSkills: ['Node.js'] };
    const resumeText = resumeTextOfLength(30_000);
    const match = await analyzeResumeMatch({ resumeText, requirements, client: fakeClient(JSON.stringify({ matches: [] })) });
    assert.equal(match.missingRequirements.length > 0, true);
    const questions = await generateResumeQuestions({ resumeText, requirements, client: fakeClient(JSON.stringify({ projects: [], questions: [] })) });
    assert.deepEqual(questions.questions, []);
  });

  it('makes both resume LLM services throw the typed RESUME_TOO_LONG error above the limit', async () => {
    const requirements = { role: 'Backend Engineer', mustHaveSkills: ['Node.js'] };
    const resumeText = resumeTextOfLength(MAX_RESUME_TEXT_LENGTH + 1);
    for (const call of [
      () => analyzeResumeMatch({ resumeText, requirements, client: fakeClient('{}') }),
      () => generateResumeQuestions({ resumeText, requirements, client: fakeClient('{}') }),
    ]) {
      await assert.rejects(call, (error) => {
        assert.equal(error.name, 'ResumeFileError');
        assert.equal(error.code, 'RESUME_TOO_LONG');
        assert.equal(error.status, 400);
        return true;
      });
    }
  });
});

describe('PDF resume parsing limits', () => {
  const pdfWith = (objects) =>
    Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  const flateObject = (number, bytes) => {
    const compressed = zlib.deflateSync(bytes);
    return `${number} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream\nendobj\n`;
  };
  const extractPdf = (buffer) => () => extractResumeText({ buffer, fileName: 'cv.pdf', mimeType: 'application/pdf' });
  const expectCode = (operation, code) =>
    assert.throws(operation, (error) => {
      assert.equal(error.name, 'ResumeFileError');
      assert.equal(error.code, code);
      assert.equal(error.status, 400);
      return true;
    });

  it(`rejects a PDF with more than ${MAX_PDF_PAGES} pages`, () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, index) =>
      `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`);
    const buffer = pdfWith(['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', '2 0 obj\n<< /Type /Pages /Count 21 >>\nendobj\n', ...pages]);
    expectCode(extractPdf(buffer), 'RESUME_PDF_TOO_MANY_PAGES');
  });

  it('rejects a single stream that inflates beyond the per-stream cap (decompression bomb)', () => {
    const buffer = pdfWith([flateObject(4, Buffer.alloc(5 * 1024 * 1024, 0x20))]);
    assert.ok(buffer.length < 64 * 1024, 'the upload itself is tiny');
    expectCode(extractPdf(buffer), 'RESUME_PDF_TOO_LARGE');
  });

  it('rejects streams that together inflate beyond the total cap', () => {
    const chunk = Buffer.alloc(3.5 * 1024 * 1024, 0x20);
    const buffer = pdfWith([4, 5, 6, 7, 8].map((number) => flateObject(number, chunk)));
    expectCode(extractPdf(buffer), 'RESUME_PDF_TOO_LARGE');
  });
});

describe('register password rules', () => {
  const stubUsers = (t) => {
    const created = [];
    stub(t, User, 'findOne', async () => null);
    stub(t, User, 'create', async (doc) => { created.push(doc); return { _id: 'u1', email: doc.email }; });
    return created;
  };

  it('rejects a password shorter than 8 characters with PASSWORD_TOO_SHORT', async (t) => {
    const created = stubUsers(t);
    const res = mockResponse();
    await register({ body: { email: 'a@example.com', password: 'short7!' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'PASSWORD_TOO_SHORT');
    assert.match(res.body.error.message, /at least 8 characters/);
    assert.equal(created.length, 0);
  });

  it('rejects a password over 72 bytes (multi-byte characters count by bytes) with PASSWORD_TOO_LONG', async (t) => {
    const created = stubUsers(t);
    for (const password of ['a'.repeat(73), 'é'.repeat(37)]) {
      const res = mockResponse();
      await register({ body: { email: 'a@example.com', password } }, res);
      assert.equal(res.statusCode, 400, `${password.length} chars / ${Buffer.byteLength(password)} bytes`);
      assert.equal(res.body.error.code, 'PASSWORD_TOO_LONG');
    }
    assert.equal(created.length, 0);
  });

  it('accepts 8 characters and exactly 72 bytes', async (t) => {
    const created = stubUsers(t);
    for (const password of ['abcdefgh', 'a'.repeat(72)]) {
      const res = mockResponse();
      await register({ body: { email: 'a@example.com', password } }, res);
      assert.equal(res.statusCode, 201);
    }
    assert.equal(created.length, 2);
  });

  it('leaves login unchanged: a short password is still checked against the account', async (t) => {
    let looked = false;
    stub(t, User, 'findOne', async () => { looked = true; return null; });
    const res = mockResponse();
    await login({ body: { email: 'old@example.com', password: 'abc' } }, res);
    assert.equal(looked, true);
    assert.equal(res.statusCode, 401);
  });
});

describe('rate limiting', () => {
  const quiet = (t) => t.mock.method(console, 'error', () => {});

  it('reads defaults, accepts valid overrides and falls back (logged) on invalid values', (t) => {
    const errors = quiet(t);
    assert.deepEqual(readRateLimitConfig({}), { ...RATE_LIMIT_DEFAULTS });
    const config = readRateLimitConfig({ RATE_LIMIT_AUTH_MAX: '3', RATE_LIMIT_API_MAX: 'lots', RATE_LIMIT_JOB_CREATE_MAX: '0' });
    assert.equal(config.RATE_LIMIT_AUTH_MAX, 3);
    assert.equal(config.RATE_LIMIT_API_MAX, 300);
    assert.equal(config.RATE_LIMIT_JOB_CREATE_MAX, 15);
    assert.equal(errors.mock.callCount(), 2);
    assert.equal(RATE_LIMIT_DEFAULTS.RATE_LIMIT_AUTH_MAX, 10);
    assert.equal(RATE_LIMIT_DEFAULTS.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(RATE_LIMIT_DEFAULTS.RATE_LIMIT_JOB_CREATE_MAX, 15);
    assert.equal(RATE_LIMIT_DEFAULTS.RATE_LIMIT_JOB_CREATE_WINDOW_MS, 60 * 60 * 1000);
    assert.equal(RATE_LIMIT_DEFAULTS.RATE_LIMIT_API_MAX, 300);
  });

  it('answers 429 RATE_LIMITED with Retry-After once the limit is used up', async () => {
    const limiters = createRateLimiters({ RATE_LIMIT_AUTH_MAX: '2' });
    const testApp = express();
    testApp.post('/login', limiters.login, (req, res) => res.status(401).json({}));
    await withServer(testApp, async (base) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.equal((await fetch(`${base}/login`, { method: 'POST' })).status, 401);
      }
      const blocked = await fetch(`${base}/login`, { method: 'POST' });
      assert.equal(blocked.status, 429);
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After ${retryAfter}`);
      const body = await blocked.json();
      assert.equal(body.error.code, 'RATE_LIMITED');
      assert.equal(body.error.retryAfterSeconds, retryAfter);
      assert.match(body.error.message, /try again in 15 minutes/);
    });
  });

  it('exempts job polling from the /api baseline but limits it on its own, per user', async () => {
    const limiters = createRateLimiters({ RATE_LIMIT_API_MAX: '1', RATE_LIMIT_JOB_POLL_MAX: '3' });
    const testApp = express();
    testApp.use('/api', limiters.api);
    testApp.use((req, res, next) => { req.userId = req.get('x-user'); next(); });
    testApp.get('/api/jobs/:id', limiters.jobPoll, (req, res) => res.json({ ok: true }));
    testApp.get('/api/kits', (req, res) => res.json([]));
    await withServer(testApp, async (base) => {
      const poll = (user) => fetch(`${base}/api/jobs/job-1`, { headers: { 'x-user': user } });
      for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await poll('a')).status, 200);
      assert.equal((await poll('a')).status, 429, 'the poll limit applies');
      assert.equal((await poll('b')).status, 200, 'per user, not per IP');
      assert.equal((await fetch(`${base}/api/kits`)).status, 200, 'polls did not use the baseline');
      assert.equal((await fetch(`${base}/api/kits`)).status, 429, 'the baseline still applies elsewhere');
    });
  });

  it('counts only accepted job creations, per user', async () => {
    const limiters = createRateLimiters({ RATE_LIMIT_JOB_CREATE_MAX: '1' });
    const testApp = express();
    testApp.use((req, res, next) => { req.userId = req.get('x-user'); next(); });
    testApp.post('/create/:status', limiters.jobCreate, (req, res) => res.status(Number(req.params.status)).json({}));
    await withServer(testApp, async (base) => {
      const create = (user, status) => fetch(`${base}/create/${status}`, { method: 'POST', headers: { 'x-user': user } });
      assert.equal((await create('a', 400)).status, 400);
      assert.equal((await create('a', 202)).status, 202, 'the rejected request did not count');
      assert.equal((await create('a', 202)).status, 429);
      assert.equal((await create('b', 202)).status, 202, 'another user has their own budget');
    });
  });

  it('wires the login limit into the real app (11th attempt is 429)', async () => {
    await withServer(app, async (base) => {
      const statuses = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
    });
  });
});

describe('server-side coverage on kit create/update', () => {
  const kitBody = () => ({
    source: { jobRole: 'Backend Developer', jobDescription: 'Node.js and MongoDB.', companyUrl: 'https://example.com/' },
    company_brief: { name: 'Example', summary: 'Builds software.', sources: [{ url: 'https://example.com/', title: 'Example' }] },
    role: { title: 'Backend Developer', requirements: [{ id: 'Node.js' }, { id: 'MongoDB' }] },
    questions: [
      { id: 'q1', question: 'Explain the Node.js event loop.', difficulty: 1, requirementRefs: ['Node.js'] },
      { id: 'q2', category: 'resume', question: 'Walk me through your MongoDB project.', difficulty: 2, requirementRefs: ['MongoDB'] },
    ],
    flashcards: [{ id: 'f1', front: 'Event loop', back: 'Async work.', questionIds: ['q1'] }],
    schedule: { interviewDays: 1, days: [{ day: 1, question_ids: ['q1', 'q2'] }] },
    // Fake: claims everything is covered.
    coverage: { coveragePercent: 100, coveredRequirements: ['Node.js', 'MongoDB'], missingRequirements: [], note: 'trust me' },
  });
  const expected = { coveredRequirements: ['Node.js'], missingRequirements: ['MongoDB'], coveragePercent: 50 };

  it('ignores client-sent coverage on create and stores the recomputed value', async (t) => {
    let saved;
    stub(t, InterviewPrepKit, 'create', async (doc) => { saved = doc; return { toObject: () => ({ _id: 'k1', ...doc }) }; });
    const res = mockResponse();
    await createKit({ userId: 'u1', body: kitBody() }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(saved.coverage, expected, 'resume questions do not count and fake fields are dropped');
  });

  it('ignores client-sent coverage on update and stores the recomputed value', async (t) => {
    let update;
    stub(t, InterviewPrepKit, 'findOne', async () => null);
    stub(t, InterviewPrepKit, 'findOneAndUpdate', async (filter, change) => { update = change.$set; return { toObject: () => ({ _id: 'k1', ...change.$set }) }; });
    const res = mockResponse();
    await updateKit({ userId: 'u1', params: { id: 'k1' }, body: kitBody() }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(update.coverage, expected);
  });

  it('computes coverage even when the client omits it', async (t) => {
    let saved;
    stub(t, InterviewPrepKit, 'create', async (doc) => { saved = doc; return { toObject: () => ({ _id: 'k1', ...doc }) }; });
    const body = kitBody();
    delete body.coverage;
    const res = mockResponse();
    await createKit({ userId: 'u1', body }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(saved.coverage, expected);
  });
});

describe('health endpoint', () => {
  it('answers 503 with db down while MongoDB is not connected', async () => {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: 'error', db: 'down' });
    });
  });
});

describe('process lifecycle', () => {
  const silentLogger = () => ({ lines: [], log(...a) { this.lines.push(a.join(' ')); }, error(...a) { this.lines.push(a.join(' ')); } });

  it('closes the HTTP server, then MongoDB, then exits 0; a second signal is ignored', async () => {
    const order = [];
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const exits = [];
    const shutdown = createShutdown(server, {
      closeDb: async () => { order.push(server.listening ? 'db-before-http' : 'db'); },
      exit: (code) => exits.push(code),
      logger: silentLogger(),
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    assert.equal(server.listening, false);
    assert.deepEqual(order, ['db']);
    assert.deepEqual(exits, [0]);
  });

  it('exits 1 when closing MongoDB fails', async () => {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const exits = [];
    const logger = silentLogger();
    const shutdown = createShutdown(server, {
      closeDb: async () => { throw Object.assign(new Error('boom'), { name: 'MongoError', code: 'X' }); },
      exit: (code) => exits.push(code),
      logger,
    });
    await shutdown('SIGTERM');
    assert.deepEqual(exits, [1]);
    assert.ok(logger.lines.some((line) => line.includes('Graceful shutdown failed')));
  });

  it('logs and exits 1 on an uncaught exception or unhandled rejection', () => {
    const exits = [];
    const logger = silentLogger();
    const handlers = createCrashHandlers({ exit: (code) => exits.push(code), logger });
    handlers.uncaughtException(new TypeError('bad state'));
    handlers.unhandledRejection('plain reason');
    assert.deepEqual(exits, [1, 1]);
    assert.ok(logger.lines[0].includes('uncaught exception') && logger.lines[0].includes('bad state'));
    assert.ok(logger.lines[1].includes('unhandled promise rejection') && logger.lines[1].includes('plain reason'));
  });
});

describe('company research error accuracy', () => {
  const extracted = {
    role: 'Engineer', seniority: 'mid', mustHaveSkills: ['Node.js'],
    niceToHaveSkills: [], responsibilities: [], qualifications: [], interviewSignals: [],
  };

  it('reports a 422 from the company page with its own research code, not as an insufficient job description', async () => {
    const pageError = Object.assign(new Error('The company page contained too little useful public information.'), {
      code: 'RESEARCH_INSUFFICIENT_TEXT', status: 422, isPublic: true,
    });
    await assert.rejects(
      () => generateInterviewPrepKit(
        { jobRole: 'Engineer', jobDescription: 'We need a Node.js engineer.', companyUrl: 'https://example.com/', interviewDays: 3 },
        {
          extractRequirements: async () => extracted,
          researchCompanyPipeline: (input) => researchCompanyPipeline(input, { researchCompany: async () => { throw pageError; } }),
        }
      ),
      (error) => {
        assert.equal(error.code, 'RESEARCH_INSUFFICIENT_TEXT');
        assert.notEqual(error.code, 'INSUFFICIENT_JOB_DESCRIPTION');
        assert.equal(error.status, 422);
        assert.equal(error.stage, 'Company research');
        return true;
      }
    );
  });

  it('logs (sanitized) instead of silently skipping a discovered page that fails', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const result = await researchCompanyPipeline({ companyUrl: 'https://example.com/' }, {
      researchCompany: async ({ companyUrl, includeHtml }) => {
        if (includeHtml) {
          return {
            companyUrl: 'https://example.com/',
            title: 'Example',
            text: 'Example builds software.',
            html: '<a href="/careers?session=secret-token">Careers</a>',
          };
        }
        throw Object.assign(new Error(`failed for ${companyUrl}`), { code: 'RESEARCH_UPSTREAM_HTTP_ERROR' });
      },
    });
    assert.equal(result.sources.length, 1);
    assert.equal(warnings.mock.callCount(), 1);
    const logged = warnings.mock.calls[0].arguments.join(' ');
    assert.match(logged, /discovered page skipped/);
    assert.match(logged, /RESEARCH_UPSTREAM_HTTP_ERROR/);
    assert.match(logged, /https:\/\/example\.com\/careers/);
    assert.doesNotMatch(logged, /secret-token/);
  });
});
