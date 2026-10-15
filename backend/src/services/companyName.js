// Clean company name for a researched company page.
//
// A page <title> is usually a marketing line plus the brand ("Agentic
// Infrastructure - Vercel", "Careers | Stripe"), so it is a poor company name.
// The name is derived, in order, from:
//   1. og:site_name
//   2. <meta name="application-name">
//   3. the <title> segment (split on " - ", " | ", " — ", " – ") that matches the
//      domain's brand token (vercel.com -> "vercel")
//   4. the domain, title-cased (vercel.com -> "Vercel")
// Deterministic, no LLM.

const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 6;
const TITLE_SEPARATOR = /\s+[-|—–·:]\s+/;
// Second-level labels that sit in front of a country code (example.co.uk).
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

const compact = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

const cleanCandidate = (value) => {
  if (typeof value !== 'string') return '';
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME_LENGTH || name.split(' ').length > MAX_NAME_WORDS) return '';
  return name;
};

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (error) {
    if (error instanceof TypeError) return '';
    throw error;
  }
};

// "www.careers.vercel.com" -> "vercel", "example.co.uk" -> "example".
const brandTokenFor = (url) => {
  const labels = hostnameOf(url).split('.').filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  labels.pop(); // top-level domain
  if (labels.length > 1 && SECOND_LEVEL_LABELS.has(labels.at(-1))) labels.pop();
  return labels.at(-1);
};

const titleCase = (token) =>
  token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

// The title segment naming the brand: an exact match first, then a short
// segment containing the brand token.
const titleSegmentForBrand = (title, brand) => {
  if (typeof title !== 'string' || !brand) return '';
  const segments = title.split(TITLE_SEPARATOR).map(cleanCandidate).filter(Boolean);
  const target = compact(brand);
  return segments.find((segment) => compact(segment) === target)
    || segments.find((segment) => segment.split(' ').length <= 3 && compact(segment).includes(target))
    || '';
};

const deriveCompanyName = ({ siteName, applicationName, title, url } = {}) => {
  const fromSiteName = cleanCandidate(siteName);
  if (fromSiteName) return fromSiteName;
  const fromApplicationName = cleanCandidate(applicationName);
  if (fromApplicationName) return fromApplicationName;
  const brand = brandTokenFor(url);
  const fromTitle = titleSegmentForBrand(title, brand);
  if (fromTitle) return fromTitle;
  if (brand) return titleCase(brand);
  return cleanCandidate(title) || 'Company';
};

// For kits saved before the name was derived: the stored name is the page title.
// Only a title made of several segments, one of which names the domain's brand,
// is shortened; any other stored name is kept as it is.
const cleanStoredCompanyName = (name, url) => {
  if (typeof name !== 'string' || !TITLE_SEPARATOR.test(name)) return name;
  return titleSegmentForBrand(name, brandTokenFor(url)) || name;
};

// The name for a research result: the one derived during research, or (for a
// research checkpoint saved before names were derived) derived from its title.
const companyNameFromResearch = (research, companyUrl) => {
  const derived = cleanCandidate(research?.companyName);
  if (derived) return derived;
  return deriveCompanyName({ title: research?.companyTitle, url: research?.companyUrl || companyUrl });
};

module.exports = { deriveCompanyName, cleanStoredCompanyName, companyNameFromResearch, brandTokenFor };
