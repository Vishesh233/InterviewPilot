const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dbErrorMeta, connectOptions, logIndexBuilds } = require('../src/config/database');

describe('database error logging', () => {
  it('keeps codeName and errmsg of a MongoServerError (the refused Atlas action)', () => {
    const error = Object.assign(new Error('user is not allowed to do action [find] on [test.generationjobs]'), {
      name: 'MongoServerError',
      code: 8000,
      codeName: 'AtlasError',
      errmsg: 'user is not allowed to do action [find] on [test.generationjobs]',
    });
    assert.deepEqual(JSON.parse(dbErrorMeta(error)), {
      name: 'MongoServerError',
      code: 8000,
      codeName: 'AtlasError',
      errmsg: 'user is not allowed to do action [find] on [test.generationjobs]',
      message: 'user is not allowed to do action [find] on [test.generationjobs]',
    });
  });

  it('redacts URI credentials and secret-looking values in errmsg and message', () => {
    const text = 'failed for mongodb+srv://api-user:s3cr3t@cluster0.example.net/app password=hunter2 token: abc123';
    const meta = dbErrorMeta(Object.assign(new Error(text), { name: 'MongoServerError', errmsg: text }));
    for (const secret of ['api-user', 's3cr3t', 'hunter2', 'abc123']) assert.ok(!meta.includes(secret), secret);
    assert.match(meta, /mongodb\+srv:\/\/<credentials>@cluster0\.example\.net/);
    assert.match(meta, /password=<redacted>/);
  });

  it('omits codeName and errmsg when the error has none', () => {
    assert.deepEqual(JSON.parse(dbErrorMeta(new Error('connect ECONNREFUSED'))), {
      name: 'Error',
      code: null,
      message: 'connect ECONNREFUSED',
    });
  });
});

describe('database selection', () => {
  it('passes MONGODB_DB_NAME as dbName, and nothing when unset', () => {
    assert.deepEqual(connectOptions({ MONGODB_DB_NAME: ' interviewpilot ' }), { dbName: 'interviewpilot' });
    assert.deepEqual(connectOptions({ MONGODB_DB_NAME: '' }), {});
    assert.deepEqual(connectOptions({}), {});
  });
});

describe('index build logging', () => {
  const fakeConnection = (outcomes) => ({
    modelNames: () => Object.keys(outcomes),
    model: (name) => ({ init: () => (outcomes[name] ? Promise.reject(outcomes[name]) : Promise.resolve()) }),
  });

  it('logs each failed build with its model and error, and counts failures', async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const refused = Object.assign(new Error('not allowed'), { name: 'MongoServerError', code: 8000, codeName: 'AtlasError', errmsg: 'user is not allowed to do action [createIndex] on [app.jobs]' });
      const failed = await logIndexBuilds(fakeConnection({ User: null, GenerationJob: refused }));
      assert.equal(failed, 1);
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MongoDB index build failed\. \{"model":"GenerationJob"\}/);
    assert.match(lines[0], /\[createIndex\]/);
  });

  it('logs nothing when every build succeeds', async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      assert.equal(await logIndexBuilds(fakeConnection({ User: null, InterviewPrepKit: null })), 0);
    } finally {
      console.error = original;
    }
    assert.deepEqual(lines, []);
  });
});
