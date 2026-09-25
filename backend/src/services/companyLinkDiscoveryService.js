// Link-discovery helper for company research.
// Extracts <a href> links from HTML, resolves them against a base URL,
// and buckets them into recruiting-related categories.
// No fetching and no LLM — only parsing of the HTML already provided.

const MAX_LINK_TEXT_LENGTH = 200;

// Category precedence: most specific recruiting terms first.
const CATEGORY_KEYWORDS = [
  ['interview', ['interview']],
  ['hiring', ['hiring', 'recruiting', 'recruitment']],
  ['jobs', ['jobs', 'job']],
  ['careers', ['careers', 'career', 'opportunities', 'work-with-us']],
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };

const decodeEntities = (value) =>
  value.replace(/&(amp|lt|gt|quot|nbsp|#39);/gi, (match, name) =>
    Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase())
      ? ENTITIES[name.toLowerCase()]
      : match
  );

// Anchor text = inner HTML minus tags, entities decoded, whitespace collapsed.
const cleanText = (innerHtml) =>
  decodeEntities(innerHtml.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINK_TEXT_LENGTH);

// Classify a link by looking at its URL and anchor text together.
const classify = (url, text) => {
  const haystack = `${url} ${text}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return category;
    }
  }
  return 'other';
};

const emptyResult = () => ({ careers: [], jobs: [], hiring: [], interview: [], other: [] });

const discoverRelevantLinks = ({ html, baseUrl } = {}) => {
  const result = emptyResult();

  // Handle missing/invalid input safely — nothing to discover
  if (typeof html !== 'string' || !html.trim()) return result;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return result;
  let base;
  try {
    base = new URL(baseUrl.trim());
  } catch (error) {
    return result;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return result;

  const seen = new Set();
  const anchorRegex =
    /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!href || href.startsWith('#')) continue; // empty or same-page anchor

    // Resolve relative URLs against baseUrl; keep only http/https
    let url;
    try {
      url = new URL(href, base);
    } catch (error) {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue; // mailto:, javascript:, ...
    url.hash = ''; // a fragment is not a different page
    const resolvedUrl = url.href;
    if (seen.has(resolvedUrl)) continue; // remove duplicates
    seen.add(resolvedUrl);

    const text = cleanText(match[4]);
    result[classify(resolvedUrl, text)].push({ url: resolvedUrl, text });
  }

  return result;
};

module.exports = { discoverRelevantLinks };
