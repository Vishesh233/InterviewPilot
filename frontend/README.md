# InterviewPilot — Frontend

AI-powered interview preparation, tailored to the role you're applying for.

## Run locally

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Set `BACKEND_API_URL` before `npm run build` or `npm run dev`; the default is `http://localhost:5000`. The browser uses the same-origin `/api/proxy` path by default, so local development does not require backend CORS configuration. For a deployment where the backend already provides CORS, set `NEXT_PUBLIC_API_URL` directly to its public URL instead.

The frontend only uses this public URL; it never contains backend API keys, provider credentials, or `JWT_SECRET`.

## Routes

- `/login` and `/register`
- `/dashboard`
- `/kits/new`
- `/kits/[id]`
- `/kits/[id]/practice`

The app stores the short-lived backend JWT in browser storage for this assignment. Clear it with the Logout action or browser storage removal.
