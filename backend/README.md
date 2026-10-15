# Interview Prep Backend

## Optional resume input

`POST /api/interview-prep` accepts an **optional** `resume` field. Omitting it keeps the existing JD-only request byte-for-byte identical.

```json
{
  "jobRole": "Backend Engineer",
  "jobDescription": "...",
  "companyUrl": "https://example.com/",
  "interviewDays": 5,
  "resume": { "fileName": "cv.pdf", "mimeType": "application/pdf", "dataBase64": "JVBERi0..." }
}
```

- Text resumes can be sent as `{"resume": {"text": "..."}}` instead of a file.
- Supported inputs: PDF (`.pdf`) and text (`.txt`, `.md`), up to 2 MB decoded. The extension allowlist, media-type allowlist, size limit and real file signature are all validated server-side; unsupported or unreadable files fail with a machine-readable code (`RESUME_UNSUPPORTED_FILE_TYPE`, `RESUME_FILE_TOO_LARGE`, `RESUME_INVALID_FILE`, `RESUME_NO_TEXT`, …) and the pipeline never runs.
- PDF text is recovered with Node's built-in `zlib` only (`resumeTextExtractor.js`); no third-party parser was added. A PDF whose text cannot be recovered confidently is rejected with a clear error instead of producing garbage.
- Only this route gets a larger (still bounded) JSON body limit, mounted before the shared parser in `server.js`; every other route keeps the existing 256 KB limit and strict JSON parsing.
- The extracted text is **untrusted data** and is treated exactly like the job description: it is never logged, never persisted, never returned to a client, and never placed in a URL. Prompts delimit it and instruct the model to ignore any instructions inside it.

With a resume, the pipeline runs two extra stages **after** the deterministic coverage check, so requirement coverage keeps meaning "does the question bank cover the JD requirement":

1. `resumeMatchService` classifies every extracted requirement as `matched` / `partial` / `missing`. A match or a partial **requires evidence quoted from the resume**; ungrounded evidence is discarded and the requirement degrades to `missing`. Requirements the model never reported are synthesized as `missing`.
2. `resumeQuestionService` generates resume/project questions with the new `resume` category. Every candidate must pass the shared question schema, use exact requirement references, use only source URLs from the supplied research, and be traceable to the resume (a project name, a shared distinctive token, or an explicit "your project"-style reference when the resume documents a project).

The kit gains two optional sections — `resume` (file metadata only) and `resume_analysis` (`matchPercent`, matched/partial/missing lists, detected project names, per-requirement matches with evidence). Resume match and requirement coverage are separate metrics and are never merged.

## Background generation jobs

Kit generation (`POST /api/interview-prep`), gap questions (`POST /api/kits/:id/gaps`) and section regeneration (`POST /api/kits/:id/regenerate`) run as background jobs, because a generation can take minutes, longer than a request should stay open (the local-development `/api/proxy` rewrite cuts requests at 30 s). Each endpoint still validates its input synchronously (bad input → 400; no gaps / nothing to regenerate → 409), then answers `202 { jobId }`. A second request of the same type for the same user (and kit) while one is active gets `409 JOB_ALREADY_RUNNING` with the existing `jobId`.

- `GET /api/jobs/:id` (owner only, otherwise 404) returns `type, status (queued | running | retrying | succeeded | failed), stage, stageIndex, stageCount, kitId, error { code, message, stage }, resumeCount, nextRetryAt, canResume, modelsUsed, createdAt, updatedAt`.
- `POST /api/jobs/:id/resume` requeues an owned `failed` job that has checkpoints from its failed stage (409 otherwise).

