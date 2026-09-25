// Batch evaluation CLI for interview prep cases.
// Usage: node scripts/evaluate.js --input <cases.json> --output <kits.json>
// or via npm: npm run evaluate -- --input <cases.json> --output <kits.json>

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { BATCH_FIXTURE_CONTEXT } = require('../src/services/batchFixtureContext');
const { generateInterviewPrepKit, buildFinalKit } = require('../src/services/interviewPrepPipelineService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');
const { assertSafeUrl } = require('../src/services/urlSecurityService');
const {
  MAX_JOB_DESCRIPTION_LENGTH,
  isBoundedString,
  isPlainSafeObject,
  hasUnsafeKeys,
  isSafeIdentifier,
} = require('../src/services/inputValidationService');
const packageJson = require('../package.json');

const MIN_INTERVIEW_DAYS = 1;
const MAX_INTERVIEW_DAYS = 60;
const EXIT_SUCCESS = 0;
const EXIT_PARTIAL_FAILURE = 1;
const EXIT_USAGE = 2;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const SENSITIVE_KEY = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|MONGO.*URI|DATABASE_URL)/i;
const COMPANY_UNREACHABLE_CODES = new Set([
  'RESEARCH_NETWORK_ERROR',
  'RESEARCH_TIMEOUT',
  'RESEARCH_UPSTREAM_SERVER_ERROR',
  'FETCH_CONNECTION_FAILURE',
  'URL_DNS_FAILURE',
  'URL_DNS_TIMEOUT',
]);

const HELP = `Usage:
  npm run evaluate -- --input <cases.json> --output <kits.json>
  node scripts/evaluate.js --input <cases.json> --output <kits.json>

Options:
  -i, --input <path>   JSON file containing an array of interview-prep cases.
  -o, --output <path>  Destination for the pretty-printed evaluation report.
  -h, --help           Show this help.

Input fields per case:
  id          Required stable non-empty string.
  jd          Required non-empty job description.
  company_url Required HTTP(S) URL, including an evaluator-local loopback fixture URL.
  days        Required integer from 1 through 60.

Local fixtures:
  Relative paths and file:// URLs are resolved from the input file directory and
  served only by a temporary loopback HTTP server. An existing loopback URL such
  as http://localhost:8099/acme/ is allowed only inside the evaluator and is
  passed through the existing private fixture context. This is evaluator-only;
  the production research service still accepts only public HTTP(S) URLs.

Credentials are loaded from backend/.env and the process environment. The
current pipeline requires OPENROUTER_API_KEY. No database is used.

Exit codes:
  0  Batch completed and every case succeeded.
  1  Batch completed, but one or more cases failed (the report is still written).
  2  Invalid CLI usage, unreadable/invalid input, or output write failure.
`;

const isPlainObject = isPlainSafeObject;
const isJsonSafe = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value) || hasUnsafeKeys(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonSafe(entry, seen))
    : isPlainObject(value) && Object.values(value).every((entry) => isJsonSafe(entry, seen));
  seen.delete(value);
  return valid;
};

const safeErrorMessage = (error) => {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return 'The interview-prep pipeline failed without an error message.';
  if (
    /provider|openrouter|openai|gemini|llm|stack|node_modules|[A-Za-z]:[\\/]|\/(?:home|Users|var|tmp)\//i.test(firstLine)
  ) {
    return 'The interview-prep pipeline failed.';
  }
  return firstLine;
};

// Redact every value that came from a credential-like environment variable before
// an error reaches the report. The original error is never serialized.
const redactSecrets = (value) => {
  let output = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!SENSITIVE_KEY.test(key) || typeof secret !== 'string' || secret.length < 4) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
};

const safeMessage = (error) => redactSecrets(safeErrorMessage(error));

const redactSecretsInValue = (value) => {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsInValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactSecretsInValue(entry)])
    );
  }
  return value;
};

const errorResult = (id, code, message) => ({
  id: redactSecretsInValue(id),
  status: 'failed',
  kit: null,
  error: { code, message: redactSecrets(message) },
});

/**
 * Parse CLI arguments for --input / -i and --output / -o.
 */
