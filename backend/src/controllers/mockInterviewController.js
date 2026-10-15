// Mock Interview HTTP layer. Every route is authenticated; ownership comes
// from req.userId only, so another user's kit or session is a 404. Grading and
// the report run as background jobs (mockTurn / mockReport): 202 { jobId }.
//
// `deps` ({ jobRunner, mockStore, kitModel }) lets tests run every endpoint
// without MongoDB.

const InterviewPrepKit = require('../models/InterviewPrepKit');
const mockInterviewService = require('../services/mockInterviewService');
const answerFeedbackService = require('../services/answerFeedbackService');
const { KitBuilderError, toPlainKit } = require('../services/kitBuilderService');
const { hasUnsafeKeys, isSafeIdentifier } = require('../services/inputValidationService');
const { startJob, runnerFrom } = require('./generationJobsController');

const { MockInterviewError, DuplicateActiveSessionError } = mockInterviewService;

const storeFrom = (deps) => deps?.mockStore || mockInterviewService.mongoMockStore;
const kitModelFrom = (deps) => deps?.kitModel || InterviewPrepKit;

const notFound = (code, message) => new MockInterviewError(code, message, { status: 404 });
const sessionNotFound = () => notFound('MOCK_NOT_FOUND', 'Mock interview not found.');

const respondWithError = (res, error) => {
  if (error instanceof KitBuilderError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
    });
  }
  if (error?.name === 'CastError') return res.status(404).json({ error: { code: 'MOCK_NOT_FOUND', message: 'Mock interview not found.' } });
  console.error('Mock interview request failed.', JSON.stringify({ name: error?.name || null, code: error?.code ?? null }));
  return res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Server error.' } });
};

const bodyOf = (req) => {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || hasUnsafeKeys(body)) {
    throw new MockInterviewError('MOCK_INVALID_PAYLOAD', 'Request body must be a safe JSON object.', { status: 400 });
  }
  return body;
};

const loadOwnedKit = async (req, deps) => {
  if (!isSafeIdentifier(req.params.id)) throw notFound('KIT_NOT_FOUND', 'Kit not found.');
  const kit = await kitModelFrom(deps).findOne({ _id: req.params.id, userId: req.userId });
  if (!kit) throw notFound('KIT_NOT_FOUND', 'Kit not found.');
  return toPlainKit(kit);
};

// Expires idle sessions first, so the session returned is never stale.
const loadOwnedSession = async (req, deps) => {
  if (!isSafeIdentifier(req.params.sid)) throw sessionNotFound();
  const store = storeFrom(deps);
  await mockInterviewService.expireStale(store, req.userId);
  const session = await store.findOwned(req.params.sid, req.userId);
  if (!session) throw sessionNotFound();
  return session;
};

const activeConflict = (session) => new MockInterviewError(
  'MOCK_ALREADY_ACTIVE',
  'You already have a mock interview in progress. Finish or abandon it first.',
  { status: 409, details: { sessionId: String(session._id || session.id) } }
);

// POST /api/kits/:id/mock-interviews { length } — 201 { session } with the first question. No LLM call.
const createMockInterview = async (req, res, deps) => {
  try {
    const length = mockInterviewService.parseLength(bodyOf(req).length);
    const kit = await loadOwnedKit(req, deps);
    const store = storeFrom(deps);
    await mockInterviewService.expireStale(store, req.userId);
    const existing = await store.findActive(req.userId);
    if (existing) throw activeConflict(existing);

    const plan = mockInterviewService.selectPlan(kit, length);
    const now = new Date();
    let created;
    try {
      created = await store.create({
        userId: req.userId,
        kitId: req.params.id,
        status: 'active',
        length,
        plan,
        turns: [mockInterviewService.mainTurn(kit, plan[0], now)],
        currentIndex: 0,
        report: null,
        reportError: null,
        modelsUsed: {},
        lastActivityAt: now,
      });
    } catch (error) {
      if (!(error instanceof DuplicateActiveSessionError)) throw error;
      const raced = await store.findActive(req.userId);
      if (!raced) throw error;
      throw activeConflict(raced);
    }
    return res.status(201).json({ session: mockInterviewService.toSessionResponse(created) });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// GET /api/kits/:id/mock-interviews — the latest 10 sessions for the kit, as summaries.
const listMockInterviews = async (req, res, deps) => {
  try {
    await loadOwnedKit(req, deps);
    const store = storeFrom(deps);
    await mockInterviewService.expireStale(store, req.userId);
    const sessions = await store.listForKit(req.userId, req.params.id, mockInterviewService.LIST_LIMIT);
    return res.json({ sessions: sessions.map(mockInterviewService.toSessionSummary) });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// GET /api/mock-interviews/:sid — the session with its current question or report.
const getMockInterview = async (req, res, deps) => {
  try {
    return res.json({ session: mockInterviewService.toSessionResponse(await loadOwnedSession(req, deps)) });
  } catch (error) {
    return respondWithError(res, error);
  }
};

const requireActive = (session) => {
  if (session.status !== 'active') {
    throw new MockInterviewError('MOCK_NOT_ACTIVE', 'This mock interview has ended.', { status: 409, details: { status: session.status } });
  }
};

// POST /api/mock-interviews/:sid/answer { answer } — 202 { jobId } (job type mockTurn).
const answerMockInterview = async (req, res, deps) => {
  let session;
  let answer;
  let turnIndex;
  try {
    const body = bodyOf(req);
    session = await loadOwnedSession(req, deps);
    requireActive(session);
    turnIndex = mockInterviewService.currentTurnIndex(session);
    if (turnIndex === -1) throw new MockInterviewError('MOCK_NOT_ACTIVE', 'This mock interview has no open question.', { status: 409 });
    answer = answerFeedbackService.validateAnswer(body.answer);
  } catch (error) {
    return respondWithError(res, error);
  }
  return startJob(res, runnerFrom(deps), {
    userId: req.userId,
    type: 'mockTurn',
    kitId: String(session.kitId),
    input: { sessionId: String(session._id || session.id), turnIndex, answer },
  });
};

// POST /api/mock-interviews/:sid/abandon — ends an active session.
const abandonMockInterview = async (req, res, deps) => {
  try {
    const session = await loadOwnedSession(req, deps);
    requireActive(session);
    const updated = await storeFrom(deps).update(req.params.sid, req.userId, { status: 'active' }, {
      status: 'abandoned',
      abandonedReason: 'user',
      lastActivityAt: new Date(),
    });
    if (!updated) throw new MockInterviewError('MOCK_NOT_ACTIVE', 'This mock interview has ended.', { status: 409 });
    return res.json({ session: mockInterviewService.toSessionResponse(updated) });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// POST /api/mock-interviews/:sid/report — retries a missing report: 202 { jobId } (job type mockReport).
const retryMockReport = async (req, res, deps) => {
  let session;
  try {
    session = await loadOwnedSession(req, deps);
    if (session.status !== 'completed' || session.report) {
      throw new MockInterviewError('MOCK_REPORT_NOT_NEEDED', 'Only a completed interview without a report can retry it.', { status: 409 });
    }
  } catch (error) {
    return respondWithError(res, error);
  }
  return startJob(res, runnerFrom(deps), {
    userId: req.userId,
    type: 'mockReport',
    kitId: String(session.kitId),
    input: { sessionId: String(session._id || session.id) },
  });
};

module.exports = {
  createMockInterview,
  listMockInterviews,
  getMockInterview,
  answerMockInterview,
  abandonMockInterview,
  retryMockReport,
};
