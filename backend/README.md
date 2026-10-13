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

## Coverage gap questions

`POST /api/kits/:id/gaps` (authenticated, owner-scoped) appends questions for the kit's *currently uncovered* requirements, which are taken from the deterministic coverage check (`coverage.missingRequirements`) — so the UI can show "Generate questions for N gaps" without changing the evaluator schema. It reuses the existing gap-fill LLM stage, preserves deterministic question and flashcard ids, never rewrites existing questions, drops duplicate questions while reporting their ids, and re-validates the complete kit before anything is persisted.

## Deterministic question quality

`questionQualityService` reports duplicate, near-duplicate (token Jaccard), redundant requirement coverage, unrelated requirement coverage and excessive per-category repetition. It is LLM-free and never discards questions by itself; regeneration always goes through the existing LLM services.

## Batch evaluation CLI

Run the mandatory batch evaluator from this directory:

```bash
npm run evaluate -- --input cases.json --output kits.json
```

The input file is a UTF-8 JSON array. Each case must use exactly these fields:

```json
{
  "id": "case-01",
  "jd": "Senior Backend Engineer...",
  "company_url": "http://localhost:8099/acme/",
  "days": 5
}
```

`id` is a required, stable, unique non-empty string. `jd` must be a non-empty string, `company_url` must be a supported HTTP(S) URL or evaluator-local fixture, and `days` must be an integer from 1 through 60. The evaluator maps these Appendix B fields to the production pipeline's internal `jobDescription`, `companyUrl`, and `interviewDays` names.

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

Google Gemini is the primary provider, called through the official `@google/genai` SDK. The pipeline depends on provider-enforced structured output, so the adapter sets `responseMimeType: 'application/json'` and forwards the callers' native Gemini `Schema` objects (already built with `Type`, including `nullable`) as `responseSchema`. The SDK's own retry loop is disabled (`httpOptions.retryOptions.attempts: 1`) so the adapter's single bounded transient retry remains the only retry.

OpenRouter is retained as a fallback provider. It is consulted only when `OPENROUTER_API_KEY` is set **and** the Gemini attempt failed transiently (rate limit, provider down, or timeout). A permanent Gemini failure — a missing, invalid, or unauthorized key, or a rejected request — is surfaced immediately, so a misconfiguration is never hidden behind a second vendor. Delete `OPENROUTER_API_KEY` to make Gemini the only provider.

All model output is still parsed and validated by the existing application-side services; the provider contract is a convenience, not the authority.

### Local fixture URLs

In addition to normal HTTP and HTTPS URLs, the evaluator accepts paths relative to the input JSON file, absolute local paths, and `file://` URLs. It exposes those files from a temporary server bound only to `127.0.0.1` and passes the resulting HTTP URL into the unchanged production research pipeline. This evaluator-only resolution does not relax the production research service's HTTP(S)-only validation. Use HTML files for company fixtures.

Run `npm run evaluate -- --help` for the complete CLI reference.
