const express = require('express');
const requireAuth = require('../middleware/authMiddleware');
const { rateLimiters } = require('../middleware/rateLimiters');
const {
  createMockInterview,
  listMockInterviews,
  getMockInterview,
  answerMockInterview,
  abandonMockInterview,
  retryMockReport,
} = require('../controllers/mockInterviewController');

const router = express.Router();

// Mock Interview Mode. Authenticated; ownership comes from req.userId only.
// Starting a session and answering (or retrying a report) have their own
// per-user limits.
router.post('/api/kits/:id/mock-interviews', requireAuth, rateLimiters.mockCreate, (req, res) => createMockInterview(req, res));
router.get('/api/kits/:id/mock-interviews', requireAuth, (req, res) => listMockInterviews(req, res));
router.get('/api/mock-interviews/:sid', requireAuth, (req, res) => getMockInterview(req, res));
router.post('/api/mock-interviews/:sid/answer', requireAuth, rateLimiters.mockTurn, (req, res) => answerMockInterview(req, res));
router.post('/api/mock-interviews/:sid/abandon', requireAuth, (req, res) => abandonMockInterview(req, res));
router.post('/api/mock-interviews/:sid/report', requireAuth, rateLimiters.mockTurn, (req, res) => retryMockReport(req, res));

module.exports = router;
