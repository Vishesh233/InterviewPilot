// Kit Builder service — deterministic, LLM-free logic behind the Kit Builder API.
// Responsibilities: builder metadata (status/pinned), single-question edits,
// question reordering, pin/unpin, and the kit-derived requirement/research inputs
// used by regeneration. No LLM, no I/O, no mutation of the caller's objects.
// HTTP handling lives in interviewPrepKitBuilderController.js and LLM
// orchestration lives in kitRegenerationService.js.

const { checkCoverage } = require('./coverageService');
const { createSchedule } = require('./scheduleService');
const { hasUnsafeKeys, isSafeIdentifier } = require('./inputValidationService');

// Question builder metadata. Newly generated questions are "generated" + unpinned;
// any user edit flips status to "edited"; pinning only flips the pinned flag.
const QUESTION_STATUS = { GENERATED: 'generated', EDITED: 'edited' };

// Appendix A-compatible kit sections (mirrors KIT_FIELDS in the CRUD controller).
const KIT_SECTIONS = [
  'source',
  'company_brief',
  'role',
  'questions',
  'flashcards',
  'schedule',
  'coverage',
];

// A schedule day may store its question ids under any of these keys (all accepted
// by kitStructureValidator); the builder preserves whichever key the kit uses.
const SCHEDULE_DAY_ID_KEYS = ['question_ids', 'questionIds', 'questions'];

const MIN_INTERVIEW_DAYS = 1;
const MAX_INTERVIEW_DAYS = 60;

// Canonical question fields a user may change through the builder, plus the input
// aliases accepted for convenience. Aliases are always persisted canonically.
const EDITABLE_QUESTION_FIELDS = [
  'question',
  'expectedAnswerPoints',
  'category',
  'difficulty',
  'why',
  'followUps',
  'sources',
  'requirementRefs',
];
const QUESTION_FIELD_ALIASES = { prompt: 'question', answerOutline: 'expectedAnswerPoints' };

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const trimString = (value) => (typeof value === 'string' ? value.trim() : value);

/**
 * Structured builder failure. `code` is machine-readable, `status` is the HTTP
 * status the controller should use, `details` carries the validation context.
 */
class KitBuilderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KitBuilderError';
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : 400;
    if (options.details !== undefined) this.details = options.details;
  }
}

// ---- builder metadata ------------------------------------------------------

// Add/repair status + pinned without touching any other question field.
const applyQuestionMetadata = (question) => {
  if (!isPlainObject(question)) return question;
  return {
    ...question,
    status: question.status === QUESTION_STATUS.EDITED ? QUESTION_STATUS.EDITED : QUESTION_STATUS.GENERATED,
    pinned: question.pinned === true,
  };
};

// Same, for every question of a kit. Kits without a question array are returned
// untouched so the structure validator can report the real problem.
const applyKitQuestionMetadata = (kit) => {
  if (!isPlainObject(kit) || !Array.isArray(kit.questions)) return kit;
  return { ...kit, questions: kit.questions.map(applyQuestionMetadata) };
};

// Mongoose documents (and lean/plain objects) both work with the builder.
const toPlainKit = (kit) => {
  if (kit && typeof kit.toObject === 'function') return kit.toObject();
  return kit;
};

// Response/intermediate form: plain kit object with defaulted question metadata.
const withBuilderMetadata = (kit) => applyKitQuestionMetadata(toPlainKit(kit));

// Only the Appendix A sections are ever written back to Mongo ($set), so
// _id/userId/__v/createdAt can never be part of an update payload.
const pickKitSections = (kit) => {
  const picked = {};
  if (!isPlainObject(kit)) return picked;
  for (const section of KIT_SECTIONS) {
    if (kit[section] !== undefined) picked[section] = kit[section];
  }
  return picked;
};

/**
 * Carry builder metadata over from the stored kit onto a whole-kit PUT payload.
 * Questions the client did not restate keep their persisted status/pinned values;
 * explicit client values always win. New/removed questions are left alone.
 */
