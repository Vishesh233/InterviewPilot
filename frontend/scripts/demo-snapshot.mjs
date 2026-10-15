// Writes data/demo-kits.json: a sanitized, read-only snapshot of the demo
// account's kits for the public /demo pages (which never call the API).
//
//   DEMO_EMAIL=... DEMO_PASSWORD=... npm run demo:snapshot
//
// DEMO_API_URL (optional) overrides the production API. Credentials are read
// from the environment only and are never printed or written anywhere.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = (process.env.DEMO_API_URL || 'https://interviewpilot-8mtm.onrender.com').replace(/\/$/, '');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo-kits.json');

// Kit sections the workspace renders; everything else (owner, ids, timestamps
// other than createdAt, Mongo internals) is dropped.
const KIT_SECTIONS = ['source', 'company_brief', 'role', 'questions', 'flashcards', 'schedule', 'coverage'];
// Internal keys removed at any depth.
const INTERNAL_KEYS = new Set(['_id', '__v', 'id_', 'userId', 'user', 'owner', 'ownerId', 'jobId', 'email']);
const UNRATED = Object.freeze({ confidence: null, covered: false, lastReviewedAt: null });

const fail = (message) => {
  console.error(`demo:snapshot: ${message}`);
  process.exit(1);
};

const stripInternal = (value) => {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !INTERNAL_KEYS.has(key)).map(([key, item]) => [key, stripInternal(item)]));
};

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const sanitizeKit = (kit) => {
  const clean = stripInternal(Object.fromEntries(KIT_SECTIONS.filter((key) => kit[key] !== undefined).map((key) => [key, kit[key]])));
  clean.flashcards = (clean.flashcards || []).map((card) => ({ ...card, practice: { ...UNRATED } }));
  const role = clean.role?.title || clean.source?.jobRole || 'Interview';
  const company = clean.company_brief?.name || 'Company';
  return { slug: slugify(`${role} ${company}`), createdAt: kit.createdAt, ...clean };
};

const request = async (route, options = {}) => {
  const response = await fetch(`${API}${route}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`${options.method || 'GET'} ${route} answered ${response.status} ${body?.error?.code || ''}`.trim());
  return body;
};

const email = process.env.DEMO_EMAIL;
const password = process.env.DEMO_PASSWORD;
if (!email || !password) fail('set DEMO_EMAIL and DEMO_PASSWORD in the environment.');

const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!login?.token) fail('login returned no token.');

const kits = await request('/api/kits', { headers: { Authorization: `Bearer ${login.token}` } });
if (!Array.isArray(kits) || kits.length === 0) fail('the demo account has no kits.');

const snapshot = kits
  .map(sanitizeKit)
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const slugs = new Set(snapshot.map((kit) => kit.slug));
if (slugs.size !== snapshot.length) fail('two demo kits have the same role and company; their slugs would collide.');

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), kits: snapshot }, null, 2)}\n`);
console.log(`demo:snapshot: wrote ${snapshot.length} kit(s) to data/demo-kits.json: ${snapshot.map((kit) => kit.slug).join(', ')}`);
