# Deploying InterviewPilot

Production runs on three managed services:

| Part | Service | Directory |
| --- | --- | --- |
| Frontend (Next.js) | Vercel | `frontend/` |
| API (Express) | Render, free web service | `backend/` |
| Database | MongoDB Atlas (free M0 cluster) | – |

## Current deployment

| Part | URL |
| --- | --- |
| Frontend (Vercel, production branch `main`) | https://interview-pilot-ten.vercel.app |
| API (Render, auto-deploys from `main`) | https://interviewpilot-8mtm.onrender.com |
| Health check | https://interviewpilot-8mtm.onrender.com/api/health |

Production settings that depend on these URLs:

- Render `CORS_ORIGINS=https://interview-pilot-ten.vercel.app`
- Vercel `NEXT_PUBLIC_API_URL=https://interviewpilot-8mtm.onrender.com`

A push to `main` redeploys both services.

## Architecture

```
            ┌──────────────────────────────┐
browser ───►│ Vercel: Next.js frontend      │   pages, assets, link previews
   │        └──────────────────────────────┘
   │        ┌──────────────────────────────┐    ┌─────────────────────────┐
   └───────►│ Render: Express API           ├───►│ MongoDB Atlas           │
  (direct,  │ /api/*  (CORS, helmet,        │    └─────────────────────────┘
   CORS)    │  rate limits, background jobs)├───►  Gemini API (primary LLM)
            └──────────────────────────────┘───►  OpenRouter (last fallback, optional)
```

The browser calls the API **directly** (`NEXT_PUBLIC_API_URL`), not through a
Vercel rewrite. Through a proxy, every user would share the proxy's IP and
therefore one rate-limit bucket. The API allows the frontend's origin through
CORS (`CORS_ORIGINS`) and reads the real client IP from Render's single proxy
hop (`TRUST_PROXY=1`).

## 1. MongoDB Atlas

1. Create a free **M0** cluster.
2. **Database Access → Add New Database User**: a dedicated user (for example
   `interviewpilot-api`) with a long random password (Atlas can generate one),
   role **readWrite** on the database **`interviewpilot`** only (Specific
   Privileges → `readWrite@interviewpilot`), not "Atlas admin".
3. **Network Access → Add IP Address → `0.0.0.0/0`**. Render's free plan has no
   static outbound IPs, so the cluster cannot be limited to Render's addresses.
   This is acceptable here because access still requires the dedicated user's
   strong password, the user can only read and write this one database, and
   Atlas only accepts TLS connections. Rotate the password if it is ever exposed.
4. **Connect → Drivers** gives the connection string. Put the database name in
   the path:
   `mongodb+srv://interviewpilot-api:<password>@<cluster>.mongodb.net/interviewpilot?retryWrites=true&w=majority`

## 2. Render (API)

**Blueprint (recommended):** push the repository, then in Render choose
**New → Blueprint**, select the repository, and Render reads
[`render.yaml`](render.yaml): a free web service with root directory
`backend`, build `npm ci`, start `npm start`, health check `/api/health`, and
every environment variable below (it asks for each value; none is stored in
the file). The Blueprint deploys the `main` branch.

**Manual alternative:** New → Web Service → the repository, Root Directory
`backend`, Runtime Node, Build Command `npm ci`, Start Command `npm start`,
Instance Type Free, Health Check Path `/api/health`, then add the variables.

The Node.js version comes from `backend/.node-version` (24.19.0, an LTS
release; `engines` allows Node 20+). Render sets `PORT` itself.

### API environment variables

