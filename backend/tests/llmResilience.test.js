const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('@google/genai');

const {
  generateContent,
  describeLlmConfig,
  resetLlmCooldowns,
  LlmError,
  LLM_RETRY_CAP_MS,
} = require('../src/services/geminiClient');

// Every test injects a mocked client, which restricts the chain to injected
// clients: no test can reach the network.

const TEST_ENV = {
  GEMINI_MODEL: 'primary-model',
  GEMINI_FALLBACK_MODELS: 'fallback-a,fallback-b',
  GEMINI_THINKING: '',
  GEMINI_THINKING_OVERRIDES: '',
  LLM_MAX_RETRIES: '2',
  LLM_RETRY_BASE_MS: '0',
  LLM_COOLDOWN_MS: '60000',
  LLM_TIMEOUT_MS: '',
};

const httpError = (status, message = 'upstream detail', headers) => {
  const error = new ApiError({ message, status });
  if (headers) error.headers = headers;
  return error;
};

const success = (text = '{"ok":true}') => ({ text });

// A Gemini-shaped client scripted per model: each model replays its outcomes in
// order and repeats the last one. A model with no script answers successfully.
const modelClient = (script = {}) => {
  const calls = [];
  const counts = {};
  return {
    calls,
    models: {
      generateContent: async (request) => {
        calls.push(request);
        const outcomes = script[request.model] || [success()];
        const index = Math.min(counts[request.model] || 0, outcomes.length - 1);
        counts[request.model] = (counts[request.model] || 0) + 1;
        const next = outcomes[index];
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
};

const openRouterClient = (order) => ({
  chat: {
    completions: {
      create: async () => {
        order.push('openrouter');
        return { choices: [{ message: { content: '{"from":"openrouter"}' } }] };
      },
    },
  },
});

const parseLines = (lines, prefix) =>
  lines.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));

// Lets pending promise continuations run between fake-timer ticks.
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('LLM resilience: retries, fallback chain and cooldown', () => {
  let logs;
  let savedEnv;
  let originalWarn;
  let originalInfo;

  beforeEach(() => {
    savedEnv = Object.fromEntries(Object.keys(TEST_ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, TEST_ENV);
    resetLlmCooldowns();
    logs = [];
    originalWarn = console.warn;
    originalInfo = console.info;
    console.warn = (...args) => { logs.push(args.join(' ')); };
    console.info = (...args) => { logs.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.info = originalInfo;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLlmCooldowns();
    mock.timers.reset();
    mock.restoreAll();
  });

  it('retries a 503 burst and then succeeds on the same model', async () => {
    const client = modelClient({
      'primary-model': [httpError(503), httpError(503), success('{"ok":"primary"}')],
    });
    const result = await generateContent({ contents: 'x', client, stage: 'Question generation' });

    assert.equal(result.text, '{"ok":"primary"}');
    assert.deepEqual(client.calls.map((call) => call.model), ['primary-model', 'primary-model', 'primary-model']);
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.deepEqual(failed.map((line) => line.action), ['retry', 'retry']);
    assert.deepEqual(failed.map((line) => line.attempt), [1, 2]);
    for (const line of failed) {
      assert.equal(line.model, 'primary-model');
      assert.equal(line.classification, 'overloaded');
      assert.equal(line.status, 503);
      assert.equal(typeof line.latencyMs, 'number');
      assert.equal(line.stage, 'Question generation');
    }
    const succeeded = parseLines(logs, 'LLM attempt succeeded.');
    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0].attempt, 3);
    assert.equal(succeeded[0].action, 'return');
    // The model recovered, so it leaves the cooldown it entered on the 503.
    const cooldown = parseLines(logs, 'LLM model cooldown.');
    assert.deepEqual(cooldown.map((line) => line.event), ['enter', 'leave']);
  });

  it('retries network resets and 499 cancellations as transient', async () => {
    const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const client = modelClient({
      'primary-model': [reset, httpError(499, '{"error":{"code":499,"status":"CANCELLED"}}'), success()],
    });
    await generateContent({ contents: 'x', client });
    assert.equal(client.calls.length, 3);
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.deepEqual(failed.map((line) => line.classification), ['network', 'timeout']);
  });

  it('moves to the next model only after the retries are exhausted', async () => {
    const client = modelClient({ 'primary-model': [httpError(504)] });
    const result = await generateContent({ contents: 'x', client });

    assert.equal(result.text, '{"ok":true}');
    // LLM_MAX_RETRIES=2: one attempt plus two retries, then the first fallback.
    assert.deepEqual(client.calls.map((call) => call.model), [
      'primary-model', 'primary-model', 'primary-model', 'fallback-a',
    ]);
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.deepEqual(failed.map((line) => line.action), ['retry', 'retry', 'fallback']);
    const fallback = parseLines(logs, 'LLM fallback.');
    assert.deepEqual(fallback, [{ from: 'gemini:primary-model', to: 'gemini:fallback-a', reason: 'overloaded', stage: null }]);
  });

  it('falls back immediately on a 404 model-not-found', async () => {
    const client = modelClient({ 'primary-model': [httpError(404, 'models/primary-model is not found')] });
    await generateContent({ contents: 'x', client });

    assert.deepEqual(client.calls.map((call) => call.model), ['primary-model', 'fallback-a']);
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].classification, 'model_not_found');
    assert.equal(failed[0].action, 'fallback');
  });

  it('gives up with the last model error when every model fails', async () => {
    process.env.LLM_MAX_RETRIES = '0';
    const client = modelClient({
      'primary-model': [httpError(503)],
      'fallback-a': [httpError(503)],
      'fallback-b': [httpError(429)],
    });
    await assert.rejects(
      generateContent({ contents: 'x', client }),
      (error) => error instanceof LlmError && error.code === 'LLM_RATE_LIMITED'
    );
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.deepEqual(failed.map((line) => line.action), ['fallback', 'fallback', 'give-up']);
  });

  describe('thinking settings across the chain', () => {
    it('sends GEMINI_THINKING to every Gemini model and skips a fallback that rejects it, with a log', async () => {
      process.env.GEMINI_THINKING = 'LOW';
      process.env.LLM_MAX_RETRIES = '0';
      const client = modelClient({
        'primary-model': [httpError(503)],
        'fallback-a': [httpError(400, 'thinking level is not supported for this model')],
      });
      const result = await generateContent({ contents: 'x', client });

      assert.equal(result.text, '{"ok":true}');
      assert.deepEqual(client.calls.map((call) => call.model), ['primary-model', 'fallback-a', 'fallback-b']);
      // The setting is never dropped: every model received it.
      for (const call of client.calls) assert.deepEqual(call.config.thinkingConfig, { thinkingLevel: 'LOW' });

      const failed = parseLines(logs, 'LLM attempt failed.');
      assert.equal(failed[1].model, 'fallback-a');
      assert.equal(failed[1].classification, 'thinking_rejected');
      assert.equal(failed[1].errorCode, 'LLM_THINKING_CONFIG_REJECTED');
      assert.equal(failed[1].action, 'fallback');
      const rejected = parseLines(logs, 'LLM thinking setting rejected by fallback model; skipping it.');
      assert.deepEqual(rejected, [{ model: 'fallback-a', setting: 'GEMINI_THINKING=LOW', stage: null }]);
    });

    it('applies GEMINI_THINKING_OVERRIDES per model and names the override when it is rejected', async () => {
      process.env.GEMINI_THINKING = 'LOW';
      process.env.GEMINI_THINKING_OVERRIDES = 'fallback-a=MINIMAL, fallback-b=';
      process.env.LLM_MAX_RETRIES = '0';
      const client = modelClient({
        'primary-model': [httpError(503)],
        'fallback-a': [httpError(400, 'bad thinking level')],
      });
      await generateContent({ contents: 'x', client });

      assert.deepEqual(client.calls[0].config.thinkingConfig, { thinkingLevel: 'LOW' });
      assert.deepEqual(client.calls[1].config.thinkingConfig, { thinkingLevel: 'MINIMAL' });
      // An empty override sends no thinkingConfig for that model.
      assert.equal(Object.hasOwn(client.calls[2].config, 'thinkingConfig'), false);
      const rejected = parseLines(logs, 'LLM thinking setting rejected by fallback model; skipping it.');
      assert.equal(rejected[0].setting, 'GEMINI_THINKING_OVERRIDES[fallback-a]=MINIMAL');
    });

    it('does not skip past the primary model when it rejects the thinking setting', async () => {
      process.env.GEMINI_THINKING = 'HIGH';
      const client = modelClient({ 'primary-model': [httpError(400, 'unsupported')] });
      await assert.rejects(
        generateContent({ contents: 'x', client }),
        (error) => error.code === 'LLM_THINKING_CONFIG_REJECTED' && /GEMINI_THINKING=HIGH is set for primary-model/.test(error.message)
      );
      assert.equal(client.calls.length, 1);
    });

    it('rejects an invalid GEMINI_THINKING_OVERRIDES before calling any model', async () => {
      for (const value of ['fallback-a', '=LOW', 'fallback-a=turbo']) {
        process.env.GEMINI_THINKING_OVERRIDES = value;
        const client = modelClient();
        await assert.rejects(
          generateContent({ contents: 'x', client }),
          (error) => error instanceof LlmError && error.code === 'LLM_INVALID_CONFIG',
          value
        );
        assert.equal(client.calls.length, 0);
      }
    });
  });

  describe('cooldown', () => {
    it('skips a model in cooldown and retries it once the cooldown expires', async () => {
      mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
      process.env.LLM_MAX_RETRIES = '0';
      const client = modelClient({ 'primary-model': [httpError(503), success('{"ok":"primary"}')] });

      await generateContent({ contents: 'first', client });
      assert.deepEqual(client.calls.map((call) => call.model), ['primary-model', 'fallback-a']);
      assert.deepEqual(parseLines(logs, 'LLM model cooldown.'), [
        { provider: 'gemini', model: 'primary-model', event: 'enter', status: 503, cooldownMs: 60000 },
      ]);

      client.calls.length = 0;
      await generateContent({ contents: 'second', client });
      assert.deepEqual(client.calls.map((call) => call.model), ['fallback-a']);
      assert.deepEqual(parseLines(logs, 'LLM model skipped.'), [
        { provider: 'gemini', model: 'primary-model', stage: null, classification: 'cooldown', action: 'cooldown-skip' },
      ]);

      mock.timers.tick(60_001);
      client.calls.length = 0;
      const result = await generateContent({ contents: 'third', client });
      assert.equal(result.text, '{"ok":"primary"}');
      assert.deepEqual(client.calls.map((call) => call.model), ['primary-model']);
      const events = parseLines(logs, 'LLM model cooldown.').map((line) => `${line.event}:${line.reason || ''}`);
      assert.deepEqual(events, ['enter:', 'leave:expired']);
    });

    it('ignores the cooldown for the last model left in the chain', async () => {
      process.env.GEMINI_FALLBACK_MODELS = 'fallback-a';
      process.env.LLM_MAX_RETRIES = '0';
      const client = modelClient({
        'primary-model': [httpError(503)],
        'fallback-a': [httpError(504), success('{"ok":"last"}')],
      });
      await assert.rejects(generateContent({ contents: 'x', client }), (error) => error.code === 'LLM_PROVIDER_UNAVAILABLE');

      client.calls.length = 0;
      const result = await generateContent({ contents: 'x', client });
      assert.equal(result.text, '{"ok":"last"}');
      // The primary is skipped; the last model is used despite its cooldown.
      assert.deepEqual(client.calls.map((call) => call.model), ['fallback-a']);
      const ignored = parseLines(logs, 'LLM model cooldown ignored: last model in the chain.');
      assert.deepEqual(ignored, [{ provider: 'gemini', model: 'fallback-a', stage: null }]);
    });

    it('does not put a model in cooldown for a 429 rate limit', async () => {
      process.env.LLM_MAX_RETRIES = '0';
      const client = modelClient({ 'primary-model': [httpError(429), success()] });
      await generateContent({ contents: 'x', client });
      client.calls.length = 0;
      await generateContent({ contents: 'x', client });
      assert.deepEqual(client.calls.map((call) => call.model), ['primary-model']);
      assert.equal(parseLines(logs, 'LLM model cooldown.').length, 0);
    });
  });

  describe('backoff timing (fake timers)', () => {
    it('honors a Retry-After header in seconds instead of the jittered backoff', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      process.env.LLM_RETRY_BASE_MS = '2000';
      const client = modelClient({
        'primary-model': [httpError(503, 'busy', { 'retry-after': '7' }), success()],
      });
      const pending = generateContent({ contents: 'x', client });
      await flush();
      assert.equal(client.calls.length, 1);

      mock.timers.tick(6_999);
      await flush();
      assert.equal(client.calls.length, 1, 'must wait the full Retry-After');

      mock.timers.tick(1);
      await flush();
      await pending;
      assert.equal(client.calls.length, 2);
      assert.equal(parseLines(logs, 'LLM attempt failed.')[0].delayMs, 7_000);
    });

    it('caps Retry-After and reads an HTTP date and the Gemini RetryInfo retryDelay', async () => {
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-13T12:00:00Z') });
      const client = modelClient({
        'primary-model': [
          httpError(429, 'slow down', { 'retry-after': '120' }),
          // Read after the first (capped) 30s wait, so 5s remain.
          httpError(503, 'busy', new Headers({ 'Retry-After': 'Tue, 13 Oct 2026 12:00:35 GMT' })),
          httpError(429, '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"3s"}]}}'),
          success(),
        ],
      });
      process.env.LLM_MAX_RETRIES = '3';
      const pending = generateContent({ contents: 'x', client });
      for (let step = 0; step < 6; step += 1) {
        await flush();
        mock.timers.tick(LLM_RETRY_CAP_MS);
      }
      await pending;
      const delays = parseLines(logs, 'LLM attempt failed.').map((line) => line.delayMs);
      assert.deepEqual(delays, [LLM_RETRY_CAP_MS, 5_000, 3_000]);
    });

    it('uses exponential backoff with full jitter, capped at 30s', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      mock.method(Math, 'random', () => 0.5);
      process.env.LLM_RETRY_BASE_MS = '10000';
      process.env.LLM_MAX_RETRIES = '3';
      const client = modelClient({ 'primary-model': [httpError(503), httpError(503), httpError(503), success()] });
      const pending = generateContent({ contents: 'x', client });
      for (let step = 0; step < 6; step += 1) {
        await flush();
        mock.timers.tick(LLM_RETRY_CAP_MS);
      }
      await pending;
      // random 0.5 of min(cap, base * 2^(attempt-1)): 10s, 20s, then 40s capped to 30s.
      const delays = parseLines(logs, 'LLM attempt failed.').map((line) => line.delayMs);
      assert.deepEqual(delays, [5_000, 10_000, 15_000]);
    });
  });

  it('never retries or falls back on permanent errors', async () => {
    for (const status of [400, 401, 403, 422]) {
      resetLlmCooldowns();
      const client = modelClient({ 'primary-model': [httpError(status)] });
      await assert.rejects(
        generateContent({ contents: 'x', client }),
        (error) => error instanceof LlmError && error.code === 'LLM_REQUEST_FAILED'
      );
      assert.equal(client.calls.length, 1, `status ${status}`);
    }
    const failed = parseLines(logs, 'LLM attempt failed.');
    assert.ok(failed.every((line) => line.action === 'give-up' && line.classification === 'permanent'));

    process.env.LLM_MAX_RETRIES = 'three';
    const client = modelClient();
    await assert.rejects(generateContent({ contents: 'x', client }), (error) => error.code === 'LLM_INVALID_CONFIG');
    assert.equal(client.calls.length, 0);
  });

  it('uses OpenRouter last, after every Gemini model', async () => {
    process.env.LLM_MAX_RETRIES = '0';
    const order = [];
    const client = modelClient({
      'primary-model': [httpError(503)],
      'fallback-a': [httpError(503)],
      'fallback-b': [httpError(503)],
    });
    const gemini = {
      models: {
        generateContent: async (request) => {
          order.push(request.model);
          return client.models.generateContent(request);
        },
      },
    };
    const result = await generateContent({ contents: 'x', client: gemini, openRouterClient: openRouterClient(order) });

    assert.equal(result.text, '{"from":"openrouter"}');
    assert.deepEqual(order, ['primary-model', 'fallback-a', 'fallback-b', 'openrouter']);
    const fallback = parseLines(logs, 'LLM fallback.');
    assert.equal(fallback.at(-1).to, `openrouter:${process.env.OPENROUTER_MODEL?.trim() || 'dots-studio/dots-3-note-preview:free'}`);
  });

  it('defaults the fallback list, honors an empty list, and reports the chain without keys', () => {
    delete process.env.GEMINI_FALLBACK_MODELS;
    const savedKeys = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    process.env.GEMINI_API_KEY = 'test-gemini-key-value';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key-value';
    try {
      const config = describeLlmConfig();
      assert.deepEqual(config.chain.map((entry) => `${entry.provider}:${entry.model}`), [
        'gemini:primary-model',
        'gemini:gemini-3.5-flash',
        'gemini:gemini-3.1-flash-lite',
        `openrouter:${config.chain.at(-1).model}`,
      ]);
      assert.equal(config.maxRetriesPerModel, 2);
      assert.equal(config.timeoutMs, 90_000);
      assert.equal(config.cooldownMs, 60_000);
      const serialized = JSON.stringify(config);
      assert.doesNotMatch(serialized, /test-gemini-key-value|test-openrouter-key-value/);

      process.env.GEMINI_FALLBACK_MODELS = '';
      assert.deepEqual(describeLlmConfig().chain.map((entry) => entry.model).slice(0, -1), ['primary-model']);
    } finally {
      for (const [name, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
