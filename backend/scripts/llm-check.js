#!/usr/bin/env node
// LLM provider diagnostics: lists the Gemini models available to the configured
// key, then sends ONE tiny prompt to the configured Gemini model and ONE to the
// OpenRouter fallback (when its key is set). At most two generation calls are
// made per run and no SDK-level retries are used. Keys are never printed.
// Exit code: 0 when at least one provider answered, 1 when every provider failed.
//
// Bench mode: `npm run llm:check -- --bench --models a,b,c --runs 2` runs the
// pipeline's real requirement-extraction prompt and Gemini request config
// against each model, sequentially, with a 120s per-call timeout and at most
// BENCH_MAX_CALLS calls. Exit code: 0 when at least one call succeeded, 1 when
// all failed, 2 for invalid arguments.

const path = require('node:path');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const {
  GEMINI_TIMEOUT_MS,
  OPENROUTER_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
  getGeminiModel,
  getOpenRouterModel,
  classifyLlmError,
  describeLlmConfig,
  buildGeminiConfig,
  parseGeminiThinking,
} = require('../src/services/geminiClient');
const {
  extractRequirements,
  buildPrompt: buildRequirementPrompt,
  RESPONSE_SCHEMA: REQUIREMENT_RESPONSE_SCHEMA,
} = require('../src/services/requirementExtractionService');

const PROMPT = 'Reply with OK';

const BENCH_TIMEOUT_MS = 120_000;
const BENCH_MAX_CALLS = 12;
const BENCH_JOB_DESCRIPTION = `Frontend Developer (React) - Mid Level

We are looking for a Frontend Developer to build fast, accessible web applications for our customer dashboard used by thousands of small businesses.

Responsibilities:
- Build and maintain features in React and TypeScript.
- Turn Figma designs into responsive, accessible UI components.
- Integrate REST and GraphQL APIs and manage client state.
- Write unit tests with Jest and React Testing Library.
- Improve page performance, Core Web Vitals and bundle size.
- Review code and collaborate with designers and backend engineers.

Requirements:
- 2+ years of professional experience with React and modern JavaScript (ES2020+).
- Strong HTML, CSS and responsive design skills.
- Experience with TypeScript and a state management library such as Redux or Zustand.
- Understanding of web accessibility (WCAG) and browser performance.
- Familiarity with Git and CI workflows.

Nice to have:
- Experience with Next.js and server-side rendering.
- Knowledge of Tailwind CSS or a design system.
- Exposure to end-to-end testing with Playwright or Cypress.`;

// Provider error messages should never contain a key, but mask defensively.
const mask = (value) => [process.env.GEMINI_API_KEY, process.env.OPENROUTER_API_KEY]
  .filter(Boolean)
  .reduce((text, key) => text.split(key).join('***'), String(value ?? ''));

const shortMessage = (error) => mask(error?.message).replace(/\s+/g, ' ').slice(0, 200);

