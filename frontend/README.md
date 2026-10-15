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

`NEXT_PUBLIC_SITE_URL` (optional) is the public URL of the deployed frontend; link previews (Open Graph / X cards) use it for absolute image URLs. On Vercel the production domain is used when it is unset.

## Demo snapshot

The public `/demo` pages render `data/demo-kits.json`, a static, sanitized copy of the demo account's kits, so they need no sign-in and never call the API. To refresh it after the demo kits change:

```bash
cd frontend
DEMO_EMAIL=<demo account email> DEMO_PASSWORD=<demo account password> npm run demo:snapshot
```

The script logs in to the production API (`DEMO_API_URL` overrides it), fetches the account's kits and writes only the sections the kit UI renders: user ids, emails, job ids and other internal fields are dropped, and practice progress is reset to unrated. The credentials are read from the environment only; never put them in a file. Check the diff (no email addresses or ids) before committing the new JSON; the next deploy serves it.

## Design system

Colors, radii and shadows are CSS variables in `app/globals.css` (the design tokens) and are mapped to Tailwind names in `tailwind.config.js` (`bg-surface`, `text-muted`, `bg-brand-600`, `text-danger-700`, `rounded-card`, `shadow-raised`, ...). Use the tokens instead of hex values. The brand mark and wordmark live in `components/brand/Logo.js`; the favicon, app icons and the link-preview image are generated from the same mark (`app/icon.svg`, `app/favicon.ico`, `app/apple-icon.png`, `app/opengraph-image.js`).

## Routes

- `/` (landing page; signed-in visitors go to the dashboard)
- `/login` and `/register`
- `/dashboard`
- `/kits/new`
- `/kits/[id]`
- `/kits/[id]/practice`

The app stores the short-lived backend JWT in browser storage. Clear it with the Logout action or browser storage removal.
