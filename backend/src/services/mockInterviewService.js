// Mock Interview Mode: a multi-turn AI interviewer grounded in one kit.
//
// - The plan (which kit questions, in which order) is chosen deterministically
//   when the session starts: categories are mixed, questions whose flashcards
//   are unrated, rated 1-2 or not covered come first, and nothing repeats.
// - Every answer is graded by the existing answer-feedback grader against that
//   question's outline and requirements (answers are untrusted data there).
// - At most one follow-up per main question, only for an on-topic answer
//   scoring 4-8, and only when the grader's follow-up passes
//   validateFollowUpText; otherwise the next main question is asked.
// - After the last turn a second LLM step writes the report. It never sees the
//   raw answers, only the graded results, and its output must reference this
//   kit's real requirements/categories and question ids. The overall score is
//   computed here from the turn scores, not by the model.
// - Inactivity: an active session idle for 24 h is marked abandoned when the
//   user's sessions are next read or written (expireStale). There is no timer:
//   the API runs as one process that can sleep, and checking on access keeps
//   every response correct without background work.

const { Type } = require('@google/genai');
const MockInterview = require('../models/MockInterview');
const { generateContent, LlmError } = require('./geminiClient');
const { isPlainObject } = require('./inputValidationService');
const builder = require('./kitBuilderService');
const answerFeedbackService = require('./answerFeedbackService');

const { KitBuilderError } = builder;

const MIN_LENGTH = 3;
const MAX_LENGTH = 5;
const INACTIVITY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 10;
const FOLLOW_UP_SCORE = { min: 4, max: 8 };
const FOLLOW_UP_MAX_WORDS = 30;
const CATEGORY_ORDER = ['technical', 'role_specific', 'behavioral', 'resume', 'company'];
const REPORT_LIMITS = { summaryWords: 60, noteWords: 20, reasonWords: 15, maxTopics: 6, maxPracticeNext: 3 };

const STAGES = {
  GRADING: 'Mock answer grading',
  REPORT: 'Mock report',
  SAVE: 'Saving mock turn',
};

const REPORT_UNAVAILABLE = {
  code: 'MOCK_REPORT_UNAVAILABLE',
  message: 'Your answers are saved, but the report card could not be written right now. Try again in a minute.',
};

const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;
const categoryOf = (question) => (typeof question?.category === 'string' && question.category ? question.category : 'role_specific');
const textOf = (question) => (typeof question?.question === 'string' ? question.question.trim() : '');

class MockInterviewError extends KitBuilderError {
  constructor(code, message, { status = 400, details } = {}) {
    super(code, message, { status, details });
    this.name = 'MockInterviewError';
  }
}

// ---- question selection ---------------------------------------------------------

// 0 = practice this first: a linked flashcard is unrated, rated 1-2 or not
// covered (a question without flashcards counts as unpracticed); 1 = otherwise.
const weaknessTier = (kit, questionId) => {
  const cards = (Array.isArray(kit.flashcards) ? kit.flashcards : [])
    .filter((card) => Array.isArray(card?.questionIds) && card.questionIds.includes(questionId));
  if (cards.length === 0) return 0;
  const weak = cards.some((card) => {
    const confidence = card.practice?.confidence;
    return confidence === null || confidence === undefined || confidence <= 2 || card.practice?.covered !== true;
  });
  return weak ? 0 : 1;
};

/**
 * The session plan: `length` question ids. Categories are taken round-robin
 * (categories with weak questions first, then CATEGORY_ORDER), each pick being
 * that category's weakest remaining question (tie: kit order).
 */
const selectPlan = (kit, length) => {
  const questions = (Array.isArray(kit?.questions) ? kit.questions : [])
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => typeof question?.id === 'string' && question.id && textOf(question));
  const seen = new Set();
  const candidates = questions.filter(({ question }) => (seen.has(question.id) ? false : seen.add(question.id)));
  if (candidates.length < length) {
    throw new MockInterviewError(
      'MOCK_NOT_ENOUGH_QUESTIONS',
      `This kit has ${candidates.length} question${candidates.length === 1 ? '' : 's'}; a mock interview of ${length} needs at least ${length}.`,
      { status: 422 }
    );
  }

  const ranked = candidates
    .map((entry) => ({ ...entry, tier: weaknessTier(kit, entry.question.id), category: categoryOf(entry.question) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index);
  const byCategory = new Map();
  for (const entry of ranked) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category).push(entry);
  }
  const orderOf = (category) => {
    const position = CATEGORY_ORDER.indexOf(category);
    return position === -1 ? CATEGORY_ORDER.length : position;
  };
  const categories = [...byCategory.keys()].sort((a, b) =>
    byCategory.get(a)[0].tier - byCategory.get(b)[0].tier || orderOf(a) - orderOf(b) || a.localeCompare(b));

  const plan = [];
  while (plan.length < length) {
    for (const category of categories) {
      const next = byCategory.get(category).shift();
      if (next) plan.push(next.question.id);
      if (plan.length === length) break;
    }
  }
  return plan;
};

