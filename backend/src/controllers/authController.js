const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isPlainSafeObject, hasUnsafeKeys, isBoundedString } = require('../services/inputValidationService');

const SALT_ROUNDS = 10;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

// Simple email format check
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// POST /api/auth/register
const register = async (req, res) => {
  try {
    if (
      !isPlainSafeObject(req.body) || hasUnsafeKeys(req.body) ||
      typeof req.body.email !== 'string' || typeof req.body.password !== 'string' ||
      !isBoundedString(req.body.email, MAX_EMAIL_LENGTH) ||
      !isBoundedString(req.body.password, MAX_PASSWORD_LENGTH, { allowEmpty: true }) ||
      req.body.password.length === 0
    ) {
      return res.status(400).json({ message: 'Email and password must be valid bounded strings.' });
    }
    const { email, password } = req.body;

    // 2. Normalize the email the same way the schema does (trim + lowercase)
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Please provide a valid email address' });
    }

    // 3. Check whether the email already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ message: 'Email is already registered' });
    }

    // 4. Hash the password — the plain password is never stored
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // 5. Create the user (only email + passwordHash are stored)
    const user = await User.create({ email: normalizedEmail, passwordHash });

    // 6. Safe response — id and email only, never password/passwordHash
    return res.status(201).json({ id: user._id, email: user.email });
  } catch (error) {
    // Duplicate key error (race condition on the unique email index)
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Email is already registered' });
    }
    console.error('Auth registration failed.', { name: error.name, code: error.code });
    return res.status(500).json({ message: 'Server error' });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    if (
      !isPlainSafeObject(req.body) || hasUnsafeKeys(req.body) ||
      typeof req.body.email !== 'string' || typeof req.body.password !== 'string' ||
      !isBoundedString(req.body.email, MAX_EMAIL_LENGTH) ||
      !isBoundedString(req.body.password, MAX_PASSWORD_LENGTH, { allowEmpty: true }) ||
      req.body.password.length === 0
    ) {
      return res.status(400).json({ message: 'Email and password must be valid bounded strings.' });
    }
    const { email, password } = req.body;

    // 2. Normalize the email the same way register does (trim + lowercase)
    const normalizedEmail = email.trim().toLowerCase();

    // 3. Find the user by normalized email
    const user = await User.findOne({ email: normalizedEmail });

    // 4. Compare the supplied password with the stored hash.
    //    Same generic 401 whether the email is unknown or the password is wrong,
    //    so we never reveal which emails exist.
    const passwordMatches =
      user && user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // 5. Create a JWT containing the user's MongoDB _id (secret comes from env)
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // 6. Safe response — token + id/email only, never password/passwordHash
    return res.json({
      token,
      user: { id: user._id, email: user.email },
    });
  } catch (error) {
    console.error('Auth login failed.', { name: error.name, code: error.code });
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { register, login };
