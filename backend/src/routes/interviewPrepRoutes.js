const express = require('express');
const { generateInterviewPrep } = require('../controllers/interviewPrepController');
const requireAuth = require('../middleware/authMiddleware');
const { rateLimiters } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/api/interview-prep', requireAuth, rateLimiters.jobCreate, generateInterviewPrep);

module.exports = router;
