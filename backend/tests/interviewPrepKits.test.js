const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const InterviewPrepKit = require('../src/models/InterviewPrepKit');
const GenerationJob = require('../src/models/GenerationJob');
const MockInterview = require('../src/models/MockInterview');
const {
  createKit,
  listKits,
  getKitById,
  updateKit,
  deleteKit,
} = require('../src/controllers/interviewPrepKitsController');

const buildValidKitBody = () => ({
  source: {
    jobRole: 'Junior Backend Developer',
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
    { id: 'q1', question: 'Explain the Node.js event loop.', difficulty: 1, requirementRefs: ['Node.js'] },
    { id: 'q2', question: 'How do you model data in MongoDB?', difficulty: 2, requirementRefs: ['MongoDB'] },
  ],
  flashcards: [
    { id: 'f1', front: 'Node.js event loop', back: 'Handles async work.', questionIds: ['q1'] },
  ],
  schedule: {
    interviewDays: 2,
    days: [
      { day: 1, question_ids: ['q1'] },
      { day: 2, question_ids: ['q2'] },
    ],
  },
  coverage: {
    coveragePercent: 100,
    coveredRequirements: ['Node.js', 'MongoDB'],
    missingRequirements: [],
  },
});

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

// Job and mock interview model stubs default to "none", so no test ever reaches MongoDB.
const withModelStubs = (t, stubs, jobStubs = {}, mockStubs = {}) => {
  const methods = ['create', 'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete'];
  const jobMethods = { exists: async () => null, deleteMany: async () => ({ deletedCount: 0 }), ...jobStubs };
  const mockMethods = { deleteMany: async () => ({ deletedCount: 0 }), ...mockStubs };
  const originals = {};
  const jobOriginals = {};
  const mockOriginals = {};
  for (const method of methods) {
    originals[method] = InterviewPrepKit[method];
    if (stubs[method] !== undefined) InterviewPrepKit[method] = stubs[method];
  }
  for (const [method, stub] of Object.entries(jobMethods)) {
    jobOriginals[method] = GenerationJob[method];
    GenerationJob[method] = stub;
  }
  for (const [method, stub] of Object.entries(mockMethods)) {
    mockOriginals[method] = MockInterview[method];
    MockInterview[method] = stub;
  }
  t.after(() => {
    for (const method of methods) InterviewPrepKit[method] = originals[method];
    for (const method of Object.keys(jobMethods)) GenerationJob[method] = jobOriginals[method];
    for (const method of Object.keys(mockMethods)) MockInterview[method] = mockOriginals[method];
  });
};