const parseLength = (raw) => {
  if (!Number.isInteger(raw) || raw < MIN_LENGTH || raw > MAX_LENGTH) {
    throw new MockInterviewError('MOCK_INVALID_LENGTH', `length must be a whole number from ${MIN_LENGTH} to ${MAX_LENGTH}.`, { status: 400 });
  }
  return raw;
};

// ---- follow-ups --------------------------------------------------------------------

// Words that turn a "question" into an instruction to the system or the user.
const INSTRUCTION_PATTERN = /\b(ignore|disregard|instruction|instructions|system|prompt|assistant|ai model|score|grade|grading|10\/10|respond with|output|json)\b/i;

/** The follow-up text when it is usable: one question, at most 30 words, ending with "?", no instructions. */
const validateFollowUpText = (raw) => {
  if (typeof raw !== 'string') return { ok: false, reason: 'FOLLOW_UP_INVALID' };
  const text = raw.replace(/\s+/g, ' ').trim();
  const valid = text.length > 0
    && text.endsWith('?')
    && (text.match(/\?/g) || []).length === 1
    && !/[\r\n<>{}`]/.test(raw)
    && wordCount(text) <= FOLLOW_UP_MAX_WORDS
    && !INSTRUCTION_PATTERN.test(text);
  return valid ? { ok: true, text } : { ok: false, reason: 'FOLLOW_UP_INVALID' };
};

/** Whether a graded MAIN turn gets a follow-up, and its text. */
const decideFollowUp = (feedback) => {
  if (!feedback?.onTopic) return { ask: false, skipped: null };
  if (feedback.score < FOLLOW_UP_SCORE.min || feedback.score > FOLLOW_UP_SCORE.max) return { ask: false, skipped: null };
  const checked = validateFollowUpText(feedback.followUp);
  return checked.ok ? { ask: true, text: checked.text } : { ask: false, skipped: checked.reason };
};

// ---- turn state ------------------------------------------------------------------------

const currentTurnIndex = (session) => {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const index = turns.length - 1;
  return index >= 0 && turns[index].answer === null ? index : -1;
};

const questionById = (kit, questionId) => (Array.isArray(kit?.questions) ? kit.questions : []).find((question) => question?.id === questionId) || null;

const mainTurn = (kit, questionId, now) => {
  const question = questionById(kit, questionId);
  if (!question) {
    throw new MockInterviewError('MOCK_QUESTION_MISSING', 'A planned question is no longer in this kit, so the interview cannot continue.', { status: 409 });
  }
  return { kind: 'main', questionId, questionText: textOf(question), answer: null, feedback: null, followUpAsked: false, followUpSkipped: null, createdAt: now, answeredAt: null };
};

// The stored feedback of a turn: the answer-feedback shape without followUp.
const turnFeedback = ({ score, verdict, onTopic, strengths, gaps, improvedAnswer }) => ({ score, verdict, onTopic, strengths, gaps, improvedAnswer });

/**
 * The session after the current turn was graded: the turn is filled in, then a
 * follow-up or the next main question is asked, or the interview is complete.
 */
const applyGradedTurn = ({ session, kit, answer, feedback, now }) => {
  const index = currentTurnIndex(session);
  const turns = session.turns.map((turn) => ({ ...turn }));
  const turn = turns[index];
  turn.answer = answer;
  turn.feedback = turnFeedback(feedback);
  turn.answeredAt = now;

  let { currentIndex } = session;
  if (turn.kind === 'main') {
    const decision = decideFollowUp(feedback);
    turn.followUpAsked = decision.ask;
    turn.followUpSkipped = decision.skipped;
    if (decision.ask) {
      turns.push({ kind: 'followUp', questionId: turn.questionId, questionText: decision.text, answer: null, feedback: null, followUpAsked: false, followUpSkipped: null, createdAt: now, answeredAt: null });
      return { turns, currentIndex, completed: false };
    }
  }
  currentIndex += 1;
  if (currentIndex >= session.plan.length) return { turns, currentIndex: session.plan.length - 1, completed: true };
  turns.push(mainTurn(kit, session.plan[currentIndex], now));
  return { turns, currentIndex, completed: false };
};

// ---- report ------------------------------------------------------------------------------

const REPORT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    topicResults: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { topic: { type: Type.STRING }, score: { type: Type.INTEGER }, note: { type: Type.STRING } },
        required: ['topic', 'score', 'note'],
      },
    },
    practiceNext: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { questionId: { type: Type.STRING }, reason: { type: Type.STRING } },
        required: ['questionId', 'reason'],
      },
    },
  },
  required: ['summary', 'topicResults', 'practiceNext'],
};

const requirementTextById = (kit) => {
  const byId = new Map();
  for (const entry of Array.isArray(kit?.role?.requirements) ? kit.role.requirements : []) {
    if (typeof entry === 'string' && entry.trim()) byId.set(entry.trim(), entry.trim());
    else if (isPlainObject(entry)) {
      const text = [entry.text, entry.requirement, entry.name, entry.title, entry.id].find((value) => typeof value === 'string' && value.trim());
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : text?.trim();
      if (id && text) byId.set(id, text.trim());
    }
  }
  return byId;
};

/** Topics the report may name: the asked questions' requirements, then their categories. */
const allowedTopicsFor = (kit, session) => {
  const requirementText = requirementTextById(kit);
  const topics = new Set();
  const categories = new Set();
  for (const questionId of session.plan) {
    const question = questionById(kit, questionId);
    if (!question) continue;
    for (const ref of Array.isArray(question.requirementRefs) ? question.requirementRefs : []) {
      if (typeof ref === 'string' && ref.trim()) topics.add(requirementText.get(ref.trim()) || ref.trim());
    }
    categories.add(categoryOf(question));
  }
  return [...topics, ...categories];
};

const overallScoreOf = (turns) => {
  const scores = turns.map((turn) => turn.feedback?.score).filter(Number.isInteger);
  if (scores.length === 0) return 1;
  return Math.min(10, Math.max(1, Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)));
};

const buildReportPrompt = ({ kit, session, topics }) => {
  const turnLines = session.turns.filter((turn) => turn.feedback).map((turn, index) => [
    `${index + 1}. ${turn.kind === 'followUp' ? 'FOLLOW-UP' : 'QUESTION'} (${turn.questionId}): ${turn.questionText}`,
    `   score ${turn.feedback.score}/10, ${turn.feedback.verdict}${turn.feedback.onTopic ? '' : ', off topic'}`,
    `   strengths: ${turn.feedback.strengths.length ? turn.feedback.strengths.join(' | ') : 'none'}`,
    `   gaps: ${turn.feedback.gaps.join(' | ')}`,
  ].join('\n')).join('\n');
  const questionLines = (kit.questions || [])
    .filter((question) => typeof question?.id === 'string' && textOf(question))
    .map((question) => `- ${question.id} [${categoryOf(question)}]: ${textOf(question)}`)
    .join('\n');
  return `
You write the report card of a finished mock interview for an interview-prep tool.

ROLE: ${kit.role?.title || 'not stated'} | SENIORITY: ${kit.role?.level || 'not stated'}

GRADED TURNS (already graded; use only these results):
${turnLines}

ALLOWED TOPICS (copy the "topic" value verbatim from this list):
${topics.map((topic) => `- ${topic}`).join('\n')}

KIT QUESTIONS (the only allowed "questionId" values):
${questionLines}

RULES:
1. Base everything only on the graded turns above. Never invent facts about the candidate.
2. summary: at most ${REPORT_LIMITS.summaryWords} words, plain and specific, addressed to the candidate ("you").
3. topicResults: 1 to ${REPORT_LIMITS.maxTopics} items for topics the turns actually tested; topic copied verbatim from ALLOWED TOPICS,
   score an integer 1-10 consistent with the turn scores, note at most ${REPORT_LIMITS.noteWords} words. No topic twice.
4. practiceNext: 0 to ${REPORT_LIMITS.maxPracticeNext} kit questions to practice next, weakest areas first; questionId from KIT QUESTIONS,
   reason at most ${REPORT_LIMITS.reasonWords} words. No question twice.
5. Return JSON only:
{ "summary": "", "topicResults": [{ "topic": "", "score": 0, "note": "" }], "practiceNext": [{ "questionId": "", "reason": "" }] }
`.trim();
};

const toJsonText = (raw) => {
  const withoutFences = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  return start !== -1 && end > start ? withoutFences.slice(start, end + 1) : withoutFences;
};

const invalidReport = (detail) => new LlmError('LLM_INVALID_STRUCTURE', `The report did not match the required format: ${detail}.`, 502);
const cleanText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Parses one model answer into the stored report; throws a bad-output LlmError otherwise. */
const parseReport = (text, { topics, questionIds, overallScore }) => {
  if (typeof text !== 'string' || !text.trim()) throw new LlmError('LLM_EMPTY_RESPONSE', 'The model returned an empty response.', 502);
  let parsed;
  try {
    parsed = JSON.parse(toJsonText(text));
  } catch (error) {
    throw new LlmError('LLM_INVALID_JSON', 'The model returned malformed or truncated JSON.', 502);
  }
  if (!isPlainObject(parsed)) throw invalidReport('the response must be an object');

  const summary = cleanText(parsed.summary);
  if (!summary || wordCount(summary) > REPORT_LIMITS.summaryWords) throw invalidReport(`summary must be 1 to ${REPORT_LIMITS.summaryWords} words`);

  if (!Array.isArray(parsed.topicResults) || parsed.topicResults.length < 1 || parsed.topicResults.length > REPORT_LIMITS.maxTopics) {
    throw invalidReport(`topicResults must have 1 to ${REPORT_LIMITS.maxTopics} items`);
  }
  const allowed = new Set(topics);
  const usedTopics = new Set();
  const topicResults = parsed.topicResults.map((item) => {
    const topic = cleanText(item?.topic);
    const note = cleanText(item?.note);
    if (!allowed.has(topic)) throw invalidReport('every topic must be one of this kit\'s requirements or categories');
    if (usedTopics.has(topic)) throw invalidReport('a topic may appear only once');
    usedTopics.add(topic);
    if (!Number.isInteger(item.score) || item.score < 1 || item.score > 10) throw invalidReport('topic scores must be integers from 1 to 10');
    if (!note || wordCount(note) > REPORT_LIMITS.noteWords) throw invalidReport(`topic notes must be 1 to ${REPORT_LIMITS.noteWords} words`);
    return { topic, score: item.score, note };
  });

  if (!Array.isArray(parsed.practiceNext) || parsed.practiceNext.length > REPORT_LIMITS.maxPracticeNext) {
    throw invalidReport(`practiceNext must have at most ${REPORT_LIMITS.maxPracticeNext} items`);
  }
  const usedIds = new Set();
  const practiceNext = parsed.practiceNext.map((item) => {
    const questionId = cleanText(item?.questionId);
    const reason = cleanText(item?.reason);
    if (!questionIds.has(questionId)) throw invalidReport('practiceNext must use question ids from this kit');
    if (usedIds.has(questionId)) throw invalidReport('a question may appear only once in practiceNext');
    usedIds.add(questionId);
    if (!reason || wordCount(reason) > REPORT_LIMITS.reasonWords) throw invalidReport(`reasons must be 1 to ${REPORT_LIMITS.reasonWords} words`);
    return { questionId, reason };
  });

  return { overallScore, summary, topicResults, practiceNext };
};

/**
 * Writes the report for a session whose turns are all graded.
 * Returns { report, modelUsed }, or { report: null, reportError } when every
 * model failed (logged with its code; the user can retry the report).
 */
const generateReport = async ({ kit, session, client }) => {
  const topics = allowedTopicsFor(kit, session);
  const questionIds = new Set((kit.questions || []).map((question) => question?.id).filter((id) => typeof id === 'string' && id));
  const overallScore = overallScoreOf(session.turns);
  try {
    if (!client && !process.env.GEMINI_API_KEY) {
      throw new LlmError('LLM_NOT_CONFIGURED', 'The model provider is not configured.', 500);
    }
    const result = await generateContent({
      contents: buildReportPrompt({ kit, session, topics }),
      responseMimeType: 'application/json',
      responseSchema: REPORT_SCHEMA,
      acceptOutput: (text) => parseReport(text, { topics, questionIds, overallScore }),
      client,
    });
    return { report: result.value, modelUsed: result.modelUsed || null };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    console.warn('Mock interview report unavailable.', JSON.stringify({ sessionId: String(session._id || session.id), code: error.code, causeCode: error.causeCode || null }));
    return { report: null, reportError: { ...REPORT_UNAVAILABLE, causeCode: error.code } };
  }
};

const isValidReportOutcome = (value) =>
  isPlainObject(value) && (isPlainObject(value.report) || (value.report === null && value.reportError?.code === REPORT_UNAVAILABLE.code));

// ---- grading -------------------------------------------------------------------------------

/** The grading context for the current turn: that question's outline and requirements. */
const gradingContextFor = ({ kit, turn, answer }) => {
  const context = answerFeedbackService.prepareAnswerFeedback({ kit, questionId: turn.questionId, answer });
  return turn.kind === 'followUp' ? { ...context, followUpQuestion: turn.questionText } : context;
};

// ---- responses ---------------------------------------------------------------------------

const idOf = (session) => String(session._id || session.id);

const currentQuestionOf = (session) => {
  if (session.status !== 'active') return null;
  const index = currentTurnIndex(session);
  if (index === -1) return null;
  const turn = session.turns[index];
  return { turnIndex: index, kind: turn.kind, questionId: turn.questionId, questionText: turn.questionText, number: session.currentIndex + 1, of: session.length };
};

const toSessionResponse = (session) => ({
  id: idOf(session),
  kitId: String(session.kitId),
  status: session.status,
  length: session.length,
  plan: session.plan,
  currentIndex: session.currentIndex,
  currentQuestion: currentQuestionOf(session),
  turns: session.turns,
  report: session.report || null,
  reportError: session.reportError || null,
  abandonedReason: session.abandonedReason || null,
  modelsUsed: session.modelsUsed || {},
  lastActivityAt: session.lastActivityAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const toSessionSummary = (session) => ({
  id: idOf(session),
  status: session.status,
  length: session.length,
  overallScore: session.report?.overallScore ?? null,
  createdAt: session.createdAt,
});

// ---- store -----------------------------------------------------------------------------------

class DuplicateActiveSessionError extends Error {
  constructor() {
    super('An active mock interview already exists for this user.');
    this.name = 'DuplicateActiveSessionError';
  }
}

const isDuplicateActive = (error) => error?.code === 11000;

// The MongoDB store. Every method is scoped to the owner where it reads.
const mongoMockStore = {
  async create(doc) {
    try {
      return (await MockInterview.create(doc)).toObject();
    } catch (error) {
      if (isDuplicateActive(error)) throw new DuplicateActiveSessionError();
      throw error;
    }
  },
  findOwned: (id, userId) => MockInterview.findOne({ _id: id, userId }).lean(),
  findActive: (userId) => MockInterview.findOne({ userId, status: 'active' }).lean(),
  listForKit: (userId, kitId, limit) => MockInterview.find({ userId, kitId }).sort({ createdAt: -1 }).limit(limit).lean(),
  // Applies `set` only when `match` (extra filter) still holds; returns the updated session or null.
  update: (id, userId, match, set) => MockInterview.findOneAndUpdate({ _id: id, userId, ...match }, { $set: set }, { returnDocument: 'after' }).lean(),
  async expireStale(userId, cutoff) {
    const result = await MockInterview.updateMany(
      { userId, status: 'active', lastActivityAt: { $lt: cutoff } },
      { $set: { status: 'abandoned', abandonedReason: 'inactive' } }
    );
    return result.modifiedCount || 0;
  },
};

/** Marks the user's active sessions idle for 24 h as abandoned. */
const expireStale = async (store, userId, now = new Date()) => {
  const expired = await store.expireStale(userId, new Date(now.getTime() - INACTIVITY_MS));
  if (expired) console.info('Mock interviews abandoned after 24 h without activity.', JSON.stringify({ count: expired }));
  return expired;
};

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  INACTIVITY_MS,
  LIST_LIMIT,
  STAGES,
  REPORT_UNAVAILABLE,
  MockInterviewError,
  DuplicateActiveSessionError,
  selectPlan,
  parseLength,
  validateFollowUpText,
  decideFollowUp,
  currentTurnIndex,
  mainTurn,
  applyGradedTurn,
  allowedTopicsFor,
  overallScoreOf,
  buildReportPrompt,
  parseReport,
  generateReport,
  isValidReportOutcome,
  gradingContextFor,
  toSessionResponse,
  toSessionSummary,
  mongoMockStore,
  expireStale,
};