const mergeStoredQuestionMetadata = (storedKit, kit) => {
  const stored = toPlainKit(storedKit);
  if (!isPlainObject(kit) || !Array.isArray(kit.questions)) return kit;
  if (!isPlainObject(stored) || !Array.isArray(stored.questions)) return kit;

  const storedById = new Map();
  for (const question of stored.questions) {
    const id = trimString(question?.id);
    if (isPlainObject(question) && typeof id === 'string' && id) storedById.set(id, question);
  }

  return {
    ...kit,
    questions: kit.questions.map((question) => {
      const id = trimString(question?.id);
      const previous = typeof id === 'string' ? storedById.get(id) : undefined;
      if (!isPlainObject(question) || !isPlainObject(previous)) return question;
      const next = { ...question };
      if (next.pinned === undefined && previous.pinned === true) next.pinned = true;
      if (next.status === undefined && previous.status === QUESTION_STATUS.EDITED) {
        next.status = QUESTION_STATUS.EDITED;
      }
      return next;
    }),
  };
};

// ---- kit introspection -----------------------------------------------------

const kitQuestions = (kit) => (isPlainObject(kit) && Array.isArray(kit.questions) ? kit.questions : null);

const requireKitQuestions = (kit) => {
  const questions = kitQuestions(kit);
  if (!questions) {
    throw new KitBuilderError('BUILDER_INVALID_KIT', 'This kit has no question list to build on.', {
      status: 409,
    });
  }
  return questions;
};

const questionIndexById = (questions, questionId) => {
  if (!isSafeIdentifier(questionId)) return -1;
  return questions.findIndex((question) => question?.id === questionId);
};

const requireQuestionIndex = (questions, questionId) => {
  const index = questionIndexById(questions, questionId);
  if (index === -1) {
    throw new KitBuilderError('QUESTION_NOT_FOUND', 'No question with that id exists in this kit.', {
      status: 404,
      details: { questionId: isSafeIdentifier(questionId) ? questionId : null },
    });
  }
  return index;
};

