// Deterministic company-brief text sanitizer.
//
// Scraped company pages carry navigation menus, "read more" link fragments,
// cookie notices, legal boilerplate, HTML entity remnants and repeated blocks.
// This module strips that obvious webpage noise from research text BEFORE it
// becomes the displayed Company Brief — and before the same text reaches the
// existing LLM stages.
//
// Rules:
//  - No LLM call and no network access: pattern-based cleaning only.
//  - Deterministic and idempotent: running it twice yields the same text.
//  - Meaningful sentences are preserved; only structural noise is dropped.
//  - Never invents facts: the output is always a subset of the input text.

// The brief is a summary, not a dump: keep the cleaned text bounded, cutting on
// a sentence boundary whenever possible.
const DEFAULT_MAX_LENGTH = 4_000;

// Fewer remaining words than this after removing a menu run means the segment
// was chrome, not content.
const MIN_REMAINING_WORDS = 3;

// A run of this many consecutive menu-label words is navigation chrome.
const MIN_LABEL_RUN = 4;

// Named entities that commonly survive HTML-to-text conversion (punctuation,
// symbols, Latin-1 letters). Numeric entities are decoded separately.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  bull: '•', middot: '·', deg: '°', times: '×', divide: '÷', plusmn: '±',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', sect: '§', para: '¶',
  laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', micro: 'µ', shy: '',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  acute: '´', uml: '¨', cedil: '¸', macr: '¯', brvbar: '¦', ordm: 'º', ordf: 'ª',
  aacute: 'á', agrave: 'à', aring: 'å', auml: 'ä', atilde: 'ã', aelig: 'æ',
  ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  oslash: 'ø', oelig: 'œ', scaron: 'š', szlig: 'ß', thorn: 'þ', eth: 'ð',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
};

const MAX_ENTITY_CODE_POINT = 0x10ffff;
const INFORMATIVE_TEXT = /[a-z]/i;
const NON_WORD_CHARACTERS = /[^a-z0-9]+/g;
// Pipe and bullet separators are menu/listing chrome; sentence boundaries split
// prose. Spaced dashes are deliberately NOT separators — they are ordinary prose
// punctuation and are handled by the navigation rules below.
const SEGMENT_SEPARATOR = /(?<=[.!?])\s+|\s*[|•·]\s+/;

// ---- markup + entity cleanup -----------------------------------------------

// Tags that can survive a raw HTML-to-text conversion (double-encoded pages,
// text sliced mid-tag) plus comments and executable blocks.
const stripMarkup = (value) =>
  value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ');

const decodeCodePoint = (value) => {
  const codePoint = Number(value);
  return Number.isInteger(codePoint) && codePoint >= 32 && codePoint <= MAX_ENTITY_CODE_POINT
    ? String.fromCodePoint(codePoint)
    : ' ';
};

// Decode numeric entities and the common named entities, and drop entity
// remnants that are not prose (`&foo;`).
const decodeEntities = (value) =>
  value
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (match, decimal) => decodeCodePoint(decimal))
    .replace(/&([a-z][a-z0-9]{1,31});/gi, (match, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name.toLowerCase())
        ? NAMED_ENTITIES[name.toLowerCase()]
        : ' '
    );

// ---- boilerplate removal ---------------------------------------------------

// Link/CTA fragments and legal chrome that carry no company information.
const BOILERPLATE_PATTERNS = [
  /\b(?:read|see|view|show|learn|discover|find(?:\s+out)?)\s+(?:more|less|all|details?|the\s+(?:full\s+)?(?:article|story|post|page|list|specs|features))\b/gi,
  /\b(?:click|tap|press)\s+(?:here|to\s+(?:read|see|view|learn|continue|expand|open))\b/gi,
  /\b(?:skip|jump)\s+to\s+(?:the\s+)?(?:main\s+)?(?:content|navigation|menu|footer|top|bottom)\b/gi,
  /\bback\s+to\s+(?:top|home|overview|all|results)\b/gi,
  /\b(?:open|close|toggle|show|hide)\s+(?:the\s+)?(?:main\s+|primary\s+|mobile\s+)?(?:menu|navigation|nav|submenu|sidebar)\b/gi,
  /\b(?:accept|reject|manage|allow|deny|block)\s+(?:all\s+)?(?:cookies?|tracking|consent)\b/gi,
  /\bcookie\s+(?:settings|preferences|policy|notice|consent|banner)\b/gi,
  /\b(?:this\s+)?(?:site|website|web\s+site)\s+uses\s+cookies\b/gi,
  /\b(?:privacy|terms|legal|cookie|accessibility|security)\s+(?:policy|policies|notice|statement|settings|preferences|of\s+use|of\s+service|and\s+conditions)\b/gi,
  /\b(?:we|this\s+(?:site|website)|our\s+(?:site|website))\s+(?:use|uses)\s+cookies\b[^.]{0,120}\.?/gi,
  /\b(?:for|need)\s+(?:more|further|additional)\s+(?:information|details|help)\b/gi,
  /\bterms\s+(?:and|&)\s+conditions\b/gi,
  /\ball\s+rights\s+reserved\b/gi,
  /\b(?:do\s+not\s+sell|do\s+not\s+share)\s+(?:my\s+|or\s+share\s+)?personal\s+information\b/gi,
  /\b(?:subscribe|sign\s+up|join)\s+(?:now\s+)?(?:to|for)\s+(?:our\s+|the\s+|my\s+)?(?:newsletter|mailing\s+list|email\s+updates|updates)\b/gi,
  /\b(?:follow|connect\s+with)\s+us\s+on\b/gi,
  /\bshare\s+(?:this|on)\s+(?:page|article|post|linkedin|twitter|facebook)\b/gi,
  /\b(?:sitemap|accessibility\s+statement|legal\s+notice|modern\s+slavery\s+statement|we\s+value\s+your\s+privacy)\b/gi,
  /(?:©|\(c\)|\bcopyright\b)[^.]{0,80}\./gi,
];

