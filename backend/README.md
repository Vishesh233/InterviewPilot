# Interview Prep Backend

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
