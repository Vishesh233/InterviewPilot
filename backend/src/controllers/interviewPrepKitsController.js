const InterviewPrepKit = require('../models/InterviewPrepKit');
const { validateKitStructure } = require('../services/kitStructureValidator');
const kitBuilderService = require('../services/kitBuilderService');
const practiceService = require('../services/practiceService');
const { assertSafeUrl } = require('../services/urlSecurityService');
const { isPlainSafeObject, hasUnsafeKeys } = require('../services/inputValidationService');

const KIT_FIELDS = [
  'source',
  'company_brief',
  'role',
  'questions',
  'flashcards',
  'schedule',
  'coverage',
];

// Normalize outgoing kit response: ensures builder metadata and practice defaults are present.
const toKitResponse = (kit) =>
  practiceService.withPracticeDefaults(kitBuilderService.withBuilderMetadata(kit));

// The request body IS the kit. Never trust a client-supplied owner.
const kitFromBody = (body) => {
  const kit = {};
  for (const field of KIT_FIELDS) {
    kit[field] = body ? body[field] : undefined;
  }
  return kit;
};

const unsafeKitBody = (body) => !isPlainSafeObject(body) || hasUnsafeKeys(body);

const assertPublicKitUrls = (kit) => {
  const urls = [
    ['$.source.companyUrl', kit.source?.companyUrl],
    ...(Array.isArray(kit.company_brief?.sources)
      ? kit.company_brief.sources.map((source, index) => [`$.company_brief.sources[${index}].url`, source?.url])
      : []),
  ];
  for (const [path, value] of urls) {
    if (typeof value !== 'string') continue;
    try {
      assertSafeUrl(value);
    } catch (error) {
      return { path, code: 'URL_NOT_ALLOWED' };
    }
  }
  return null;
};

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
    const withMetadata = kitBuilderService.applyKitQuestionMetadata(kitFromBody(req.body));
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
    const kits = await InterviewPrepKit.find({ userId: req.userId }).sort({ createdAt: -1 });
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
    const kit = kitFromBody(req.body);
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
      { new: true }
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
const deleteKit = async (req, res) => {
  try {
    const deleted = await InterviewPrepKit.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (isNotFoundOrForeign(deleted)) {
      return res.status(404).json({ message: 'Kit not found' });
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
