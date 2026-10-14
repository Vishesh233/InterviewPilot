const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { generateInterviewPrep } = require('../src/controllers/interviewPrepController');
const { MIN_JOB_DESCRIPTION_LENGTH } = require('../src/services/inputValidationService');

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const fakeRunner = () => {
  const specs = [];
  return { specs, createJob: async (spec) => { specs.push(spec); return { job: { id: 'job-1' } }; } };
};
// Exactly `length` characters, ending on a non-space so trimming keeps them all.
const jdOfLength = (length) => `${'Node.js engineer building REST APIs. '.repeat(10).slice(0, length - 1)}.`;
const post = async (jobDescription) => {
  const res = mockResponse();
  const runner = fakeRunner();
  await generateInterviewPrep({
    userId: 'u1',
    body: { jobRole: 'Backend Developer', jobDescription, companyUrl: 'https://example.com/', interviewDays: 3 },
  }, res, { jobRunner: runner });
  return { res, runner };
};

describe('job description minimum at the API boundary', () => {
  it('is one shared value of 100 characters', () => {
    assert.equal(MIN_JOB_DESCRIPTION_LENGTH, 100);
  });

  it('rejects a JD below the minimum with 400 JOB_DESCRIPTION_TOO_SHORT and starts no job', async () => {
    const { res, runner } = await post(jdOfLength(MIN_JOB_DESCRIPTION_LENGTH - 1));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'JOB_DESCRIPTION_TOO_SHORT');
    assert.match(res.body.error.message, /at least 100 characters/);
    assert.equal(runner.specs.length, 0);
  });

  it('does not count surrounding whitespace', async () => {
    const { res } = await post(`   ${jdOfLength(MIN_JOB_DESCRIPTION_LENGTH - 1)}\n\n   `);
    assert.equal(res.body.error.code, 'JOB_DESCRIPTION_TOO_SHORT');
  });

  it('accepts a JD of exactly the minimum length', async () => {
    const { res, runner } = await post(jdOfLength(MIN_JOB_DESCRIPTION_LENGTH));
    assert.equal(res.statusCode, 202);
    assert.equal(runner.specs.length, 1);
  });

  it('keeps the saved evaluation cases above the minimum', () => {
    const cases = require(path.join(__dirname, '..', 'scripts', 'cases', 'requirement-quality.json'));
    assert.ok(cases.length >= 2);
    for (const testCase of cases) {
      assert.ok(testCase.jd.trim().length >= MIN_JOB_DESCRIPTION_LENGTH, `${testCase.id} is ${testCase.jd.trim().length} characters`);
    }
  });
});