The validated output of every finished stage is stored as a checkpoint on the job, so a resumed job skips finished stages. When a stage fails transiently even after the whole model chain, the job waits (`JOB_RESUME_DELAYS_MS`) with status `retrying` and resumes from its checkpoints, at most twice; permanent and validation failures fail at once. `JOB_CONCURRENCY` caps parallel jobs and `JOB_TIMEOUT_MS` fails a job with `JOB_TIMEOUT`. At startup, unfinished jobs are requeued from their checkpoints, or failed with `JOB_INTERRUPTED` once they were resumed twice. On success the worker saves the kit (or the kit changes) itself. Finished jobs are deleted after 7 days (TTL index). An attached resume's text is kept in memory only, never in the job; a resume kit interrupted by a server restart fails with `RESUME_TEXT_UNAVAILABLE` and must be started again.

## Limits, health and shutdown

- **Resume text:** at most 40,000 characters (`MAX_RESUME_TEXT_LENGTH` in `resumeTextExtractor.js`, the single source of truth). Longer pasted or extracted text is rejected at the API boundary with `400 RESUME_TOO_LONG`, and the pipeline and the resume LLM services use the same limit and error.
- **Resume PDFs:** 2 MB upload, at most 20 pages (`RESUME_PDF_TOO_MANY_PAGES`), at most 4 MB per decompressed stream and 16 MB decompressed in total (`RESUME_PDF_TOO_LARGE`), at most 128 content streams.
- **Job description:** `POST /api/interview-prep` requires at least 100 characters (trimmed) of job description (`MIN_JOB_DESCRIPTION_LENGTH` in `inputValidationService.js`; the new-kit form mirrors it): `400 JOB_DESCRIPTION_TOO_SHORT`.
- **Passwords:** registration requires 8+ characters and at most 72 bytes, because bcrypt ignores anything after 72 bytes (`400 PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG`). Login is unchanged, so older accounts keep working.
- **Coverage:** `POST /api/kits` and `PUT /api/kits/:id` ignore any client-sent `coverage` and recompute it from `role.requirements` and the non-resume questions.
- **Rate limits** (`express-rate-limit`, in memory per process; all configurable, see `.env.example`). A blocked request gets `429 { error: { code: "RATE_LIMITED", message, retryAfterSeconds } }` plus a `Retry-After` header.

  | Scope | Default | Key | Env vars |
  | --- | --- | --- | --- |
  | `POST /api/auth/login`, `POST /api/auth/register` (separate counters) | 10 / 15 min | IP | `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_MS` |
  | Creating jobs: `POST /api/interview-prep`, `/api/kits/:id/gaps`, `/api/kits/:id/regenerate` (shared budget; rejected requests do not count) | 15 / hour | user | `RATE_LIMIT_JOB_CREATE_MAX`, `RATE_LIMIT_JOB_CREATE_WINDOW_MS` |
  | Everything under `/api` (baseline) | 300 / 15 min | IP | `RATE_LIMIT_API_MAX`, `RATE_LIMIT_API_WINDOW_MS` |
  | Job polling `GET /api/jobs/:id` (instead of the baseline) | 1200 / 15 min | user | `RATE_LIMIT_JOB_POLL_MAX`, `RATE_LIMIT_JOB_POLL_WINDOW_MS` |

  Job polling is exempt from the baseline because the UI polls every 2 s (5 s after the first minute): one job alone can reach about 450 requests per 15 minutes. It has its own per-user limit, sized for two jobs polled at full speed. `GET /api/health` is not rate limited.
- **`TRUST_PROXY`** (default off) sets Express `trust proxy`, which decides the client IP for the per-IP limits. Behind a proxy set it to the number of proxy hops in front of the API (for example `1` on Render). Left off behind a proxy, all clients share one IP and one limit.
- **Health:** `GET /api/health` returns `200 { status: "ok", db: "up" }` only while MongoDB is connected, otherwise `503 { status: "error", db: "down" }`.
- **Process:** an uncaught exception or unhandled rejection is logged and the process exits with code 1 (no case is treated as recoverable). On `SIGTERM`/`SIGINT` the server stops accepting connections, finishes in-flight requests, closes MongoDB and exits (forced after 10 s). Running jobs keep their stored status and are resumed by startup recovery. MongoDB connection errors, disconnects and reconnects are logged.

