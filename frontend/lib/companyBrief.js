// Display helpers for the Company Brief.
//
// New kits store a structured brief (about, offerings, roleRelevance). Kits
// saved before that only have `summary`, which can be long scraped page text, so
// it is shown as its first two clean sentences (at most 60 words).

const LEGACY_MAX_WORDS = 60;
const LEGACY_MAX_SENTENCES = 2;
const CTA_FRAGMENTS = /\b(?:deploy now|talk to sales|contact sales|get started|get a demo|request a demo|book a demo|sign up|sign in|log in|learn more|read more|start for free|try (?:it )?(?:for )?free)\b/gi;

const words = (text) => text.split(/\s+/).filter(Boolean);

export function legacyBriefSummary(summary) {
  if (typeof summary !== 'string') return '';
  const cleaned = summary.replace(CTA_FRAGMENTS, ' ').replace(/\s+/g, ' ').trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[.!?]$/.test(sentence) && words(sentence).length >= 4);
  const picked = [];
  for (const sentence of sentences) {
    if (picked.length === LEGACY_MAX_SENTENCES) break;
    if (words([...picked, sentence].join(' ')).length > LEGACY_MAX_WORDS) break;
    picked.push(sentence);
  }
  if (picked.length > 0) return picked.join(' ');
  const first = words(cleaned).slice(0, LEGACY_MAX_WORDS).join(' ');
  return first && words(cleaned).length > LEGACY_MAX_WORDS ? `${first}…` : first;
}

// { name, about, offerings, roleRelevance, sources } ready to render.
export function briefForDisplay(kit) {
  const brief = kit?.company_brief || {};
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);
  const about = typeof brief.about === 'string' && brief.about.trim() ? brief.about.trim() : legacyBriefSummary(brief.summary);
  return {
    name: brief.name || 'Company',
    about,
    offerings: list(brief.offerings),
    roleRelevance: list(brief.roleRelevance),
    sources: Array.isArray(brief.sources) ? brief.sources.filter((source) => typeof source?.url === 'string') : [],
  };
}

export const companyNameOf = (kit) => kit?.company_brief?.name || 'Company';
