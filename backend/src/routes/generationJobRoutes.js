const express = require('express');
const requireAuth = require('../middleware/authMiddleware');
const { getJob, resumeJob } = require('../controllers/generationJobsController');
const { rateLimiters } = require('../middleware/rateLimiters');

const router = express.Router();

// Background generation jobs. Authenticated; ownership comes from req.userId.
// Polling has its own per-user limit and is exempt from the /api baseline.
router.get('/api/jobs/:id', requireAuth, rateLimiters.jobPoll, (req, res) => getJob(req, res));
router.post('/api/jobs/:id/resume', requireAuth, (req, res) => resumeJob(req, res));

module.exports = router;
