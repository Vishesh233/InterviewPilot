const InterviewPrepKit = require('../models/InterviewPrepKit');
const GenerationJob = require('../models/GenerationJob');
const { validateKitStructure } = require('../services/kitStructureValidator');
const kitBuilderService = require('../services/kitBuilderService');
const practiceService = require('../services/practiceService');
const { assertPublicKitUrls } = require('../services/pipelineKitService');
const { isPlainSafeObject, hasUnsafeKeys } = require('../services/inputValidationService');
const { checkCoverage } = require('../services/coverageService');
const { cleanStoredCompanyName } = require('../services/companyName');
const { withAnswerFeedbackResponse } = require('../services/answerFeedbackService');

const KIT_FIELDS = [
  'source',
  'company_brief',
  'role',
  'questions',
  'flashcards',
  'schedule',
  'coverage',
  // Optional, additive resume sections (absent on JD-only kits).
  'resume',
  'resume_analysis',
];

// Kits saved before company names were derived store the page <title>
// ("Agentic Infrastructure - Vercel"). The name is cleaned when it is read: no
// fetch and no write, and cleanStoredCompanyName only shortens a multi-part
// title to the segment naming the kit's own domain, so any other name is
// returned unchanged.
const withCleanCompanyName = (kit) => {
  const brief = kit?.company_brief;
  if (!brief || typeof brief !== 'object' || typeof brief.name !== 'string') return kit;
  const name = cleanStoredCompanyName(brief.name, kit.source?.companyUrl);
  return name === brief.name ? kit : { ...kit, company_brief: { ...brief, name } };
};

// Normalize outgoing kit response: ensures builder metadata and practice defaults are present.
// answer_feedback (practice-answer history), when the kit has any, is keyed by
// question id; kits without it (older kits, the list view) leave it out.
const toKitResponse = (kit) =>
  withAnswerFeedbackResponse(withCleanCompanyName(practiceService.withPracticeDefaults(kitBuilderService.withBuilderMetadata(kit))));

// The request body IS the kit. Never trust a client-supplied owner.
const kitFromBody = (body) => {
  const kit = {};
  for (const field of KIT_FIELDS) {
    kit[field] = body ? body[field] : undefined;
  }
  return kit;
};

// Coverage is always computed here, never taken from the client: any
// client-sent coverage is discarded. Same rule as the generation pipeline —
// the requirement universe is role.requirements, and resume questions are left
// out so they can never hide a coverage gap.
const withServerCoverage = (kit) => ({
  ...kit,
  coverage: checkCoverage({
    requirements: { mustHaveSkills: kitBuilderService.requirementIdsFromKit(kit) },
    questions: (Array.isArray(kit.questions) ? kit.questions : [])
      .filter((question) => question?.category !== 'resume'),
  }),
});

const unsafeKitBody = (body) => !isPlainSafeObject(body) || hasUnsafeKeys(body);

const validationResponse = (res, result) =>
  res.status(400).json({
    error: {
      code: 'KIT_VALIDATION_FAILED',
      message: 'Interview-prep kit failed structure validation.',
      details: result.errors.map(({ path, code }) => ({ path, code })),
    },
  });

const isNotFoundOrForeign = (doc) => !doc;