## Requirement extraction and role metadata

- The job title, seniority and years of experience are **role metadata** (`role.title`, `role.level`, `role.yearsExperience`), never requirements: they are not in `role.requirements`, not in coverage, and questions cannot reference them. Kits saved earlier keep their stored title/seniority entries and render as before.
- The extraction prompt asks for every named technology, tool, framework or standard as its own requirement, treats responsibilities as required, and marks items optional only when the JD says nice to have / bonus / preferred.
- `requirementPostProcessing.js` then applies deterministic rules to every extraction: it removes title / seniority / years lines (keeping the years as `yearsExperience`), moves nice-to-have items that the JD only mentions outside a nice-to-have section to must-have, and removes exact duplicates, interview signals that reword another requirement, and qualifications that only restate listed skills.
- The Company Brief summary (`summarizeCompanyBrief`, same on the web/job and evaluation paths) is the sanitized page text led by the homepage's meta description, keeping prose sentences only so menu runs are dropped.
- **Named-tool safety net** (`namedTools.js`, a curated, extendable list): a well-known technology, tool or standard the JD names (case-insensitive, word boundaries, aliases such as RTL → React Testing Library, CWV → Core Web Vitals, Postgres → PostgreSQL) that no requirement stands for is added, as required, or as nice-to-have when the JD names it only in a nice-to-have / bonus / preferred section. Tools the JD does not name are never added. Common-word names (Express, REST, ARIA, ...) match only in their own capitalization.
- **Unusable model output falls back.** Every LLM stage validates the answer per model. An answer that is empty, not JSON, fails schema validation or leaves nothing usable after filtering (for a section regenerate: no usable question of that section) is logged as `LLM output unusable.` (`bad_output`, with stage and reason) and the next model is tried (no same-model retry). Only when the whole chain produced nothing usable does the stage fail, with `LLM_NO_USABLE_OUTPUT` (`REGENERATE_NO_USABLE_QUESTIONS` for a section regenerate) and a "try again in a minute" message. Gap filling and resume questions are optional additions: if no model adds anything usable, the kit keeps its questions (gaps stay visible).
- LLM log lines carry the real pipeline/job stage, and an `LLM fallback.` line names the model that is actually tried next (models skipped for cooldown get their own `LLM model skipped.` line).

## Coverage gap questions

`POST /api/kits/:id/gaps` (authenticated, owner-scoped) appends questions for the kit's *currently uncovered* requirements, which are taken from the deterministic coverage check (`coverage.missingRequirements`) — so the UI can show "Generate questions for N gaps" without changing the evaluator schema. It reuses the existing gap-fill LLM stage, preserves deterministic question and flashcard ids, never rewrites existing questions, drops duplicate questions while reporting their ids, and re-validates the complete kit before anything is persisted.

## Deterministic question quality

`questionQualityService` reports duplicate, near-duplicate (token Jaccard), redundant requirement coverage, unrelated requirement coverage and excessive per-category repetition. It is LLM-free and never discards questions by itself; regeneration always goes through the existing LLM services.

## Batch evaluation CLI

Run the batch evaluator from this directory:

```bash
npm run evaluate -- --input cases.json --output kits.json
```

`scripts/cases/requirement-quality.json` holds two realistic cases (a React/Next.js frontend JD and a Node.js backend JD) used to check requirement-extraction quality.

The input file is a UTF-8 JSON array. Each case must use exactly these fields:

```json
{
  "id": "case-01",
  "jd": "Senior Backend Engineer...",
  "company_url": "http://localhost:8099/acme/",
  "days": 5
}
```

`id` is a required, stable, unique non-empty string. `jd` must be a non-empty string, `company_url` must be a supported HTTP(S) URL or evaluator-local fixture, and `days` must be an integer from 1 through 60. The evaluator maps these batch case fields to the production pipeline's internal `jobDescription`, `companyUrl`, and `interviewDays` names.

