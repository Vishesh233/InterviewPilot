const express = require('express');
const requireAuth = require('../middleware/authMiddleware');
const {
  createKit,
  listKits,
  getKitById,
  updateKit,
  deleteKit,
} = require('../controllers/interviewPrepKitsController');
const {
  updateKitQuestion,
  reorderKitQuestions,
  setKitQuestionPinned,
  regenerateKitSection,
  generateKitGapQuestions,
} = require('../controllers/interviewPrepKitBuilderController');
const {
  getKitPractice,
  updateKitPractice,
} = require('../controllers/interviewPrepPracticeController');

const router = express.Router();

// Every kit route is authenticated; ownership comes from req.userId only.
router.post('/api/kits', requireAuth, createKit);
router.get('/api/kits', requireAuth, listKits);
router.get('/api/kits/:id', requireAuth, getKitById);
router.put('/api/kits/:id', requireAuth, updateKit);
router.delete('/api/kits/:id', requireAuth, deleteKit);

// Kit Builder routes. The literal /questions/reorder route is declared before the
// /:questionId route so "reorder" is never parsed as a question id.
router.patch('/api/kits/:id/questions/reorder', requireAuth, reorderKitQuestions);
router.patch('/api/kits/:id/questions/:questionId/pin', requireAuth, setKitQuestionPinned);
router.patch('/api/kits/:id/questions/:questionId', requireAuth, updateKitQuestion);
router.post('/api/kits/:id/regenerate', requireAuth, regenerateKitSection);

// Coverage gap questions. The literal /gaps path is declared alongside the other
// literal kit routes, so it can never be parsed as a question id.
router.post('/api/kits/:id/gaps', requireAuth, generateKitGapQuestions);

// Practice Mode routes.
router.get('/api/kits/:id/practice', requireAuth, getKitPractice);
router.patch('/api/kits/:id/practice/:flashcardId', requireAuth, updateKitPractice);

module.exports = router;

