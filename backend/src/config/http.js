// HTTP-level configuration: proxy trust, CORS and security headers.
// Kept apart from server.js so each piece is testable on its own.

// TRUST_PROXY: unset/false = off (default), true = trust every hop, a number =
// trust that many hops (1 behind Render's proxy, the production value), anything
// else is passed to Express as-is (e.g. "loopback" or a comma-separated IP list).
// It decides req.ip, which keys the per-IP rate limits.
const parseTrustProxy = (raw) => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /^(false|off|no|0)$/i.test(value)) return false;
  if (/^(true|on|yes)$/i.test(value)) return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
};

const DEV_ORIGIN = 'http://localhost:3000';

// CORS_ORIGINS: comma-separated exact origins (scheme + host + port, no path),
// e.g. "https://interviewpilot.vercel.app". When unset, development allows the
// local Next.js server; production allows no browser origin at all.
const readAllowedOrigins = (env = process.env) => {
  const raw = typeof env.CORS_ORIGINS === 'string' ? env.CORS_ORIGINS : '';
  const origins = raw.split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean);
  if (origins.length > 0) return origins;
  return env.NODE_ENV === 'production' ? [] : [DEV_ORIGIN];
};

// Options for the `cors` middleware. Auth uses the Authorization header, never
// cookies, so credentials stay off. A disallowed origin gets no CORS headers
// (the browser then blocks the response) and is logged once per origin.
const buildCorsOptions = (env = process.env, { logger = console } = {}) => {
  const allowed = new Set(readAllowedOrigins(env));
  const reported = new Set();
  return {
    origin: (origin, callback) => {
      // No Origin header: same-origin, curl, health checks, server-to-server.
      if (!origin || allowed.has(origin)) return callback(null, true);
      if (!reported.has(origin)) {
        reported.add(origin);
        logger.warn('CORS: request from a disallowed origin.', JSON.stringify({ origin }));
      }
      return callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // The frontend reads Retry-After to tell users how long to wait after a 429.
    exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy'],
    maxAge: 600,
  };
};

// Helmet defaults suit a JSON API. Cross-Origin-Resource-Policy is relaxed to
// "cross-origin" because the API is meant to be read by the frontend's origin.
const HELMET_OPTIONS = {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
};

module.exports = { parseTrustProxy, readAllowedOrigins, buildCorsOptions, HELMET_OPTIONS, DEV_ORIGIN };
