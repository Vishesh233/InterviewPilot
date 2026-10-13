const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('openai');
const { ApiError } = require('@google/genai');

const {
  generateContent,
  classifyLlmError,
  isTimeoutError,
  LlmError,
} = require('../src/services/geminiClient');

// A Gemini-shaped client whose generateContent replays the scripted outcomes in
// order. Injecting a client restricts the provider chain to Gemini, so these
// tests never reach the network.
const scriptedClient = (outcomes) => {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (request) => {
        calls.push(request);
        const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
        if (next instanceof Error) throw next;
        return { text: next };
      },
    },
  };
};

const abortError = () => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
};

describe('LLM error classification', () => {
  let warnings;
  let originalWarn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('classifies the OpenAI SDK APIConnectionTimeoutError (name "Error") as a timeout', () => {
    const error = new OpenAI.APIConnectionTimeoutError();
    assert.equal(error.name, 'Error');
    assert.equal(isTimeoutError(error), true);
    assert.equal(classifyLlmError(error), 'timeout');
  });

  it('classifies Gemini SDK abort-based timeouts, including a wrapped cause, as timeouts', () => {
    assert.equal(classifyLlmError(abortError()), 'timeout');
    const wrapped = new TypeError('fetch failed', { cause: abortError() });
    assert.equal(classifyLlmError(wrapped), 'timeout');
  });

  it('classifies 503 as overloaded, 429 as rate_limited, and 400 as permanent', () => {
    assert.equal(classifyLlmError(new ApiError({ message: 'high demand', status: 503 })), 'overloaded');
    assert.equal(classifyLlmError(new ApiError({ message: 'deadline', status: 504 })), 'overloaded');
    assert.equal(classifyLlmError(new ApiError({ message: 'slow down', status: 429 })), 'rate_limited');
    assert.equal(classifyLlmError(new ApiError({ message: 'bad request', status: 400 })), 'permanent');
    assert.equal(classifyLlmError(new Error('something else')), 'permanent');
  });

  it('retries an APIConnectionTimeoutError once and then succeeds', async () => {
    const client = scriptedClient([new OpenAI.APIConnectionTimeoutError(), '{"ok":true}']);
    const result = await generateContent({ contents: 'x', client });
    assert.equal(result.text, '{"ok":true}');
    assert.equal(client.calls.length, 2);
  });

  it('retries a Gemini 503 once and surfaces LLM_PROVIDER_UNAVAILABLE when it persists', async () => {
    const client = scriptedClient([new ApiError({ message: 'high demand', status: 503 })]);
    await assert.rejects(
      generateContent({ contents: 'x', client }),
      (error) => error instanceof LlmError && error.code === 'LLM_PROVIDER_UNAVAILABLE'
    );
    assert.equal(client.calls.length, 2);
  });

  it('does not retry a 400 and surfaces LLM_REQUEST_FAILED', async () => {
    const client = scriptedClient([new ApiError({ message: 'bad request', status: 400 })]);
    await assert.rejects(
      generateContent({ contents: 'x', client }),
      (error) => error instanceof LlmError && error.code === 'LLM_REQUEST_FAILED'
    );
    assert.equal(client.calls.length, 1);
  });

  it('surfaces a persistent timeout as LLM_TIMEOUT after one retry', async () => {
    const client = scriptedClient([new OpenAI.APIConnectionTimeoutError()]);
    await assert.rejects(
      generateContent({ contents: 'x', client }),
      (error) => error instanceof LlmError && error.code === 'LLM_TIMEOUT' && error.status === 504
    );
    assert.equal(client.calls.length, 2);
  });

  it('classifies Gemini 499 / CANCELLED as a transient timeout and keeps other 4xx permanent', () => {
    const cancelled = new ApiError({
      message: '{"error":{"code":499,"message":"The operation was cancelled.","status":"CANCELLED"}}',
      status: 499,
    });
    assert.equal(classifyLlmError(cancelled), 'timeout');
    const statusOnly = new Error('cancelled');
    statusOnly.status = 'CANCELLED';
    assert.equal(classifyLlmError(statusOnly), 'timeout');
    assert.equal(classifyLlmError(new ApiError({ message: 'forbidden', status: 403 })), 'permanent');
    assert.equal(classifyLlmError(new ApiError({ message: 'not found', status: 404 })), 'permanent');
  });

  it('retries a Gemini 499 once and surfaces LLM_TIMEOUT when it persists', async () => {
    const client = scriptedClient([new ApiError({ message: 'cancelled', status: 499 })]);
    await assert.rejects(
      generateContent({ contents: 'x', client }),
      (error) => error instanceof LlmError && error.code === 'LLM_TIMEOUT'
    );
    assert.equal(client.calls.length, 2);
  });

  it('falls back to OpenRouter after the Gemini attempt and its retry both fail transiently', async () => {
    const order = [];
    const gemini = {
      models: {
        generateContent: async () => {
          order.push('gemini');
          throw new ApiError({ message: 'high demand', status: 503 });
        },
      },
    };
    const openRouterRequests = [];
    const openRouter = {
      chat: {
        completions: {
          create: async (request) => {
            order.push('openrouter');
            openRouterRequests.push(request);
            return { choices: [{ message: { content: '{"ok":true}' } }] };
          },
        },
      },
    };

    const result = await generateContent({
      contents: 'x',
      responseMimeType: 'application/json',
      client: gemini,
      openRouterClient: openRouter,
    });

    assert.deepEqual(order, ['gemini', 'gemini', 'openrouter']);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(openRouterRequests.length, 1);
    assert.equal(openRouterRequests[0].messages.at(-1).content, 'x');
  });

  it('does not fall back to OpenRouter on a permanent Gemini failure', async () => {
    const order = [];
    const gemini = { models: { generateContent: async () => { order.push('gemini'); throw new ApiError({ message: 'bad', status: 400 }); } } };
    const openRouter = { chat: { completions: { create: async () => { order.push('openrouter'); return { choices: [{ message: { content: 'x' } }] }; } } } };
    await assert.rejects(
      generateContent({ contents: 'x', client: gemini, openRouterClient: openRouter }),
      (error) => error.code === 'LLM_REQUEST_FAILED'
    );
    assert.deepEqual(order, ['gemini']);
  });

  describe('GEMINI_THINKING', () => {
    let previous;
    beforeEach(() => { previous = process.env.GEMINI_THINKING; });
    afterEach(() => {
      if (previous === undefined) delete process.env.GEMINI_THINKING;
      else process.env.GEMINI_THINKING = previous;
    });

    it('sends no thinkingConfig when GEMINI_THINKING is empty or unset', async () => {
      for (const value of [undefined, '', '   ']) {
        if (value === undefined) delete process.env.GEMINI_THINKING;
        else process.env.GEMINI_THINKING = value;
        const client = scriptedClient(['{"ok":true}']);
        await generateContent({ contents: 'x', responseMimeType: 'application/json', client });
        assert.equal(client.calls.length, 1);
        assert.equal(Object.hasOwn(client.calls[0].config, 'thinkingConfig'), false);
      }
    });

    it('sends thinkingConfig.thinkingLevel for a level name and thinkingBudget for an integer', async () => {
      for (const [value, expected] of [
        ['minimal', { thinkingLevel: 'MINIMAL' }],
        ['HIGH', { thinkingLevel: 'HIGH' }],
        ['0', { thinkingBudget: 0 }],
        ['-1', { thinkingBudget: -1 }],
        ['1024', { thinkingBudget: 1024 }],
      ]) {
        process.env.GEMINI_THINKING = value;
        const client = scriptedClient(['{"ok":true}']);
        await generateContent({ contents: 'x', responseMimeType: 'application/json', client });
        assert.deepEqual(client.calls[0].config.thinkingConfig, expected, value);
      }
    });

    it('rejects an invalid GEMINI_THINKING before calling the model', async () => {
      process.env.GEMINI_THINKING = 'turbo';
      const client = scriptedClient(['{"ok":true}']);
      await assert.rejects(
        generateContent({ contents: 'x', client }),
        (error) => error instanceof LlmError && error.code === 'LLM_INVALID_CONFIG'
      );
      assert.equal(client.calls.length, 0);
    });

    it('surfaces a 400 while thinking is set as a permanent, explicit error', async () => {
      process.env.GEMINI_THINKING = 'MINIMAL';
      const client = scriptedClient([new ApiError({ message: 'thinking level is not supported', status: 400 })]);
      await assert.rejects(
        generateContent({ contents: 'x', client }),
        (error) => error instanceof LlmError &&
          error.code === 'LLM_THINKING_CONFIG_REJECTED' &&
          /GEMINI_THINKING=MINIMAL/.test(error.message)
      );
      assert.equal(client.calls.length, 1, 'a rejected thinking setting must not be retried');
      assert.equal(classifyLlmError(new LlmError('LLM_THINKING_CONFIG_REJECTED', 'x', 502)), 'permanent');
    });
  });

  it('logs one structured line per failed attempt without keys or prompts', async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-secret-key-value';
    try {
      const client = scriptedClient([new ApiError({ message: 'high demand', status: 503 })]);
      await assert.rejects(generateContent({ contents: 'PRIVATE PROMPT TEXT', client, stage: 'Question generation' }));
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
    }

    const lines = warnings.filter((line) => line.startsWith('LLM attempt failed.'));
    assert.equal(lines.length, 2);
    const entries = lines.map((line) => JSON.parse(line.slice('LLM attempt failed.'.length)));
    assert.deepEqual(entries.map((entry) => entry.attempt), [1, 2]);
    for (const entry of entries) {
      assert.equal(entry.provider, 'gemini');
      assert.equal(typeof entry.model, 'string');
      assert.equal(entry.stage, 'Question generation');
      assert.equal(entry.httpStatus, 503);
      assert.equal(entry.errorClass, 'ApiError');
      assert.equal(entry.errorCode, 'LLM_PROVIDER_UNAVAILABLE');
      assert.equal(typeof entry.durationMs, 'number');
      assert.equal(entry.classification, 'overloaded');
    }
    const joined = lines.join('\n');
    assert.equal(joined.includes('test-secret-key-value'), false);
    assert.equal(joined.includes('PRIVATE PROMPT TEXT'), false);
    assert.equal(joined.includes('high demand'), false);
  });
});