describe('interview prep kits CRUD and ownership', () => {
  it('creates a valid kit with req.userId and ignores body userId', async (t) => {
    let saved = null;
    withModelStubs(t, {
      create: async (doc) => {
        saved = doc;
        return { toObject: () => ({ _id: 'kit-1', ...doc }) };
      },
    });
    const req = { userId: 'user-A', body: { ...buildValidKitBody(), userId: 'attacker' } };
    const res = mockResponse();
    await createKit(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.userId, 'user-A');
    assert.equal(res.body.userId, 'user-A');
    // newly generated questions always start as generated + unpinned
    assert.equal(saved.questions[0].status, 'generated');
    assert.equal(saved.questions[0].pinned, false);
    assert.equal(saved.questions[0].question, 'Explain the Node.js event loop.');
  });

  it('rejects an invalid kit without touching the model', async (t) => {
    let called = false;
    withModelStubs(t, {
      create: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    const res = mockResponse();
    await createKit({ userId: 'user-A', body: { source: {} } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'KIT_VALIDATION_FAILED');
    assert.ok(Array.isArray(res.body.error.details));
    assert.equal(called, false);
  });

  it('lists only the requesting user kits', async (t) => {
    let filter = null;
    withModelStubs(t, {
      find: (criteria) => {
        filter = criteria;
        return { sort: async () => [{ _id: 'kit-1' }] };
      },
    });
    const res = mockResponse();
    await listKits({ userId: 'user-A' }, res);
    assert.deepEqual(filter, { userId: 'user-A' });
    assert.deepEqual(res.body, [{ _id: 'kit-1' }]);
  });

  it('returns 404 when reading another user kit', async (t) => {
    let filter = null;
    withModelStubs(t, {
      findOne: async (criteria) => {
        filter = criteria;
        return null;
      },
    });
    const res = mockResponse();
    await getKitById({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.deepEqual(filter, { _id: 'kit-1', userId: 'user-A' });
    assert.equal(res.statusCode, 404);
  });

  it('updates only the requesting user kit and validates first', async (t) => {
    let lookup = null;
    let filter = null;
    let update = null;
    withModelStubs(t, {
      findOne: async (criteria) => {
        lookup = criteria;
        return null;
      },
      findOneAndUpdate: async (criteria, patch, options) => {
        filter = criteria;
        update = { patch, options };
        return { _id: 'kit-1', ...patch.$set };
      },
    });
    const body = buildValidKitBody();
    body.role.title = 'Updated title';
    const res = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'kit-1' }, body }, res);
    assert.deepEqual(lookup, { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(filter, { _id: 'kit-1', userId: 'user-A' });
    assert.equal(update.options.returnDocument, 'after');
    assert.equal(res.body.role.title, 'Updated title');
    assert.equal(res.body.userId, undefined);
  });

  it('keeps builder metadata across a whole-kit PUT', async (t) => {
    let persisted = null;
    withModelStubs(t, {
      // stored kit: q1 was pinned, q2 was edited by the user
      findOne: async () => ({
        toObject: () => ({
          _id: 'kit-1',
          questions: [
            { id: 'q1', status: 'generated', pinned: true },
            { id: 'q2', status: 'edited', pinned: false },
          ],
        }),
      }),
      findOneAndUpdate: async (criteria, patch) => {
        persisted = patch.$set;
        return { _id: 'kit-1', ...patch.$set };
      },
    });
    const body = buildValidKitBody(); // client payload carries no builder metadata
    const res = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'kit-1' }, body }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(persisted.questions[0].id, 'q1');
    assert.equal(persisted.questions[0].pinned, true);
    assert.equal(persisted.questions[0].status, 'generated');
    assert.equal(persisted.questions[1].id, 'q2');
    assert.equal(persisted.questions[1].status, 'edited');
    assert.equal(persisted.questions[1].pinned, false);
  });

  it('lets an explicit PUT payload value override stored builder metadata', async (t) => {
    let persisted = null;
    withModelStubs(t, {
      findOne: async () => ({
        toObject: () => ({ questions: [{ id: 'q1', status: 'edited', pinned: true }] }),
      }),
      findOneAndUpdate: async (criteria, patch) => {
        persisted = patch.$set;
        return { _id: 'kit-1', ...patch.$set };
      },
    });
    const body = buildValidKitBody();
    body.questions[0].status = 'generated';
    body.questions[0].pinned = false;
    const res = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'kit-1' }, body }, res);
    assert.equal(persisted.questions[0].status, 'generated');
    assert.equal(persisted.questions[0].pinned, false);
  });

  it('rejects invalid update payloads without touching the model', async (t) => {
    let called = false;
    withModelStubs(t, {
      findOneAndUpdate: async () => {
        called = true;
        return null;
      },
    });
    const res = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'kit-1' }, body: { role: {} } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'KIT_VALIDATION_FAILED');
    assert.equal(called, false);
  });

  it('returns 404 when updating another user kit', async (t) => {
    let filter = null;
    withModelStubs(t, {
      findOne: async () => null,
      findOneAndUpdate: async (criteria) => {
        filter = criteria;
        return null;
      },
    });
    const res = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'kit-1' }, body: buildValidKitBody() }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(filter, { _id: 'kit-1', userId: 'user-A' });
  });

  it('deletes only the requesting user kit', async (t) => {
    let filter = null;
    withModelStubs(t, {
      findOneAndDelete: async (criteria) => {
        filter = criteria;
        return { _id: 'kit-1' };
      },
    });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.deepEqual(filter, { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(res.body, { message: 'Kit deleted' });
  });

  it('returns 404 when deleting another user kit', async (t) => {
    withModelStubs(t, { findOneAndDelete: async () => null });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 404);
  });

  it('maps invalid ids to 404 for read/update/delete', async (t) => {
    const invalidId = new Error('bad id');
    invalidId.name = 'CastError';
    withModelStubs(t, {
      findOne: async () => {
        throw invalidId;
      },
      findOneAndUpdate: async () => {
        throw invalidId;
      },
      findOneAndDelete: async () => {
        throw invalidId;
      },
    });
    const readRes = mockResponse();
    await getKitById({ userId: 'user-A', params: { id: 'bad' } }, readRes);
    assert.equal(readRes.statusCode, 404);
    const updateRes = mockResponse();
    await updateKit({ userId: 'user-A', params: { id: 'bad' }, body: buildValidKitBody() }, updateRes);
    assert.equal(updateRes.statusCode, 404);
    const deleteRes = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'bad' } }, deleteRes);
    assert.equal(deleteRes.statusCode, 404);
  });
});

