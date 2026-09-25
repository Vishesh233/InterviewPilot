const jwt = require('jsonwebtoken');
const { isSafeIdentifier } = require('../services/inputValidationService');

// JWT authentication middleware for protecting future routes.
// Expected header: Authorization: Bearer <token>
const requireAuth = (req, res, next) => {
  const header = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) {
    return res.status(401).json({ message: 'Not authorized: Bearer token missing' });
  }

  // 3. Verify the token with the same secret it was signed with
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT secret is not configured');
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object' || !isSafeIdentifier(decoded.id)) {
      throw new Error('Invalid token subject');
    }
    req.userId = decoded.id;
    return next();
  } catch (error) {
    // Invalid signature, corrupted token, or expired token → 401
    return res.status(401).json({ message: 'Not authorized: invalid or expired token' });
  }
};

module.exports = requireAuth;