| Name | Required | Example (no real secrets) | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | `production` | Production mode; with no `CORS_ORIGINS`, no browser origin is allowed |
| `MONGODB_URI` | yes | `mongodb+srv://interviewpilot-api:<password>@cluster0.xxxxx.mongodb.net/interviewpilot?retryWrites=true&w=majority` | Atlas connection string; the database name goes in the path (without one the driver uses `test`, which the least-privilege user is refused) |
| `MONGODB_DB_NAME` | no | `interviewpilot` | Database name; overrides the one in the `MONGODB_URI` path |
| `JWT_SECRET` | yes | 64+ random characters (`openssl rand -hex 48`) | Signs session tokens |
| `GEMINI_API_KEY` | yes | `<your Gemini API key>` | Primary LLM provider |
| `CORS_ORIGINS` | yes | `https://interview-pilot-ten.vercel.app` | Frontend origin(s) allowed to call the API, comma-separated, exact (no trailing slash) |
| `TRUST_PROXY` | yes | `1` | Render puts one proxy in front of the app; makes per-IP rate limits use the real client IP |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite` | First model in the chain (see "Model order") |
| `GEMINI_FALLBACK_MODELS` | no | `gemini-3.5-flash,gemini-3.8-flash` | Models tried next, in order |
| `GEMINI_THINKING` | no | `LOW` | Thinking level for all Gemini models |
| `GEMINI_THINKING_OVERRIDES` | no | (empty) | Per-model thinking overrides |
| `OPENROUTER_API_KEY` | no | `<your OpenRouter key>` | Last fallback after every Gemini model |
| `OPENROUTER_MODEL` | no | `<an OpenRouter model id>` | Model used on OpenRouter |
| `LLM_MAX_RETRIES` | no | `1` | Retries per model for transient errors (default 3) |
| `LLM_RETRY_BASE_MS` | no | `2000` | Backoff base |
| `LLM_COOLDOWN_MS` | no | `60000` | How long an overloaded model is skipped |
| `LLM_TIMEOUT_MS` | no | `90000` | Per-call timeout |
| `JOB_CONCURRENCY` | no | `2` | Generation jobs running at once |
| `JOB_TIMEOUT_MS` | no | `900000` | Limit for one generation run |
| `JOB_RESUME_DELAYS_MS` | no | `20000,60000` | Waits before automatic resumes |
| `RATE_LIMIT_*` (14 vars) | no | defaults: auth 10 / 15 min, job creation 15 / hour, API 300 / 15 min, job polling 1200 / 15 min, answer feedback 20 / hour, mock interview starts 5 / day, mock interview answers 30 / hour | See `backend/.env.example` |

### Model order (recommendation)

A 6-call benchmark of the requirement-extraction prompt (thinking `LOW`,
2 runs per model, 2026-10-14) got `503 high demand` on all six calls, so it
gives no ranking; no model rejected `LOW`. Recent live generations mostly
ended on `gemini-3.1-flash-lite` after 503/429 errors on the others, so it goes
first. Recommended (based on those live runs, not on the benchmark):

```
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_FALLBACK_MODELS=gemini-3.5-flash,gemini-3.8-flash
```

This is a small sample: re-check after a few days of real traffic. The larger
models extracted named tools slightly better in earlier tests; the
deterministic named-tool safety net covers most of that gap.

## 3. Vercel (frontend)

1. **Add New → Project** → the repository.
2. **Root Directory: `frontend`** (Framework Preset: Next.js, defaults for
   build and output).
3. Environment variables (Production):

| Name | Required | Example | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | yes | `https://interviewpilot-8mtm.onrender.com` | The browser calls the API here directly (no trailing slash) |
| `NEXT_PUBLIC_SITE_URL` | recommended | `https://interview-pilot-ten.vercel.app` | Absolute URLs for link previews (Open Graph / X cards); Vercel's production domain is used when unset |

`NEXT_PUBLIC_*` values are built into the JavaScript bundle: redeploy after
changing them. `BACKEND_API_URL` is only for local development (the
`/api/proxy` rewrite) and is not needed on Vercel. Node.js: Vercel reads
`engines` (Node 20+) from `frontend/package.json`; Node 24 is what the app is
tested on.

4. After the first deploy, put the Vercel URL into the API's `CORS_ORIGINS` on
   Render (and redeploy the API) if it differs from what you entered.

## 4. Post-deploy checks

1. `https://<api>.onrender.com/api/health` → `200 {"status":"ok","db":"up"}`
   (a `503 … "db":"down"` means Atlas is unreachable: check `MONGODB_URI` and
   Network Access).
2. Open the frontend, register, log in, open the dashboard.
3. In the browser's network panel, API calls go to the Render URL (not
   `/api/proxy`) and responses carry `access-control-allow-origin` with the
   Vercel origin.
4. Create one kit and wait for it to finish.
5. Open a link to the site in a LinkedIn / X post composer to check the preview
   image.
6. Render logs show `CORS allowed origins: [...]` at startup and no
   `CORS: request from a disallowed origin` lines from your own frontend.

## 5. Known limits

- **Cold starts:** Render's free web service sleeps after ~15 minutes without
  traffic. The first request then waits while it starts (often 30–60 s). The
  landing and sign-in pages ping `/api/health` on load to start waking it; if a
  request is slow or fails, the app shows "Waking up the server — free hosting
  sleeps when idle, this can take up to a minute", retries automatically for up
  to ~90 s, and then offers a Retry button. Reads and login are re-sent once
  the server is awake; a write that timed out (for example creating a kit) is
  not, because it may already have run, and the user is asked to check and
  try again.
- **Gemini free-tier quota:** requests per minute and per day are limited, and
  busy models answer 503/429. The fallback chain, cooldowns and automatic job
  resumes absorb short spikes; when every model is busy a generation fails with
  a "try again in a minute" message.
- **Single instance:** background generation jobs run inside the API process
  (checkpoints are stored in MongoDB). Run exactly one instance: several
  instances would each pick up and run jobs. When the free instance sleeps or
  restarts, unfinished jobs resume from their checkpoints on the next start;
  an attached resume is held in memory only, so a resume kit interrupted that
  way must be started again.
- **Rate limits are in memory** and reset when the instance restarts.