// POST /api/kits
// The request body IS the kit. Never trust a client-supplied owner.
// Newly generated questions always get builder metadata: status "generated", pinned false.
// Flashcards receive defaulted practice state: confidence: null, covered: false.
const createKit = async (req, res) => {
  try {
    if (unsafeKitBody(req.body)) {
      return validationResponse(res, { errors: [{ path: '$', code: 'UNSAFE_BODY' }] });
    }
    const withMetadata = kitBuilderService.applyKitQuestionMetadata(withServerCoverage(kitFromBody(req.body)));
    const kit = practiceService.applyKitPracticeDefaults(withMetadata);
    const result = validateKitStructure(kit);
    if (!result.valid) {
      return validationResponse(res, result);
    }
    const urlError = assertPublicKitUrls(kit);
    if (urlError) return validationResponse(res, { errors: [urlError] });
    const created = await InterviewPrepKit.create({ ...kit, userId: req.userId });
    return res.status(201).json(toKitResponse(created));
  } catch (error) {
    if (error && error.name === 'ValidationError') {
      return res.status(400).json({
        error: {
          code: 'KIT_VALIDATION_FAILED',
          message: 'Interview-prep kit failed structure validation.',
          details: error.errors
            ? Object.keys(error.errors).map((path) => ({ path, code: 'SCHEMA_VALIDATION_FAILED' }))
            : [{ path: '$', code: 'SCHEMA_VALIDATION_FAILED' }],
        },
      });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/kits
const listKits = async (req, res) => {
  try {
    // The answer-feedback history is only needed on the kit page; leave it out here.
    const kits = await InterviewPrepKit.find({ userId: req.userId }, { answer_feedback: 0 }).sort({ createdAt: -1 });
    return res.json(Array.isArray(kits) ? kits.map((kit) => toKitResponse(kit)) : kits);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/kits/:id
const getKitById = async (req, res) => {
  try {
    const kit = await InterviewPrepKit.findOne({ _id: req.params.id, userId: req.userId });
    if (isNotFoundOrForeign(kit)) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    return res.json(toKitResponse(kit));
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Kit not found' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/kits/:id
// A whole-kit replace must not lose builder metadata or flashcard practice state:
//   * status/pinned the client did not restate are carried over from stored;
//   * flashcard practice state for existing card ids is carried over from stored;
//   * new flashcards receive default practice state.
const updateKit = async (req, res) => {
  try {
    if (unsafeKitBody(req.body)) {
      return validationResponse(res, { errors: [{ path: '$', code: 'UNSAFE_BODY' }] });
    }
    const kit = withServerCoverage(kitFromBody(req.body));
    const result = validateKitStructure(kit);
    if (!result.valid) {
      return validationResponse(res, result);
    }
    const urlError = assertPublicKitUrls(kit);
    if (urlError) return validationResponse(res, { errors: [urlError] });
    const stored = await InterviewPrepKit.findOne({ _id: req.params.id, userId: req.userId });
    const withMergedQuestions = kitBuilderService.applyKitQuestionMetadata(
      kitBuilderService.mergeStoredQuestionMetadata(stored, kit)
    );
    const persisted = practiceService.mergeStoredFlashcardPractice(stored, withMergedQuestions);
    const updated = await InterviewPrepKit.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: persisted },
      { returnDocument: 'after' }
    );
    if (isNotFoundOrForeign(updated)) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    return res.json(toKitResponse(updated));
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Kit not found' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

// DELETE /api/kits/:id
// Owner only (another user's kit is a 404). Refused with 409 while a generation
// job for the kit is still active; otherwise the kit and its finished jobs are
// removed. Both job queries are scoped to req.userId, so they never reveal
// whether another user's kit exists.
const deleteKit = async (req, res) => {
  try {
    const kitJobs = { userId: req.userId, $or: [{ kitId: req.params.id }, { 'result.kitId': req.params.id }] };
    const activeJob = await GenerationJob.exists({ ...kitJobs, status: { $in: GenerationJob.ACTIVE_JOB_STATUSES } });
    if (activeJob) {
      return res.status(409).json({
        error: {
          code: 'KIT_JOB_ACTIVE',
          message: 'This kit is still being updated. Wait for the generation to finish, then delete it.',
          jobId: String(activeJob._id),
        },
      });
    }
    const deleted = await InterviewPrepKit.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (isNotFoundOrForeign(deleted)) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    // The kit is gone at this point. A failed cleanup is logged, not reported
    // as a failed delete: finished jobs also expire through their TTL index.
    try {
      await GenerationJob.deleteMany({ ...kitJobs, status: { $nin: GenerationJob.ACTIVE_JOB_STATUSES } });
    } catch (cleanupError) {
      console.error('Kit deleted, but its finished jobs could not be removed.', JSON.stringify({ name: cleanupError?.name || null, code: cleanupError?.code ?? null }));
    }
    return res.json({ message: 'Kit deleted' });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Kit not found' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { createKit, listKits, getKitById, updateKit, deleteKit };
