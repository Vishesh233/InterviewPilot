const express = require('express');
const requireAuth = require('../middleware/authMiddleware');
const { getJob, resumeJob } = require('../controllers/generationJobsController');

const router = express.Router();

// Background generation jobs. Authenticated; ownership comes from req.userId.
router.get('/api/jobs/:id', requireAuth, (req, res) => getJob(req, res));
router.post('/api/jobs/:id/resume', requireAuth, (req, res) => resumeJob(req, res));

module.exports = router;
