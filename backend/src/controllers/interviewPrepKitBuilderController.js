// Kit Builder HTTP layer.
// Only request parsing/ownership/HTTP statuses live here: the deterministic
// builder logic is in kitBuilderService.js and regeneration is in
// kitRegenerationService.js.
// Every route is authenticated and ownership always comes from req.userId, so a
// kit (or question) that belongs to another user is indistinguishable from a
// missing one (404).

const InterviewPrepKit = require('../models/InterviewPrepKit');
const kitBuilderService = require('../services/kitBuilderService');
const kitRegenerationService = require('../services/kitRegenerationService');
const { validateKitStructure } = require('../services/kitStructureValidator');
const { hasUnsafeKeys } = require('../services/inputValidationService');

const { KitBuilderError } = kitBuilderService;

// Same structured validation payload as interviewPrepKitsController.
const validationResponse = (res, result) =>
  res.status(400).json({
    error: {
      code: 'KIT_VALIDATION_FAILED',
      message: 'Interview-prep kit failed structure validation.',
      details: result.errors.map(({ path, code }) => ({ path, code })),
    },
  });

const respondWithBuilderError = (res, error) => {
  if (error instanceof KitBuilderError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
  }
  if (error && error.name === 'CastError') {
    return res.status(404).json({ message: 'Kit not found' });
  }
  console.error('Kit Builder request failed.', { name: error?.name, code: error?.code });
  return res.status(500).json({ message: 'Server error' });
};

const bodyOf = (req) => {
  const body = req.body;
  if (
    !body || typeof body !== 'object' || Array.isArray(body) ||
    (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) ||
    hasUnsafeKeys(body)
  ) {
    throw new KitBuilderError('BUILDER_INVALID_PAYLOAD', 'Request body must be a safe JSON object.', {
      status: 400,
    });
  }
  return body;
};

// Ownership is enforced in the query itself: never trust a client-supplied userId.
const loadOwnedKit = async (req) => {
  const kit = await InterviewPrepKit.findOne({ _id: req.params.id, userId: req.userId });
  if (!kit) {
    throw new KitBuilderError('KIT_NOT_FOUND', 'Kit not found.', { status: 404 });
  }
  return kit;
};

// Write back only the Appendix A sections, so _id/userId/timestamps are untouched.
const persistKit = async (req, kit) => {
  const updated = await InterviewPrepKit.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: kitBuilderService.pickKitSections(kit) },
    { new: true }
  );
  if (!updated) {
    throw new KitBuilderError('KIT_NOT_FOUND', 'Kit not found.', { status: 404 });
  }
  return updated;
};

// Apply a deterministic builder change, validate the COMPLETE kit, then persist.
// Nothing is written when validation fails.
const applyAndPersist = async (req, res, mutate) => {
  try {
    const kit = kitBuilderService.withBuilderMetadata(await loadOwnedKit(req));
    const result = mutate(kit);
    const validation = validateKitStructure(result.kit);
    if (!validation.valid) {
      return validationResponse(res, validation);
    }
    const updated = await persistKit(req, result.kit);
    return res.json(kitBuilderService.withBuilderMetadata(updated));
  } catch (error) {
    return respondWithBuilderError(res, error);
  }
};

// PATCH /api/kits/:id/questions/:questionId — edit one question (status -> edited).
const updateKitQuestion = (req, res) =>
  applyAndPersist(req, res, (kit) =>
    kitBuilderService.editQuestion({
      kit,
      questionId: req.params.questionId,
      changes: req.body,
    })
  );

// PATCH /api/kits/:id/questions/reorder — new question order, same questions/ids.
const reorderKitQuestions = (req, res) =>
  applyAndPersist(req, res, (kit) => {
    const body = bodyOf(req);
    return kitBuilderService.reorderQuestions({
      kit,
      questionIds: body.questionIds !== undefined ? body.questionIds : body.order,
    });
  });

// PATCH /api/kits/:id/questions/:questionId/pin — pin/unpin without editing content.
const setKitQuestionPinned = (req, res) =>
  applyAndPersist(req, res, (kit) => {
    const body = bodyOf(req);
    return kitBuilderService.setQuestionPinned({
      kit,
      questionId: req.params.questionId,
      pinned: body.pinned !== undefined ? body.pinned : body.pin,
    });
  });

// POST /api/kits/:id/regenerate — replace only generated, unpinned section questions.
const regenerateKitSection = async (req, res) => {
  try {
    const body = bodyOf(req);
    const kit = kitBuilderService.withBuilderMetadata(await loadOwnedKit(req));
    const { kit: regenerated, summary } = await kitRegenerationService.regenerateKitSection({
      kit,
      category: body.category !== undefined ? body.category : body.section,
    });

    // The service already validated the result; re-check before the write so an
    // invalid regeneration can never be persisted.
    const validation = validateKitStructure(regenerated);
    if (!validation.valid) {
      return res.status(500).json({
        error: {
          code: 'KIT_REGENERATION_VALIDATION_FAILED',
          message: 'The regenerated kit failed structure validation and was not saved.',
          details: validation.errors.map(({ path, code }) => ({ path, code })),
        },
      });
    }

    const updated = await persistKit(req, regenerated);
    return res.json({ kit: kitBuilderService.withBuilderMetadata(updated), regeneration: summary });
  } catch (error) {
    return respondWithBuilderError(res, error);
  }
};

module.exports = {
  updateKitQuestion,
  reorderKitQuestions,
  setKitQuestionPinned,
  regenerateKitSection,
};
