// Practice Mode HTTP layer — deterministic endpoints for practice-state progress.

const InterviewPrepKit = require('../models/InterviewPrepKit');
const kitBuilderService = require('../services/kitBuilderService');
const practiceService = require('../services/practiceService');

const { PracticeError } = practiceService;
const { KitBuilderError } = kitBuilderService;

const respondWithPracticeError = (res, error) => {
  if (error instanceof PracticeError || error instanceof KitBuilderError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
  }

  if (error && error.name === 'CastError') {
    return res.status(404).json({
      error: {
        code: 'KIT_NOT_FOUND',
        message: 'Kit not found.',
      },
    });
  }

  console.error('Practice Mode request failed.', { name: error?.name, code: error?.code });
  return res.status(500).json({ message: 'Server error' });
};

const kitIdOf = (kit, req) => {
  if (kit && kit._id !== undefined && kit._id !== null) {
    return String(kit._id);
  }
  return String(req.params.id);
};

const loadOwnedPracticeKit = async (req) => {
  const kit = await InterviewPrepKit.findOne({
    _id: req.params.id,
    userId: req.userId,
  });

  if (!kit) {
    throw new PracticeError('KIT_NOT_FOUND', 'Kit not found.', { status: 404 });
  }

  return kit;
};

const persistPracticeKit = async (req, kit) => {
  const updated = await InterviewPrepKit.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: kitBuilderService.pickKitSections(kit) },
    { new: true }
  );

  if (!updated) {
    throw new PracticeError('KIT_NOT_FOUND', 'Kit not found.', { status: 404 });
  }

  return updated;
};

// GET /api/kits/:id/practice
// Derives the next practice session (ordered items + progress summary).
const getKitPractice = async (req, res) => {
  try {
    const stored = await loadOwnedPracticeKit(req);
    const kit = practiceService.withPracticeDefaults(stored);
    const items = practiceService.buildPracticeItems(kit);
    const progress = practiceService.computeProgress(items);

    return res.json({
      kitId: kitIdOf(kit, req),
      items,
      progress,
    });
  } catch (error) {
    return respondWithPracticeError(res, error);
  }
};

// PATCH /api/kits/:id/practice/:flashcardId
// Updates confidence (1-5 or null) and/or covered (boolean) for one flashcard.
const updateKitPractice = async (req, res) => {
  try {
    const stored = await loadOwnedPracticeKit(req);
    const { kit: updatedKit, item, progress } = practiceService.updatePracticeState({
      kit: stored,
      flashcardId: req.params.flashcardId,
      changes: req.body,
    });

    await persistPracticeKit(req, updatedKit);

    return res.json({
      kitId: kitIdOf(updatedKit, req),
      item,
      progress,
    });
  } catch (error) {
    return respondWithPracticeError(res, error);
  }
};

module.exports = {
  getKitPractice,
  updateKitPractice,
  respondWithPracticeError,
  loadOwnedPracticeKit,
  persistPracticeKit,
};