// ---- navigation vocabulary -------------------------------------------------

// Words that only ever appear in site chrome. A segment made up exclusively of
// these is menu text, not company information.
const NAVIGATION_WORDS = new Set([
  // function words that glue menu labels together
  'a', 'an', 'and', 'are', 'at', 'by', 'for', 'from', 'get', 'in', 'is', 'more',
  'my', 'of', 'on', 'or', 'our', 'the', 'to', 'us', 'we', 'with', 'your', 'all',
  // site chrome and section labels
  'home', 'homepage', 'about', 'contact', 'contacts', 'company', 'menu', 'nav',
  'navigation', 'search', 'login', 'logout', 'signin', 'signup', 'register',
  'account', 'dashboard', 'profile', 'products', 'product', 'services', 'service',
  'solutions', 'solution', 'platform', 'features', 'feature', 'pricing', 'plans',
  'plan', 'packages', 'package', 'careers', 'career', 'jobs', 'opportunities',
  'blog', 'news', 'newsroom', 'press', 'media', 'updates', 'insights',
  'resources', 'resource', 'docs', 'documentation', 'support', 'help', 'faq',
  'faqs', 'status', 'trust', 'security', 'legal', 'privacy', 'terms',
  'conditions', 'cookies', 'cookie', 'sitemap', 'accessibility', 'partners',
  'partner', 'customers', 'customer', 'investors', 'investor', 'relations',
  'events', 'event', 'webinars', 'community', 'developers', 'developer',
  'integrations', 'integration', 'downloads', 'download', 'apps', 'app', 'shop',
  'store', 'cart', 'checkout', 'demo', 'trial', 'free', 'start', 'started',
  'work', 'working', 'explore', 'discover', 'learn', 'read', 'view', 'see',
  'show', 'page', 'pages', 'next', 'previous', 'top', 'main', 'footer', 'skip',
  'back', 'overview', 'details', 'language', 'languages', 'english', 'deutsch',
  'espanol', 'español', 'francais', 'français', 'japanese', 'chinese', 'korean',
  'topics', 'categories', 'category', 'archive', 'author', 'published', 'share',
  'follow', 'subscribe', 'newsletter', 'email', 'today', 'now', 'linkedin',
  'twitter', 'instagram', 'facebook', 'youtube', 'tiktok', 'github', 'medium',
  'glassdoor', 'crunchbase', 'pinterest', 'threads', 'mastodon', 'bluesky',
  'whatsapp', 'x', 'policy', 'policies', 'use', 'notice', 'settings',
  'preferences', 'consent', 'banner', 'rights', 'reserved',
]);

// The narrower subset used for run detection: real menu labels only. Function
// words are deliberately absent so a run is broken by normal prose.
const LABEL_WORDS = new Set([
  'home', 'homepage', 'about', 'contact', 'contacts', 'company', 'products',
  'product', 'services', 'service', 'solutions', 'solution', 'platform',
  'features', 'feature', 'pricing', 'plans', 'plan', 'packages', 'package',
  'careers', 'career', 'jobs', 'opportunities', 'blog', 'news', 'newsroom',
  'press', 'media', 'updates', 'insights', 'resources', 'docs', 'documentation',
  'support', 'help', 'faq', 'faqs', 'login', 'logout', 'signin', 'signup',
  'register', 'account', 'dashboard', 'profile', 'search', 'sitemap',
  'languages', 'partners', 'partner', 'customers', 'investors', 'events',
  'webinars', 'community', 'developers', 'downloads', 'shop', 'store', 'cart',
  'checkout', 'privacy', 'terms', 'cookies', 'legal', 'accessibility',
  'security', 'status', 'trust', 'integrations', 'apps', 'topics', 'categories',
  'archive',
]);

// ---- segment cleaning ------------------------------------------------------