const listGeminiModels = async (client) => {
  const names = [];
  const pager = await client.models.list({ config: { pageSize: 100 } });
  for await (const model of pager) {
    if (Array.isArray(model.supportedActions) && model.supportedActions.includes('generateContent')) {
      names.push(String(model.name || '').replace(/^models\//, ''));
    }
  }
  return names.sort();
};

const probe = async (provider, model, call) => {
  const startedAt = Date.now();
  try {
    const text = await call();
    console.log(`[${provider}] model=${model} status=ok latencyMs=${Date.now() - startedAt} reply=${JSON.stringify(mask(text).trim().slice(0, 40))}`);
    return true;
  } catch (error) {
    const status = Number(error?.status || error?.response?.status) || null;
    console.log(
      `[${provider}] model=${model} status=failed httpStatus=${status} latencyMs=${Date.now() - startedAt} ` +
      `errorClass=${error?.constructor?.name || error?.name} classification=${classifyLlmError(error)} message=${JSON.stringify(shortMessage(error))}`
    );
    return false;
  }
};

const parseBenchArgs = (argv) => {
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const models = String(valueOf('--models') || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const runsRaw = valueOf('--runs');
  const runs = runsRaw === undefined ? 1 : Number(runsRaw);
  if (models.length === 0) throw new Error('--bench requires --models a,b,c');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (models.length * runs > BENCH_MAX_CALLS) {
    throw new Error(`${models.length} models x ${runs} runs = ${models.length * runs} calls, above the cap of ${BENCH_MAX_CALLS}`);
  }
  let thinking;
  if (argv.includes('--thinking')) {
    thinking = valueOf('--thinking');
    if (thinking === undefined || thinking.startsWith('--')) throw new Error('--thinking requires a value');
    if (!parseGeminiThinking(thinking)) throw new Error('--thinking must not be empty');
  }
  return { models, runs, thinking };
};

// Runs the captured model text through the real extraction service with a
// stub client, so the pipeline's own parse and normalization rules decide
// validity. No network call is made here.
const validateExtraction = async (text) => {
  let parses = false;
  try {
    const parsed = JSON.parse(text);
    parses = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (error) {
    return { parses: false, valid: false, reason: 'invalid JSON' };
  }
  try {
    await extractRequirements({
      jobDescription: BENCH_JOB_DESCRIPTION,
      client: { models: { generateContent: async () => ({ text }) } },
    });
    return { parses, valid: true, reason: null };
  } catch (error) {
    return { parses, valid: false, reason: error?.code || error?.name || 'validation failed' };
  }
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const runBench = async ({ models, runs, thinking }) => {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[bench] GEMINI_API_KEY is not set');
    return 1;
  }
  const gemini = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { timeout: BENCH_TIMEOUT_MS, retryOptions: { attempts: 1 } },
  });
  // Same request shape as the pipeline's requirement-extraction stage: same
  // prompt builder, schema, JSON output setting and system instruction. The
  // pipeline sets no temperature, so none is set here either.
  const contents = buildRequirementPrompt(BENCH_JOB_DESCRIPTION);
  // --thinking overrides GEMINI_THINKING for this run only; same parser as the
  // pipeline, so an invalid value fails here instead of being dropped.
  const thinkingSource = thinking !== undefined ? '--thinking' : 'GEMINI_THINKING';
  const thinkingRaw = thinking !== undefined ? thinking : process.env.GEMINI_THINKING;
  const thinkingConfig = parseGeminiThinking(thinkingRaw);
  const thinkingLabel = thinkingConfig ? String(thinkingRaw).trim() : 'default';
  const config = buildGeminiConfig({ responseMimeType: 'application/json', responseSchema: REQUIREMENT_RESPONSE_SCHEMA, thinkingConfig });
  const words = BENCH_JOB_DESCRIPTION.split(/\s+/).filter(Boolean).length;
  console.log(`[bench] stage=requirement extraction jdWords=${words} promptChars=${contents.length} thinking=${thinkingLabel} (source=${thinkingConfig ? thinkingSource : 'none'}, thinkingConfig=${JSON.stringify(thinkingConfig)}) timeoutMs=${BENCH_TIMEOUT_MS} plannedCalls=${models.length * runs} (cap ${BENCH_MAX_CALLS})`);

  const results = [];
  for (const model of models) {
    for (let run = 1; run <= runs; run += 1) {
      const startedAt = Date.now();
      const row = { model, run, thinking: thinkingLabel };
      try {
        const response = await gemini.models.generateContent({ model, contents, config });
        row.latencyMs = Date.now() - startedAt;
        const text = typeof response?.text === 'string' ? response.text : '';
        row.ok = text.trim().length > 0;
        row.outputChars = text.length;
        const usage = response?.usageMetadata || {};
        row.promptTokens = usage.promptTokenCount ?? null;
        row.outputTokens = usage.candidatesTokenCount ?? null;
        row.thinkingTokens = usage.thoughtsTokenCount ?? null;
        Object.assign(row, await validateExtraction(text));
        console.log(
          `[bench] model=${model} run=${run} status=${row.ok ? 'ok' : 'empty'} latencyMs=${row.latencyMs} ` +
          `outputChars=${row.outputChars} parsesJson=${row.parses} passesValidator=${row.valid}${row.reason ? ` reason=${row.reason}` : ''} ` +
          `tokens(prompt/output/thinking)=${row.promptTokens}/${row.outputTokens}/${row.thinkingTokens}`
        );
      } catch (error) {
        row.latencyMs = Date.now() - startedAt;
        row.ok = false;
        row.valid = false;
        const status = Number(error?.status || error?.response?.status) || null;
        console.log(
          `[bench] model=${model} run=${run} status=failed latencyMs=${row.latencyMs} httpStatus=${status} ` +
          `errorClass=${error?.constructor?.name || error?.name} classification=${classifyLlmError(error)} message=${JSON.stringify(shortMessage(error))}`
        );
      }
      results.push(row);
    }
  }

  console.log('\nSummary (median latency over successful calls):');
  const header = ['model', 'thinking', 'ok/total', 'median latency ms', 'validator pass', 'median thinking tokens'];
  const rows = models.map((model) => {
    const mine = results.filter((row) => row.model === model);
    const okRows = mine.filter((row) => row.ok);
    const med = median(okRows.map((row) => row.latencyMs));
    const thinkingTokens = median(okRows.map((row) => row.thinkingTokens).filter((value) => Number.isFinite(value)));
    return [model, thinkingLabel, `${okRows.length}/${mine.length}`, med === null ? '-' : String(med), `${mine.filter((row) => row.valid).length}/${mine.length}`, thinkingTokens === null ? '-' : String(thinkingTokens)];
  });
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const line = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;
  console.log(line(header));
  console.log(`|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`);
  rows.forEach((row) => console.log(line(row)));

  return results.some((row) => row.ok) ? 0 : 1;
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--bench')) {
    let options;
    try {
      options = parseBenchArgs(argv);
    } catch (error) {
      console.error(`llm-check: ${error.message}`);
      return 2;
    }
    return runBench(options);
  }

  console.log('LLM configuration:', JSON.stringify(describeLlmConfig()));
  const results = [];

  if (!process.env.GEMINI_API_KEY) {
    console.log('[gemini] skipped: GEMINI_API_KEY is not set');
    results.push(false);
  } else {
    const gemini = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { timeout: GEMINI_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });
    try {
      const models = await listGeminiModels(gemini);
      console.log(`[gemini] ${models.length} models support generateContent: ${models.join(', ')}`);
      const configured = getGeminiModel();
      if (!models.includes(configured)) {
        console.log(`[gemini] WARNING: configured model "${configured}" is not in the list above`);
      }
    } catch (error) {
      const status = Number(error?.status) || null;
      console.log(`[gemini] model listing failed httpStatus=${status} errorClass=${error?.constructor?.name} message=${JSON.stringify(shortMessage(error))}`);
    }

    const geminiModel = getGeminiModel();
    results.push(await probe('gemini', geminiModel, async () => {
      const response = await gemini.models.generateContent({ model: geminiModel, contents: PROMPT });
      return response?.text;
    }));
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[openrouter] skipped: OPENROUTER_API_KEY is not set (fallback disabled)');
  } else {
    const openRouterModel = getOpenRouterModel();
    const openai = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      maxRetries: 0,
      timeout: OPENROUTER_TIMEOUT_MS,
    });
    results.push(await probe('openrouter', openRouterModel, async () => {
      const response = await openai.chat.completions.create({
        model: openRouterModel,
        messages: [{ role: 'user', content: PROMPT }],
      });
      return response?.choices?.[0]?.message?.content;
    }));
  }

  const anyOk = results.some(Boolean);
  console.log(anyOk ? 'Result: at least one provider is working.' : 'Result: every provider failed.');
  return anyOk ? 0 : 1;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error('llm-check failed:', error?.constructor?.name, shortMessage(error));
    process.exitCode = 1;
  });