describe('kit delete: ownership and generation jobs', () => {
  const ACTIVE = ['queued', 'running', 'retrying'];
  const kitJobs = (userId) => ({ userId, $or: [{ kitId: 'kit-1' }, { 'result.kitId': 'kit-1' }] });

  it("deletes only the owner's kit and removes that kit's finished jobs for the owner only", async (t) => {
    const calls = {};
    withModelStubs(t, {
      findOneAndDelete: async (criteria) => { calls.kit = criteria; return { _id: 'kit-1' }; },
    }, {
      exists: async (filter) => { calls.active = filter; return null; },
      deleteMany: async (filter) => { calls.cleanup = filter; return { deletedCount: 2 }; },
    });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.kit, { _id: 'kit-1', userId: 'user-A' });
    assert.deepEqual(calls.active, { ...kitJobs('user-A'), status: { $in: ACTIVE } });
    assert.deepEqual(calls.cleanup, { ...kitJobs('user-A'), status: { $nin: ACTIVE } });
  });

  it("answers 404 for another user's kit and removes no jobs", async (t) => {
    let cleaned = false;
    withModelStubs(t, { findOneAndDelete: async () => null }, { deleteMany: async () => { cleaned = true; } });
    const res = mockResponse();
    await deleteKit({ userId: 'user-B', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(cleaned, false);
  });

  it('refuses with 409 KIT_JOB_ACTIVE while a job for the kit is active, without deleting anything', async (t) => {
    let deleted = false;
    withModelStubs(t, {
      findOneAndDelete: async () => { deleted = true; return { _id: 'kit-1' }; },
    }, { exists: async () => ({ _id: 'job-9' }) });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'KIT_JOB_ACTIVE');
    assert.equal(res.body.error.jobId, 'job-9');
    assert.equal(deleted, false);
  });

  it("removes the kit's mock interview sessions (active ones too) before the kit, for the owner only", async (t) => {
    const order = [];
    let sessionFilter = null;
    withModelStubs(t, {
      findOneAndDelete: async () => { order.push('kit'); return { _id: 'kit-1' }; },
    }, {}, {
      deleteMany: async (filter) => { order.push('sessions'); sessionFilter = filter; return { deletedCount: 2 }; },
    });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sessionFilter, { userId: 'user-A', kitId: 'kit-1' }, 'no status filter: an active session goes too');
    assert.deepEqual(order, ['sessions', 'kit']);
  });

  it('keeps the kit and answers 500 when its sessions cannot be removed', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    let kitDeleted = false;
    withModelStubs(t, {
      findOneAndDelete: async () => { kitDeleted = true; return { _id: 'kit-1' }; },
    }, {}, {
      deleteMany: async () => { throw Object.assign(new Error('db down'), { name: 'MongoError' }); },
    });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(kitDeleted, false);
    assert.equal(errors.mock.callCount(), 1, 'the failure is logged');
  });

  it('removes no sessions while a job for the kit (such as a mock answer being graded) is active', async (t) => {
    let sessionsRemoved = false;
    withModelStubs(t, {}, { exists: async () => ({ _id: 'job-9' }) }, { deleteMany: async () => { sessionsRemoved = true; } });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(sessionsRemoved, false);
  });

  it('still reports success when only the job cleanup fails, and logs it', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    withModelStubs(t, { findOneAndDelete: async () => ({ _id: 'kit-1' }) }, {
      deleteMany: async () => { throw Object.assign(new Error('db down'), { name: 'MongoError' }); },
    });
    const res = mockResponse();
    await deleteKit({ userId: 'user-A', params: { id: 'kit-1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(errors.mock.callCount(), 1);
  });
});

// Schema contract checks — these need no live MongoDB, they assert the model
// still declares the owner field, the seven kit sections, and timestamps.
describe('interview prep kit model schema', () => {
  const schema = InterviewPrepKit.schema;

  it('requires every kit schema section on the stored document', () => {
    for (const field of [
      'source',
      'company_brief',
      'role',
      'questions',
      'flashcards',
      'schedule',
      'coverage',
    ]) {
      const path = schema.path(field);
      assert.ok(path, `${field} should be a schema path`);
      assert.equal(path.isRequired, true, `${field} should be required`);
    }
  });

  it('stores the owner as an indexed User reference', () => {
    const ownerPath = schema.path('userId');
    assert.equal(ownerPath.isRequired, true);
    assert.equal(ownerPath.options.ref, 'User');
    const indexed = schema.indexes().some(([fields]) => fields && fields.userId === 1);
    assert.equal(indexed, true);
  });

  it('enables timestamps for list ordering', () => {
    assert.equal(schema.options.timestamps, true);
    assert.ok(schema.path('createdAt'));
    assert.ok(schema.path('updatedAt'));
  });
});



describe('kit source.jobRole persistence', () => {
  it('accepts and persists an explicit source.jobRole', async (t) => {
    let saved = null;
    withModelStubs(t, {
      create: async (doc) => {
        saved = doc;
        return { toObject: () => ({ _id: 'kit-1', ...doc }) };
      },
    });
    const req = { userId: 'user-A', body: buildValidKitBody() };
    const res = mockResponse();
    await createKit(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.source.jobRole, 'Junior Backend Developer');
    assert.equal(res.body.source.jobRole, 'Junior Backend Developer');
  });

  it('still creates kits saved before the Job role field existed', async (t) => {
    let saved = null;
    withModelStubs(t, {
      create: async (doc) => {
        saved = doc;
        return { toObject: () => ({ _id: 'kit-1', ...doc }) };
      },
    });
    const body = buildValidKitBody();
    delete body.source.jobRole;
    const res = mockResponse();
    await createKit({ userId: "user-A", body }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body.error));
    assert.equal(saved.source.jobRole, undefined);
  });

  it('rejects an invalid source.jobRole without touching the model', async (t) => {
    let called = false;
    withModelStubs(t, {
      create: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    const body = buildValidKitBody();
    body.source.jobRole = '   ';
    const res = mockResponse();
    await createKit({ userId: "user-A", body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'KIT_VALIDATION_FAILED');
    assert.ok(res.body.error.details.some((detail) => detail.path === '$.source.jobRole'));
    assert.equal(called, false);
  });
});
