const { rateLimit } = require('express-rate-limit');

// Request rate limits. Every limit and window is configurable through the
// environment; an unset or blank variable uses the default below, and an
// invalid value is logged and replaced by the default.
//
// The counters live in this process's memory, so they reset on restart and are
// per instance. A blocked request gets 429 RATE_LIMITED with Retry-After.
const MINUTE_MS = 60 * 1000;
const RATE_LIMIT_DEFAULTS = Object.freeze({
  // Login and register, per client IP (separate counters for each route).
  RATE_LIMIT_AUTH_MAX: 10,
  RATE_LIMIT_AUTH_WINDOW_MS: 15 * MINUTE_MS,
  // Creating generation jobs (kit, gap questions, regenerate), per user. Only
  // accepted requests (2xx/3xx) count, so a 400 or a 409 costs nothing.
  RATE_LIMIT_JOB_CREATE_MAX: 15,
  RATE_LIMIT_JOB_CREATE_WINDOW_MS: 60 * MINUTE_MS,
  // Baseline for everything under /api, per client IP.
  RATE_LIMIT_API_MAX: 300,
  RATE_LIMIT_API_WINDOW_MS: 15 * MINUTE_MS,
  // Job polling (GET /api/jobs/:id), per user. It is exempt from the baseline:
  // the UI polls every 2 s (5 s after a minute), which alone is up to 450
  // requests per job per 15 minutes and would exhaust the 300 baseline. This
  // separate limit allows two jobs polled at full speed at the same time.
  RATE_LIMIT_JOB_POLL_MAX: 1200,
  RATE_LIMIT_JOB_POLL_WINDOW_MS: 15 * MINUTE_MS,
});

const readRateLimitConfig = (env = process.env) => {
  const config = {};
  for (const [name, fallback] of Object.entries(RATE_LIMIT_DEFAULTS)) {
    const raw = typeof env[name] === 'string' ? env[name].trim() : '';
    if (!raw) {
      config[name] = fallback;
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      console.error('Rate limit configuration is invalid; using the default.', JSON.stringify({ name, default: fallback }));
      config[name] = fallback;
      continue;
    }
    config[name] = value;
  }
  return config;
};

const describeWait = (seconds) => {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

const retryAfterSecondsFor = (req, windowMs) => {
  const resetTime = req.rateLimit?.resetTime;
  const resetAt = resetTime instanceof Date ? resetTime.getTime() : Date.now() + windowMs;
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
};

const rateLimitedHandler = (req, res, next, options) => {
  const retryAfterSeconds = retryAfterSecondsFor(req, options.windowMs);
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: `Too many requests. Please try again in ${describeWait(retryAfterSeconds)}.`,
      retryAfterSeconds,
    },
  });
};

const limiter = ({ max, windowMs, ...options }) =>
  rateLimit({
    limit: max,
    windowMs,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitedHandler,
    ...options,
  });

// Per-user limiters run after requireAuth, so req.userId is always set.
const userKey = (req) => `user:${req.userId}`;

const JOB_POLL_PATH = /^\/jobs\/[^/]+\/?$/;
const isJobPoll = (req) => req.method === 'GET' && JOB_POLL_PATH.test(req.path);

const createRateLimiters = (env = process.env) => {
  const config = readRateLimitConfig(env);
  const auth = () => limiter({ max: config.RATE_LIMIT_AUTH_MAX, windowMs: config.RATE_LIMIT_AUTH_WINDOW_MS });
  return {
    config,
    login: auth(),
    register: auth(),
    // One shared budget for kit generation, gap questions and regeneration.
    jobCreate: limiter({
      max: config.RATE_LIMIT_JOB_CREATE_MAX,
      windowMs: config.RATE_LIMIT_JOB_CREATE_WINDOW_MS,
      keyGenerator: userKey,
      skipFailedRequests: true,
    }),
    jobPoll: limiter({
      max: config.RATE_LIMIT_JOB_POLL_MAX,
      windowMs: config.RATE_LIMIT_JOB_POLL_WINDOW_MS,
      keyGenerator: userKey,
    }),
    // Mounted on /api, so req.path is relative to it.
    api: limiter({
      max: config.RATE_LIMIT_API_MAX,
      windowMs: config.RATE_LIMIT_API_WINDOW_MS,
      skip: isJobPoll,
    }),
  };
};

// The app's limiters, built once from the environment. server.js loads dotenv
// before any route module requires this file.
const rateLimiters = createRateLimiters();

module.exports = {
  RATE_LIMIT_DEFAULTS,
  readRateLimitConfig,
  createRateLimiters,
  rateLimiters,
};