const parseCliArgs = (argv = process.argv.slice(2)) => {
  const options = { input: null, output: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    const equalsAt = arg.indexOf('=');
    const name = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    const key = name === '--input' || name === '-i' ? 'input' : name === '--output' || name === '-o' ? 'output' : null;
    if (!key) throw new Error(`Unknown argument: ${arg}`);

    let value = equalsAt === -1 ? undefined : arg.slice(equalsAt + 1);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a path.`);
      index += 1;
    }
    if (!value.trim()) throw new Error(`${name} requires a non-empty path.`);
    if (options[key] !== null) throw new Error(`${name} may only be provided once.`);
    options[key] = value;
  }
  return options;
};

/**
 * Validate that raw JSON input is an array of case objects.
 */
const validateCasesPayload = (cases) => {
  if (!Array.isArray(cases)) throw new Error('Input JSON must be an array of evaluation cases.');
};

const parseHttpUrl = (companyUrl) => {
  try {
    const parsed = new URL(companyUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch (error) {
    return null;
  }
};

const isLocalFixture = (companyUrl) => {
  if (/^file:/i.test(companyUrl) || /^[a-z]:[\\/]/i.test(companyUrl)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(companyUrl) && !parseHttpUrl(companyUrl);
};

const isEvaluatorLoopbackUrl = (companyUrl) => {
  const parsed = parseHttpUrl(companyUrl);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost' || /^127\./.test(hostname) || hostname === '::1' || hostname === '[::1]';
};

const classifyCaseId = (testCase, index) => {
  const fallback = `case-${index + 1}`;
  if (!isPlainSafeObject(testCase)) return { id: fallback, error: 'case must be a plain object without unsafe keys.' };
  if (testCase.id === undefined) return { id: fallback, error: 'id must be provided.' };
  if (!isSafeIdentifier(testCase.id) || testCase.id.trim() !== testCase.id) {
    return { id: fallback, error: 'id must be a bounded, non-empty string without surrounding whitespace.' };
  }
  return { id: testCase.id, error: null };
};

/**
 * Extract and validate case parameters.
 */
const parseCaseInput = (testCase, index) => {
  if (!isPlainSafeObject(testCase)) throw new Error('case must be a plain object without unsafe keys.');

  const allowedFields = new Set(['id', 'jd', 'company_url', 'days']);
  const fields = Object.keys(testCase);
  if (fields.some((field) => !allowedFields.has(field))) {
    throw new Error('Each case must contain only id, jd, company_url, and days.');
  }
  const { id, error: idError } = classifyCaseId(testCase, index);
  if (idError) throw new Error(idError);
  if (testCase.id === undefined) throw new Error('id must be provided.');
  if (!isBoundedString(testCase.jd, MAX_JOB_DESCRIPTION_LENGTH)) {
    throw new Error(`jd must be a non-empty string no longer than ${MAX_JOB_DESCRIPTION_LENGTH} characters.`);
  }
  if (testCase.jd.includes('\u0000')) {
    throw new Error('jd contains an invalid null character.');
  }
  if (typeof testCase.company_url !== 'string' || !isBoundedString(testCase.company_url, 2048)) {
    throw new Error('company_url must be a valid HTTP/HTTPS URL or supported local fixture path.');
  }
  const companyUrl = testCase.company_url.trim();
  const validRemoteUrl = (() => {
    try {
      assertSafeUrl(companyUrl, { batchFixtureContext: BATCH_FIXTURE_CONTEXT });
      return true;
    } catch (error) {
      return false;
    }
  })();
  const validFileUrl = /^file:/i.test(companyUrl) && isLocalFixture(companyUrl);
  if (!validRemoteUrl && !validFileUrl && !isLocalFixture(companyUrl)) {
    throw new Error('company_url must be a valid HTTP/HTTPS URL or supported local fixture path.');
  }
  if (!Number.isInteger(testCase.days) || testCase.days < MIN_INTERVIEW_DAYS || testCase.days > MAX_INTERVIEW_DAYS) {
    throw new Error(`days must be an integer between ${MIN_INTERVIEW_DAYS} and ${MAX_INTERVIEW_DAYS}.`);
  }

  return {
    id,
    jobDescription: testCase.jd,
    companyUrl,
    interviewDays: testCase.days,
  };
};

const getInputRoot = (inputPath) => path.dirname(path.resolve(inputPath));

const resolveFixturePath = (companyUrl, inputRoot) => {
  let filePath;
  if (/^file:/i.test(companyUrl)) {
    try {
      filePath = require('node:url').fileURLToPath(companyUrl);
    } catch (error) {
      throw new Error('companyUrl contains an invalid file:// fixture URL.');
    }
  } else if (parseHttpUrl(companyUrl)) {
    return null;
  } else if (/^[a-z]:[\\/]/i.test(companyUrl) || path.isAbsolute(companyUrl)) {
    filePath = companyUrl;
  } else if (/^[a-z][a-z\d+.-]*:/i.test(companyUrl)) {
    throw new Error('companyUrl must be a valid HTTP/HTTPS URL or a supported local fixture path.');
  } else {
    filePath = path.resolve(inputRoot, companyUrl);
  }
  if (filePath.includes('\0')) throw new Error('Local company fixture path contains an invalid character.');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('Local company fixture not found.');
  }
  return resolved;
};

const collectFixturePaths = (cases, inputRoot) =>
  cases.flatMap((testCase) => {
    if (!isPlainSafeObject(testCase) || typeof testCase.company_url !== 'string') return [];
    const companyUrl = testCase.company_url.trim();
    if (!isLocalFixture(companyUrl)) return [];
    try {
      const fixturePath = resolveFixturePath(companyUrl, inputRoot);
      return fixturePath ? [fixturePath] : [];
    } catch (error) {
      return [];
    }
  });

const normalizeFixtureKey = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const startFixtureServer = async (fixturePaths) => {
  const uniquePaths = [...new Set(fixturePaths.map((filePath) => path.resolve(filePath)))];
  if (uniquePaths.length === 0) return null;
  const filesByRoute = new Map(
    uniquePaths.map((filePath, index) => [`/fixtures/${index}`, filePath])
  );
  const routesByPath = new Map(
    uniquePaths.map((filePath, index) => [normalizeFixtureKey(filePath), `/fixtures/${index}`])
  );
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Invalid fixture request');
      return;
    }
    const filePath = filesByRoute.get(pathname);
    if (!filePath) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Fixture not found');
      return;
    }
    try {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Unable to read fixture');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    urlForPath(filePath) {
      const route = routesByPath.get(normalizeFixtureKey(filePath));
      if (!route) throw new Error('Local fixture is not registered with the evaluator server.');
      return `http://127.0.0.1:${address.port}${route}`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const resultIdFor = (testCase, index) => {
  if (isPlainSafeObject(testCase) && isSafeIdentifier(testCase.id) && testCase.id.trim() === testCase.id) {
    return testCase.id;
  }
  return `case-${index + 1}`;
};

const withFixtureResolution = async (testCase, index, deps) => {
  let parsed;
  try {
    parsed = parseCaseInput(testCase, index);
  } catch (error) {
    return { parsed: null, error: errorResult(resultIdFor(testCase, index), 'INVALID_CASE', safeMessage(error)) };
  }

  try {
    const fixturePath = resolveFixturePath(parsed.companyUrl, deps.inputRoot || process.cwd());
    const loopbackFixture = isEvaluatorLoopbackUrl(parsed.companyUrl);
    if (fixturePath && !deps.fixtureServer) {
      throw new Error('Local fixture server is unavailable.');
    }
    const transformed = {
      ...parsed,
      companyUrl: fixturePath ? deps.fixtureServer.urlForPath(fixturePath) : parsed.companyUrl,
      ...((fixturePath || loopbackFixture) ? { [BATCH_FIXTURE_CONTEXT]: BATCH_FIXTURE_CONTEXT } : {}),
    };
    return { parsed: transformed };
  } catch (error) {
    return { parsed, error: errorResult(parsed.id, 'INVALID_CASE', 'The company fixture could not be prepared.') };
  }
};

const evaluateCase = async (testCase, index, deps = {}) => {
  const runner = deps.generateInterviewPrepKit || generateInterviewPrepKit;
  const validator = deps.validateKitStructure || validateKitStructure;
  const assemble = deps.buildFinalKit || buildFinalKit;
  const resolved = await withFixtureResolution(testCase, index, deps);
  if (resolved.error) return resolved.error;

  const id = resolved.parsed.id;
  try {
    const pipelineInput = resolved.parsed;
    const pipelineResult = await runner(pipelineInput);
    const candidateKit = pipelineResult?.kit || assemble(pipelineInput, pipelineResult);
    if (!isPlainObject(candidateKit)) {
      return errorResult(id, 'KIT_VALIDATION_FAILED', 'Generated kit is not an object.');
    }
    const kit = redactSecretsInValue(candidateKit);
    if (!isJsonSafe(kit)) {
      return errorResult(id, 'KIT_VALIDATION_FAILED', 'Generated kit is not valid JSON data.');
    }
    let validation;
    try {
      validation = validator(kit);
    } catch (error) {
      return errorResult(id, 'KIT_VALIDATION_FAILED', 'kitStructureValidator could not evaluate the generated kit.');
    }
    if (!validation?.valid) {
      const count = Array.isArray(validation?.errors) ? validation.errors.length : 0;
      return errorResult(
        id,
        'KIT_VALIDATION_FAILED',
        `Generated kit failed kitStructureValidator (${count} validation error${count === 1 ? '' : 's'}).`
      );
    }
    return { id: redactSecretsInValue(id), status: 'ok', kit, error: null };
  } catch (error) {
    const code = error?.code === 'KIT_VALIDATION_FAILED' ? 'KIT_VALIDATION_FAILED' :
      (COMPANY_UNREACHABLE_CODES.has(error?.code)
        ? 'COMPANY_UNREACHABLE'
        : (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
          ? error.code
          : 'PIPELINE_FAILED'));
    return errorResult(id, code, safeMessage(error));
  }
};

const runBatchEvaluation = async (cases, deps = {}) => {
  validateCasesPayload(cases);

  const results = [];
  const seenIds = new Set();
  for (let index = 0; index < cases.length; index += 1) {
    const { id, error } = classifyCaseId(cases[index], index);
    if (!error) {
      if (seenIds.has(id)) {
        results.push(errorResult(id, 'DUPLICATE_CASE_ID', 'Case id must be unique.'));
        continue;
      }
      seenIds.add(id);
    }
    // Sequential execution bounds provider use and preserves deterministic order.
    results.push(await evaluateCase(cases[index], index, deps));
  }
  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    kits: results,
  };
};

