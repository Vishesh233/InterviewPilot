const express = require('express');
const { generateInterviewPrep } = require('../controllers/interviewPrepController');
const requireAuth = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/api/interview-prep', requireAuth, generateInterviewPrep);

module.exports = router;