The evaluator processes cases sequentially, preserves input order, and calls the same `generateInterviewPrepKit` pipeline as the web API. It does not connect to MongoDB. Every successful kit is checked with the existing `kitStructureValidator` before it is written. Partial company research remains successful when the pipeline can still produce a valid kit.

The web API (`POST /api/interview-prep`) additionally requires `jobRole`: a non-empty string of at most 200 characters. It is stored as `source.jobRole` on the kit and, when present, it is the canonical target role the pipeline uses in place of the role inferred from the job description. Evaluator cases do not send it, so there the pipeline keeps falling back to extraction from `jd`. Kits saved before this field existed have no `source.jobRole` and remain valid.

The output is pretty-printed UTF-8 JSON:

```json
{
  "version": "1.0",
  "generated_at": "2026-01-01T00:00:00.000Z",
  "kits": [
    {
      "id": "case-01",
      "status": "ok",
      "kit": {},
      "error": null
    },
    {
      "id": "case-04",
      "status": "failed",
      "kit": null,
      "error": { "code": "COMPANY_UNREACHABLE", "message": "..." }
    }
  ]
}
```

A failed case is recorded with a safe `{ code, message }` error and does not stop later cases. Invalid input cases and pipeline, research, LLM, or validation failures use the same per-case error shape. Stack traces, filesystem paths, credentials, and provider internals are not written to the report.

Exit codes:

- `0`: the report was written and every case succeeded.
- `1`: the report was written, but one or more cases failed.
- `2`: CLI usage, input, fixture-server, or output-writing failure prevented a report.

### Environment

Credentials are read from `backend/.env` and the process environment. The LLM pipeline uses `GEMINI_API_KEY`; do not put credentials in case files or reports. MongoDB credentials are not needed for evaluation.

`GEMINI_MODEL` optionally overrides the model id used by the LLM adapter. When it is unset or blank, the adapter uses a built-in default of `gemini-3.5-flash-lite`.

Google Gemini is the primary provider, called through the official `@google/genai` SDK. The pipeline depends on provider-enforced structured output, so the adapter sets `responseMimeType: 'application/json'` and forwards the callers' native Gemini `Schema` objects (already built with `Type`, including `nullable`) as `responseSchema`. The SDK's own retry loop is disabled (`httpOptions.retryOptions.attempts: 1`) so the adapter's own retry policy remains the only retry.

Transient failures (timeout, 499, 503, 504, 429, network reset) are retried up to `LLM_MAX_RETRIES` times per model with exponential backoff and full jitter (`LLM_RETRY_BASE_MS`, capped at 30 s; a Retry-After hint is honored, capped). After a model's retries are exhausted — or immediately on a 404 model-not-found — the adapter moves down the chain: `GEMINI_MODEL`, then `GEMINI_FALLBACK_MODELS`, then OpenRouter last (only when `OPENROUTER_API_KEY` is set). `GEMINI_THINKING` (or a `GEMINI_THINKING_OVERRIDES` entry) is sent to every Gemini model; a fallback that rejects it with a 400 is skipped and logged. A model answering 503/504/499 is skipped for `LLM_COOLDOWN_MS` unless it is the last one left. Each call times out after `LLM_TIMEOUT_MS`. A permanent failure — a missing, invalid, or unauthorized key, or a rejected request — is surfaced immediately, so a misconfiguration is never hidden behind another model or vendor. Every attempt logs one structured line (model, attempt, classification, status, latency, action).

All model output is still parsed and validated by the existing application-side services; the provider contract is a convenience, not the authority.

### Local fixture URLs

In addition to normal HTTP and HTTPS URLs, the evaluator accepts paths relative to the input JSON file, absolute local paths, and `file://` URLs. It exposes those files from a temporary server bound only to `127.0.0.1` and passes the resulting HTTP URL into the unchanged production research pipeline. This evaluator-only resolution does not relax the production research service's HTTP(S)-only validation. Use HTML files for company fixtures.

Run `npm run evaluate -- --help` for the complete CLI reference.
