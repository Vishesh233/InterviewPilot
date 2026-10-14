const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { parseTrustProxy, readAllowedOrigins, buildCorsOptions, HELMET_OPTIONS } = require('../src/config/http');
const { createRateLimiters } = require('../src/middleware/rateLimiters');

const withServer = async (app, run) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

// The same middleware order as server.js: helmet, cors, then the API.
const apiApp = (env, logger) => {
  const app = express();
  app.use(helmet(HELMET_OPTIONS));
  app.use(cors(buildCorsOptions(env, { logger })));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.delete('/api/kits/:id', (req, res) => res.json({ message: 'Kit deleted' }));
  return app;
};
const silentLogger = () => ({ warnings: [], warn(...args) { this.warnings.push(args.join(' ')); } });

describe('CORS', () => {
  const env = { NODE_ENV: 'production', CORS_ORIGINS: 'https://interviewpilot.vercel.app, https://preview.example.com/' };

  it('reads exact origins, and defaults to localhost:3000 in development only', () => {
    assert.deepEqual(readAllowedOrigins(env), ['https://interviewpilot.vercel.app', 'https://preview.example.com']);
    assert.deepEqual(readAllowedOrigins({}), ['http://localhost:3000']);
    assert.deepEqual(readAllowedOrigins({ NODE_ENV: 'production' }), []);
  });

  it('answers an allowed origin with its CORS headers, without credentials, and exposes Retry-After', async () => {
    await withServer(apiApp(env, silentLogger()), async (base) => {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: 'https://interviewpilot.vercel.app' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://interviewpilot.vercel.app');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
  });

  it('gives a disallowed origin no CORS headers and logs it once', async () => {
    const logger = silentLogger();
    await withServer(apiApp(env, logger), async (base) => {
      for (let i = 0; i < 2; i += 1) {
        const response = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      // Exact match only: a look-alike of an allowed origin is refused too.
      const lookAlike = await fetch(`${base}/api/health`, { headers: { Origin: 'https://interviewpilot.vercel.app.evil.example' } });
      assert.equal(lookAlike.headers.get('access-control-allow-origin'), null);
    });
    // One warning per disallowed origin: two requests from evil.example, one look-alike.
    assert.equal(logger.warnings.filter((line) => line.includes('"origin":"https://evil.example"')).length, 1);
    assert.equal(logger.warnings.length, 2);
  });

  it('answers a preflight for DELETE with Authorization and Content-Type', async () => {
    await withServer(apiApp(env, silentLogger()), async (base) => {
      const response = await fetch(`${base}/api/kits/k1`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://interviewpilot.vercel.app',
          'Access-Control-Request-Method': 'DELETE',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://interviewpilot.vercel.app');
      assert.match(response.headers.get('access-control-allow-methods'), /DELETE/);
      assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
      assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/);
    });
  });

  it('keeps requests without an Origin (curl, health checks) working', async () => {
    await withServer(apiApp(env, silentLogger()), async (base) => {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.status, 200);
    });
  });
});

describe('security headers', () => {
  it('adds helmet headers without changing JSON responses', async () => {
    await withServer(apiApp({ NODE_ENV: 'production', CORS_ORIGINS: 'https://a.example' }, silentLogger()), async (base) => {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.ok(response.headers.get('strict-transport-security'));
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
  });

  it('is mounted on the real app', async () => {
    const app = require('../src/server');
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/does-not-exist`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-powered-by'), null);
    });
  });
});

describe('rate limits behind one proxy hop (TRUST_PROXY=1)', () => {
  const limitedApp = (trustProxy) => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(trustProxy));
    const limiters = createRateLimiters({ RATE_LIMIT_AUTH_MAX: '1' });
    app.post('/api/auth/login', limiters.login, (req, res) => res.json({ ip: req.ip }));
    return app;
  };
  const login = (base, forwardedFor) =>
    fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Forwarded-For': forwardedFor } });

  it('parses TRUST_PROXY values', () => {
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
  });

  it('keys the limit on the real client IP from X-Forwarded-For', async () => {
    await withServer(limitedApp('1'), async (base) => {
      const first = await login(base, '203.0.113.7');
      assert.equal(first.status, 200);
      assert.equal((await first.json()).ip, '203.0.113.7');
      assert.equal((await login(base, '198.51.100.9')).status, 200, 'another client has its own bucket');
      assert.equal((await login(base, '203.0.113.7')).status, 429, 'the same client is limited');
      // A client-supplied extra hop is ignored: only the hop the proxy appended counts.
      assert.equal((await login(base, '10.9.9.9, 203.0.113.7')).status, 429);
    });
  });

  it('without trust proxy every client shares the proxy IP bucket', async () => {
    const warnings = [];
    const originalError = console.error;
    console.error = (...args) => warnings.push(args.join(' ')); // express-rate-limit warns about the header
    try {
      await withServer(limitedApp(''), async (base) => {
        assert.equal((await login(base, '203.0.113.7')).status, 200);
        assert.equal((await login(base, '198.51.100.9')).status, 429);
      });
    } finally {
      console.error = originalError;
    }
  });
});
