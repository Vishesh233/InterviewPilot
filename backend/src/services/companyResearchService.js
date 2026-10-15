// Basic company research retrieval service.
// Fetches a public company URL and returns its title + readable text.
// No LLM involved — only plain HTTP retrieval and simple HTML-to-text conversion.

const {
  secureFetch,
  assertSafeUrl,
  UrlSecurityError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
} = require('./urlSecurityService');
const { sanitizeCompanyBriefText } = require('./companyBriefSanitizer');

const MAX_TEXT_LENGTH = 20_000;
const MIN_USEFUL_TEXT_LENGTH = 40;
const MAX_TITLE_LENGTH = 300;
// Elements that never contain readable page content. Navigation/footer/aside
// blocks and form controls are structural chrome: their labels are the bulk of
// the "scraped noise" that used to end up in the company brief.
const NON_CONTENT_TAGS = 'script|style|noscript|svg|iframe|template|head|nav|footer|aside|button|select|option';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };

// Single-pass decode so "&amp;lt;" decodes only once (never double-decodes).
const decodeEntities = (value) =>
  value.replace(/&(amp|lt|gt|quot|nbsp|#39);/gi, (match, name) =>
    Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase())
      ? ENTITIES[name.toLowerCase()]
      : match
  );

const researchError = (code, message, status = 502) => {
  const error = new Error(message);
  error.name = 'CompanyResearchError';
  error.code = code;
  error.status = status;
  error.isPublic = true;
  return error;
};

const asFetchError = (error) => {
  if (error instanceof UrlSecurityError) return error;
  if (error?.code === 'UPSTREAM_HTTP_ERROR' && Number.isInteger(error.status)) {
    return researchError(
      error.status >= 500 ? 'RESEARCH_UPSTREAM_SERVER_ERROR' : 'RESEARCH_UPSTREAM_HTTP_ERROR',
      `Request failed with HTTP status ${error.status}.`,
      502
    );
  }
  if (error?.code === 'FETCH_TIMEOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return researchError('RESEARCH_TIMEOUT', `Request timed out after ${DEFAULT_TIMEOUT_MS}ms.`, 504);
  }
  return researchError('RESEARCH_NETWORK_ERROR', 'Network error while fetching companyUrl.', 502);
};

// <title> lives in <head>, so read it before stripping non-content blocks.
const extractTitle = (html) => {
  if (typeof html !== 'string' || html.length > DEFAULT_MAX_RESPONSE_BYTES) return null;
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeEntities(match[1].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, MAX_TITLE_LENGTH) : null;
};

const MAX_DESCRIPTION_LENGTH = 500;
const META_DESCRIPTION_NAMES = ['description', 'og:description', 'twitter:description'];

// The content of the first <meta name|property="..."> among `names` (in that
// order of preference), as plain text. Untrusted text.
const extractMetaContent = (html, names, maxLength) => {
  if (typeof html !== 'string' || html.length > DEFAULT_MAX_RESPONSE_BYTES) return null;
  const found = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\b(?:name|property)\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]?.trim().toLowerCase();
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2];
    if (name && content && names.includes(name) && !found[name]) found[name] = content;
  }
  const raw = names.map((name) => found[name]).find(Boolean);
  if (!raw) return null;
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
};

// The page's own one-paragraph summary (<meta name="description"> or its Open
// Graph / Twitter variants), read from <head> like the title.
const extractMetaDescription = (html) => extractMetaContent(html, META_DESCRIPTION_NAMES, MAX_DESCRIPTION_LENGTH);

// Name hints for the company name (see companyName.js).
const extractSiteNames = (html) => ({
  siteName: extractMetaContent(html, ['og:site_name'], MAX_TITLE_LENGTH),
  applicationName: extractMetaContent(html, ['application-name'], MAX_TITLE_LENGTH),
});

const extractText = (html) => {
  if (typeof html !== 'string' || html.length > DEFAULT_MAX_RESPONSE_BYTES) return '';
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML comments
    .replace(
      new RegExp(`<(${NON_CONTENT_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'),
      ' '
    ) // script/style/... blocks
    .replace(new RegExp(`<(${NON_CONTENT_TAGS})\\b[^>]*>`, 'gi'), ' '); // stray open tags
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, ' '); // remaining tags
  return decodeEntities(withoutTags)
    .replace(/\s+/g, ' ')
    .trim();
};

const researchCompany = async ({
  companyUrl,
  batchFixtureContext,
  includeHtml = false,
  fetchImpl = secureFetch,
} = {}) => {
  let url;
  try {
    url = assertSafeUrl(companyUrl, { batchFixtureContext });
  } catch (error) {
    if (error instanceof UrlSecurityError) throw error;
    throw researchError('RESEARCH_INVALID_URL', 'companyUrl must be a valid public HTTP/HTTPS URL.', 400);
  }

  let response;
  try {
    response = await fetchImpl(url, { batchFixtureContext });
  } catch (error) {
    throw asFetchError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    throw researchError(
      response.status >= 500 ? 'RESEARCH_UPSTREAM_SERVER_ERROR' : 'RESEARCH_UPSTREAM_HTTP_ERROR',
      `Request failed with HTTP status ${response.status}.`,
      502
    );
  }

  const contentType = String(response.headers?.['content-type'] || '')
    .split(';', 1)[0].trim().toLowerCase();
  const contentEncoding = String(response.headers?.['content-encoding'] || 'identity').toLowerCase();
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    throw researchError('RESEARCH_UNSUPPORTED_CONTENT_TYPE', 'Company research response was not HTML.', 415);
  }
  if (contentEncoding !== '' && contentEncoding !== 'identity') {
    throw researchError('RESEARCH_UNSUPPORTED_CONTENT_ENCODING', 'Compressed company research responses are not supported.', 415);
  }
  const html = response.body.toString('utf8');
  if (!html.trim() || html.includes('\u0000') || html.includes('\uFFFD')) {
    throw researchError('RESEARCH_MALFORMED_HTML', 'The company page did not contain valid readable HTML.', 502);
  }

  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const { siteName, applicationName } = extractSiteNames(html);
  // Clean the extracted page text deterministically before it is used anywhere:
  // the Company Brief, the research payload returned to clients, and the text
  // the existing LLM stages read.
  const text = sanitizeCompanyBriefText(extractText(html).slice(0, MAX_TEXT_LENGTH));
  if (!text) {
    throw researchError('RESEARCH_NO_READABLE_TEXT', 'The company page contained no useful readable text.', 422);
  }
  if (text.length < MIN_USEFUL_TEXT_LENGTH) {
    throw researchError(
      'RESEARCH_INSUFFICIENT_TEXT',
      'The company page contained too little useful public information.',
      422
    );
  }

  return {
    companyUrl: response.url || url.href,
    title,
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(applicationName ? { applicationName } : {}),
    text,
    ...(includeHtml ? { html } : {}),
  };
};

module.exports = { researchCompany, extractMetaDescription, extractSiteNames };