const ensureInputAndOutputAreDistinct = (inputPath, outputPath) => {
  const normalizeForComparison = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (normalizeForComparison(inputPath) === normalizeForComparison(outputPath)) {
    const error = new Error('--input and --output must refer to different files.');
    error.code = 'INPUT_OUTPUT_CONFLICT';
    throw error;
  }
};

const writeOutput = (outputPath, report) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

const runCli = async (argv, deps = {}) => {
  const logger = deps.logger || console;
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    logger.error(`Error: ${safeMessage(error)}`);
    logger.error('Run with --help for usage.');
    return EXIT_USAGE;
  }

  if (options.help) {
    logger.log(HELP);
    return EXIT_SUCCESS;
  }
  if (!options.input || !options.output) {
    logger.error('Error: both --input <cases.json> and --output <kits.json> are required.');
    logger.error('Run with --help for usage.');
    return EXIT_USAGE;
  }

  const cwd = deps.cwd || process.cwd();
  const inputPath = path.resolve(cwd, options.input);
  const outputPath = path.resolve(cwd, options.output);
  try {
    ensureInputAndOutputAreDistinct(inputPath, outputPath);
  } catch (error) {
    logger.error(`Error: ${safeMessage(error)}`);
    return EXIT_USAGE;
  }

  let cases;
  try {
    const inputStat = fs.statSync(inputPath);
    if (inputStat.size > MAX_INPUT_BYTES) throw new Error('Input JSON exceeds the 10 MB size limit.');
    const inputText = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '');
    cases = JSON.parse(inputText);
    validateCasesPayload(cases);
  } catch (error) {
    logger.error(`Error reading input: ${safeMessage(error)}`);
    return EXIT_USAGE;
  }

  let fixtureServer = null;
  let report;
  try {
    fixtureServer = await startFixtureServer(collectFixturePaths(cases, getInputRoot(inputPath)));
    report = await runBatchEvaluation(cases, {
      ...deps,
      inputRoot: getInputRoot(inputPath),
      fixtureServer,
    });
  } catch (error) {
    logger.error(`Error evaluating batch: ${safeMessage(error)}`);
    return EXIT_USAGE;
  } finally {
    if (fixtureServer) {
      try {
        await fixtureServer.close();
      } catch (closeError) {
        logger.error('Error closing the local fixture server.');
      }
    }
  }

  try {
    writeOutput(outputPath, report);
  } catch (error) {
    logger.error(`Error writing output: ${safeMessage(error)}`);
    return EXIT_USAGE;
  }

  const failedResults = report.kits.filter((result) => result.status === 'failed');
  for (const result of failedResults) logger.error(`Case ${result.id} failed: ${result.error.code}`);
  const failed = failedResults.length;
  logger.log(`Evaluation complete: ${report.kits.length - failed} succeeded, ${failed} failed.`);
  logger.log(`Results written to ${redactSecrets(outputPath)}`);
  return failed > 0 ? EXIT_PARTIAL_FAILURE : EXIT_SUCCESS;
};

if (require.main === module) {
  if (packageJson.scripts.evaluate !== 'node scripts/evaluate.js') {
    console.error('Fatal evaluator error: package.json evaluate script is misconfigured.');
    process.exitCode = EXIT_USAGE;
  } else {
    dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
    runCli(process.argv.slice(2))
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch((error) => {
        console.error(`Fatal evaluator error: ${safeMessage(error)}`);
        process.exitCode = EXIT_USAGE;
      });
  }
}

module.exports = {
  EXIT_SUCCESS,
  EXIT_PARTIAL_FAILURE,
  EXIT_USAGE,
  HELP,
  parseCliArgs,
  validateCasesPayload,
  parseCaseInput,
  resolveFixturePath,
  evaluateCase,
  runBatchEvaluation,
  writeOutput,
  runCli,
  main: runCli,
};