// Requirement ids the kit's questions may reference (entry.id wins, matching
// kitStructureValidator, so the builder and the validator agree on valid refs).
const requirementIdsFromKit = (kit) => {
  const entries =
    isPlainObject(kit) && isPlainObject(kit.role) && Array.isArray(kit.role.requirements)
      ? kit.role.requirements
      : [];
  const ids = [];
  for (const entry of entries) {
    let id = '';
    if (typeof entry === 'string') {
      id = entry.trim();
    } else if (isPlainObject(entry)) {
      for (const key of ['id', 'text', 'requirement', 'name', 'title']) {
        if (typeof entry[key] === 'string' && entry[key].trim()) {
          id = entry[key].trim();
          break;
        }
      }
    }
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

// extractRequirements()-compatible subset reconstructed from a saved kit, so the
// existing question-generation / coverage services run against it unchanged.
const builderRequirementsFrom = (kit) => {
  const role = isPlainObject(kit) && isPlainObject(kit.role) ? kit.role : {};
  return {
    role: typeof role.title === 'string' ? role.title : null,
    seniority: typeof role.level === 'string' ? role.level : null,
    mustHaveSkills: requirementIdsFromKit(kit),
  };
};

// Company research reconstructed from the stored company_brief: the stored source
// URLs are the only URLs regenerated questions may use.
const builderResearchFrom = (kit) => {
  const brief = isPlainObject(kit) && isPlainObject(kit.company_brief) ? kit.company_brief : {};
  const sources = Array.isArray(brief.sources) ? brief.sources : [];
  return {
    companyTitle: typeof brief.name === 'string' ? brief.name : '',
    sources: sources
      .filter((source) => isPlainObject(source) && typeof source.url === 'string' && source.url.trim())
      .map((source) => ({
        url: source.url.trim(),
        title: typeof source.title === 'string' ? source.title : '',
        category: typeof source.category === 'string' ? source.category : 'other',
        text: typeof source.text === 'string' ? source.text : '',
      })),
  };
};

const allowedSourceUrls = (kit) => new Set(builderResearchFrom(kit).sources.map((source) => source.url));

// ---- coverage + schedule ---------------------------------------------------

// Recompute the deterministic coverage block for a question list, preserving any
// extra fields the stored coverage may carry.
const withRecomputedCoverage = (kit, questions) => {
  if (!isPlainObject(kit) || !isPlainObject(kit.role) || !Array.isArray(kit.role.requirements)) return kit;
  const coverage = checkCoverage({ requirements: builderRequirementsFrom(kit), questions });
  return {
    ...kit,
    coverage: { ...(isPlainObject(kit.coverage) ? kit.coverage : {}), ...coverage },
  };
};

const toInterviewDays = (schedule) => {
  const explicit = schedule?.interviewDays;
  if (Number.isInteger(explicit) && explicit >= MIN_INTERVIEW_DAYS && explicit <= MAX_INTERVIEW_DAYS) {
    return explicit;
  }
  const dayCount = Array.isArray(schedule?.days) ? schedule.days.length : 0;
  return dayCount >= MIN_INTERVIEW_DAYS ? dayCount : MIN_INTERVIEW_DAYS;
};

const scheduleDayIdKey = (schedule) => {
  const days = Array.isArray(schedule?.days) ? schedule.days : [];
  for (const day of days) {
    if (!isPlainObject(day)) continue;
    for (const key of SCHEDULE_DAY_ID_KEYS) {
      if (Array.isArray(day[key])) return key;
    }
  }
  return 'questions';
};

/**
 * Re-spread the current question order across the existing number of interview
 * days (reuses the deterministic scheduler), keeping the day count and the id key
 * of the stored schedule. Question ids themselves are never changed here. If the
 * schedule is malformed it is left untouched so kitStructureValidator reports it.
 */
const rebuildScheduleForQuestions = (kit, questions) => {
  if (!isPlainObject(kit) || !isPlainObject(kit.schedule) || !Array.isArray(kit.schedule.days)) return kit;
  try {
    const rebuilt = createSchedule({ questions, interviewDays: toInterviewDays(kit.schedule) });
    const idKey = scheduleDayIdKey(kit.schedule);
    return {
      ...kit,
      schedule: {
        ...kit.schedule,
        interviewDays: rebuilt.interviewDays,
        days: rebuilt.days.map((day) => ({ day: day.day, [idKey]: day.questions })),
      },
    };
  } catch (error) {
    return kit;
  }
};

// Point flashcard question references at the replacement question id when the
// question they referenced was regenerated (keeps the kit free of orphan ids).
const withRemappedFlashcardRefs = (kit, idMap) => {
  if (!isPlainObject(kit) || !(idMap instanceof Map) || idMap.size === 0) return kit;
  if (!Array.isArray(kit.flashcards)) return kit;
  return {
    ...kit,
    flashcards: kit.flashcards.map((card) => {
      if (!isPlainObject(card)) return card;
      const next = { ...card };
      for (const key of ['questionIds', 'question_ids']) {
        if (Array.isArray(card[key])) {
          next[key] = card[key].map((id) => idMap.get(trimString(id)) ?? id);
        }
      }
      return next;
    }),
  };
};

// ---- question editing ------------------------------------------------------

// Keep only the fields a user may edit (canonical wins over alias). id, status,
// pinned, userId and every unknown field are ignored on input.
const normalizeQuestionChanges = (body) => {
  if (!isPlainObject(body) || hasUnsafeKeys(body)) {
    throw new KitBuilderError('BUILDER_INVALID_PAYLOAD', 'Request body must be a safe JSON object.', {
      status: 400,
    });
  }
  const changes = {};
  for (const field of EDITABLE_QUESTION_FIELDS) {
    if (body[field] !== undefined) changes[field] = body[field];
  }
  for (const [alias, canonical] of Object.entries(QUESTION_FIELD_ALIASES)) {
    if (changes[canonical] === undefined && body[alias] !== undefined) changes[canonical] = body[alias];
  }
  return changes;
};

/**
 * Apply a user edit to one question.
 * - status becomes "edited"
 * - the id and the pinned flag are preserved
 * - requirementRefs/sources are preserved unless explicitly sent
 * - every other question is returned untouched (metadata defaulted)
 * Coverage is recomputed only when requirement references actually changed.
 */
const editQuestion = ({ kit, questionId, changes }) => {
  const questions = requireKitQuestions(kit);
  const index = requireQuestionIndex(questions, questionId);
  const target = questions[index];
  const normalized = normalizeQuestionChanges(changes);
  if (Object.keys(normalized).length === 0) {
    throw new KitBuilderError('BUILDER_NO_UPDATABLE_FIELDS', 'No editable question fields were provided.', {
      status: 400,
      details: { allowedFields: EDITABLE_QUESTION_FIELDS, aliases: QUESTION_FIELD_ALIASES },
    });
  }

  const edited = applyQuestionMetadata({
    ...target,
    ...normalized,
    id: target.id,
    status: QUESTION_STATUS.EDITED,
  });

  const nextQuestions = questions.map((question, position) =>
    position === index ? edited : applyQuestionMetadata(question)
  );
  let nextKit = { ...kit, questions: nextQuestions };
  if (normalized.requirementRefs !== undefined) {
    nextKit = withRecomputedCoverage(nextKit, nextQuestions);
  }

  return { kit: nextKit, question: edited };
};

// ---- pin / unpin -----------------------------------------------------------

/**
 * Pin or unpin one question. Only the pinned flag changes: the question keeps its
 * id, its content and its status, and it stays part of the kit.
 */
const setQuestionPinned = ({ kit, questionId, pinned }) => {
  const questions = requireKitQuestions(kit);
  if (typeof pinned !== 'boolean') {
    throw new KitBuilderError('BUILDER_INVALID_PIN_PAYLOAD', 'pinned must be a boolean.', {
      status: 400,
      details: { received: pinned === undefined ? null : typeof pinned },
    });
  }
  const index = requireQuestionIndex(questions, questionId);
  const nextQuestions = questions.map((question, position) =>
    position === index ? applyQuestionMetadata({ ...question, pinned }) : applyQuestionMetadata(question)
  );
  return { kit: { ...kit, questions: nextQuestions }, question: nextQuestions[index] };
};

// ---- reordering ------------------------------------------------------------

// Collect ids that appear more than once, preserving first-seen order.
const findDuplicateIds = (ids) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

/**
 * Apply a new question order. Content is never regenerated: the very same question
 * objects are re-sequenced, ids are preserved, and the schedule is re-spread over
 * the same days in the new order (ids unchanged).
 *
 * Rejected: non-array input, empty/non-string entries, duplicate ids, ids that are
 * not in this kit, and lists that omit any of the kit's questions.
 */
const reorderQuestions = ({ kit, questionIds }) => {
  const questions = requireKitQuestions(kit);

  if (!Array.isArray(questionIds)) {
    throw new KitBuilderError('BUILDER_INVALID_ORDER', 'questionIds must be an array of question ids.', {
      status: 400,
      details: { received: questionIds === undefined ? null : typeof questionIds },
    });
  }

  const ordered = questionIds.map((id) => id);
  const invalid = ordered.filter((id) => !isSafeIdentifier(id));
  if (invalid.length > 0) {
    throw new KitBuilderError('BUILDER_INVALID_ORDER', 'Every question id must be a non-empty string.', {
      status: 400,
      details: { invalidEntries: invalid.length },
    });
  }

  const duplicates = findDuplicateIds(ordered);
  if (duplicates.length > 0) {
    throw new KitBuilderError('BUILDER_DUPLICATE_QUESTION_IDS', 'The order contains duplicate question ids.', {
      status: 400,
      details: { duplicateQuestionIds: duplicates },
    });
  }

  const existingIds = questions.map((question) => question?.id);
  const unknown = ordered.filter((id) => !existingIds.includes(id));
  if (unknown.length > 0) {
    throw new KitBuilderError('BUILDER_UNKNOWN_QUESTION_IDS', 'The order contains unknown question ids.', {
      status: 400,
      details: { unknownQuestionIds: unknown },
    });
  }

  const missing = existingIds.filter((id) => !ordered.includes(id));
  if (missing.length > 0) {
    throw new KitBuilderError(
      'BUILDER_MISSING_QUESTION_IDS',
      'The order must list every question of the kit exactly once.',
      { status: 400, details: { missingQuestionIds: missing } }
    );
  }

  const byId = new Map(questions.map((question) => [question?.id, question]));
  const nextQuestions = ordered.map((id) => applyQuestionMetadata(byId.get(id)));
  const nextKit = rebuildScheduleForQuestions({ ...kit, questions: nextQuestions }, nextQuestions);

  return { kit: nextKit, questions: nextQuestions };
};

// ---- helpers shared with the regeneration service --------------------------

const isEditableQuestion = (question) =>
  isPlainObject(question) && question.status !== QUESTION_STATUS.EDITED;

const isPinnedQuestion = (question) => isPlainObject(question) && question.pinned === true;

// A question may be replaced by regeneration only when it is neither edited nor pinned.
const isReplaceableQuestion = (question) => isEditableQuestion(question) && !isPinnedQuestion(question);

// Highest numeric suffix of the "<prefix><n>" id convention (q1, q2, ...); 0 when none.
const maxNumericSuffix = (ids) =>
  (Array.isArray(ids) ? ids : []).reduce((max, id) => {
    const match = typeof id === 'string' ? /^q(\d+)$/.exec(id.trim()) : null;
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

/** Deterministically allocate `count` fresh ids that collide with nothing. */
const allocateQuestionIds = (existingIds, count) => {
  const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map((id) => trimString(id)));
  const allocated = [];
  let cursor = maxNumericSuffix([...taken]);
  while (allocated.length < count) {
    cursor += 1;
    let candidate = `q${cursor}`;
    while (taken.has(candidate)) {
      cursor += 1;
      candidate = `q${cursor}`;
    }
    taken.add(candidate);
    allocated.push(candidate);
  }
  return allocated;
};

/**
 * Give freshly appended questions (e.g. gap-fill output) ids that clash with the
 * kept questions a new, deterministic id. The first `originalCount` questions are
 * left exactly as they are — their ids are referenced by schedule/flashcards.
 */
const dedupeAppendedQuestionIds = (questions, originalCount) => {
  if (!Array.isArray(questions)) return questions;
  const keptCount = Number.isInteger(originalCount) ? originalCount : 0;
  const taken = new Set(questions.slice(0, keptCount).map((question) => trimString(question?.id)));
  let cursor = maxNumericSuffix([...taken]);
  return questions.map((question, index) => {
    if (index < keptCount || !isPlainObject(question)) return question;
    const id = trimString(question?.id);
    if (typeof id === 'string' && id && !taken.has(id)) {
      taken.add(id);
      return question;
    }
    cursor += 1;
    let candidate = `q${cursor}`;
    while (taken.has(candidate)) {
      cursor += 1;
      candidate = `q${cursor}`;
    }
    taken.add(candidate);
    return { ...question, id: candidate };
  });
};

module.exports = {
  QUESTION_STATUS,
  EDITABLE_QUESTION_FIELDS,
  QUESTION_FIELD_ALIASES,
  KIT_SECTIONS,
  KitBuilderError,
  isPlainObject,
  trimString,
  applyQuestionMetadata,
  applyKitQuestionMetadata,
  withBuilderMetadata,
  toPlainKit,
  pickKitSections,
  mergeStoredQuestionMetadata,
  kitQuestions,
  requireKitQuestions,
  questionIndexById,
  requireQuestionIndex,
  requirementIdsFromKit,
  builderRequirementsFrom,
  builderResearchFrom,
  allowedSourceUrls,
  withRecomputedCoverage,
  scheduleDayIdKey,
  rebuildScheduleForQuestions,
  withRemappedFlashcardRefs,
  normalizeQuestionChanges,
  editQuestion,
  setQuestionPinned,
  reorderQuestions,
  isReplaceableQuestion,
  allocateQuestionIds,
  dedupeAppendedQuestionIds,
};

