const express = require('express');
const { register, login } = require('../controllers/authController');
const { rateLimiters } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/register', rateLimiters.register, register);
router.post('/login', rateLimiters.login, login);

module.exports = router;