const normalizeWord = (token) => token.toLowerCase().replace(NON_WORD_CHARACTERS, '');
const normalizedKey = (segment) => segment.toLowerCase().replace(NON_WORD_CHARACTERS, '');

// Drop maximal runs of consecutive navigation words — e.g. the "Home About
// Careers Blog Contact Us Products Services Pricing" prefix/tail left behind by
// a tag-stripped menu block. Only runs at the start or end of a segment, and
// only runs containing several real menu labels, are removed: prose that merely
// happens to use words like "products" or "services" is left untouched.
const removeLabelRuns = (tokens) => {
  const remaining = [];
  let removed = false;
  let index = 0;
  while (index < tokens.length) {
    if (!NAVIGATION_WORDS.has(normalizeWord(tokens[index]))) {
      remaining.push(tokens[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < tokens.length && NAVIGATION_WORDS.has(normalizeWord(tokens[end]))) end += 1;
    const labelCount = tokens
      .slice(index, end)
      .filter((token) => LABEL_WORDS.has(normalizeWord(token))).length;
    const atSegmentBoundary = index === 0 || end === tokens.length;
    if (labelCount >= MIN_LABEL_RUN && atSegmentBoundary) removed = true;
    else for (let cursor = index; cursor < end; cursor += 1) remaining.push(tokens[cursor]);
    index = end;
  }
  return { remaining, removed };
};

// Re-join the surviving words and tidy the punctuation the removals left behind.
// Sentence-ending punctuation is preserved; orphan separators are not.
const tidy = (tokens) =>
  tokens
    .join(' ')
    // Tag stripping glues a heading to the paragraph beneath it and repeats its
    // first word ("Acme Acme builds ..."): collapse immediate duplicates.
    .replace(/\b([A-Za-z0-9][A-Za-z0-9']*)(\s+\1\b)+/gi, '$1')
    .replace(/\s+([,;:!?%)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/,{2,}/g, ',')
    .replace(/^[\s,;:.|•·\-–—]+/, '')
    .replace(/[\s,;:|•·\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

// Clean one sentence-sized segment: remove boilerplate phrases and menu text,
// then discard anything left without readable information.
const cleanSegment = (segment) => {
  let text = segment;
  for (const pattern of BOILERPLATE_PATTERNS) text = text.replace(pattern, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || !INFORMATIVE_TEXT.test(text)) return '';
  const tokens = text.split(' ').filter(Boolean);
  // Punctuation-only tokens (bullets, dashes) never make a menu label content.
  const meaningful = tokens.filter((token) => normalizeWord(token) !== '');
  if (meaningful.length === 0) return '';
  if (meaningful.every((token) => NAVIGATION_WORDS.has(normalizeWord(token)))) return '';
  const { remaining, removed } = removeLabelRuns(tokens);
  if (remaining.length === 0 || (removed && remaining.length < MIN_REMAINING_WORDS)) return '';
  const rebuilt = tidy(remaining);
  return INFORMATIVE_TEXT.test(rebuilt) ? rebuilt : '';
};

// A segment that already appeared — or that repeats inside a longer kept
// segment — is a duplicated block from the same scraped page.
const isDuplicate = (segment, keys) => {
  const key = normalizedKey(segment);
  if (key.length < 4) return false;
  if (keys.includes(key)) return true;
  return key.length <= 40 && keys.some((kept) => kept.length > key.length && kept.includes(key));
};

// Cut the cleaned text on a sentence boundary so the brief stays a summary.
const clampToLength = (text, maxLength) => {
  if (!(maxLength > 0) || text.length <= maxLength) return text;
  const window = text.slice(0, maxLength);
  const boundary = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (boundary >= Math.floor(maxLength / 2)) return window.slice(0, boundary + 1).trim();
  return window.replace(/\s+\S*$/, '').trim() || window.trim();
};

/**
 * Turn already-scraped page text into display-ready company brief text.
 *
 * The output is always a subset of the input: markup and entity remnants are
 * decoded away, boilerplate/navigation/menu text is removed, duplicated blocks
 * are dropped, and the remainder is bounded to `options.maxLength`.
 *
 * @param {string} rawText Extracted (or supplied) research text.
 * @param {{ maxLength?: number }} [options]
 * @returns {string} Cleaned brief text, or '' when nothing useful remains.
 */
const sanitizeCompanyBriefText = (rawText, options = {}) => {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : DEFAULT_MAX_LENGTH;
  const flat = decodeEntities(stripMarkup(rawText)).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const keys = [];
  const segments = [];
  for (const candidate of flat.split(SEGMENT_SEPARATOR)) {
    const segment = cleanSegment(candidate);
    if (!segment || isDuplicate(segment, keys)) continue;
    keys.push(normalizedKey(segment));
    segments.push(segment);
  }
  return clampToLength(segments.join(' '), maxLength);
};

module.exports = { sanitizeCompanyBriefText, DEFAULT_MAX_LENGTH };

