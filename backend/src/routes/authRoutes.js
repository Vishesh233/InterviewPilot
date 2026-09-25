const express = require('express');
const { register, login } = require('../controllers/authController');
const requireAuth = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);

// Temporary protected route to verify the JWT middleware
router.get('/me', requireAuth, (req, res) => {
  res.json({ userId: req.userId });
});

module.exports = router;
