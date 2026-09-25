// Production outbound URL security and bounded HTTP fetching.
// This module is deliberately independent of the batch evaluator. The default
// path validates DNS results, pins the selected address for the connection,
// and validates every redirect before making the next request.

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { BATCH_FIXTURE_CONTEXT } = require('./batchFixtureContext');

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class UrlSecurityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'UrlSecurityError';
    this.code = code;
    this.status = status;
    this.isPublic = true;
  }
}

class FetchHttpError extends Error {
  constructor(status, statusText = '') {
    super(`Upstream HTTP request failed with status ${status}${statusText ? ` ${statusText}` : ''}.`);
    this.name = 'FetchHttpError';
    this.code = 'UPSTREAM_HTTP_ERROR';
    this.status = status;
  }
}

const isPrivateIpv4 = (address) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const expandIpv6 = (address) => {
  let value = address.toLowerCase().split('%', 1)[0];
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, dotted.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.flatMap((part) => {
    const number = parseInt(part, 16);
    return [(number >> 8) & 0xff, number & 0xff];
  });
};

const isPrivateIpv6 = (address) => {
  const bytes = expandIpv6(address);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const first12Zero = bytes.slice(0, 12).every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isPrivateIpv4(bytes.slice(12).join('.'));
  return (
    allZero || first12Zero || loopback || (bytes[0] & 0xfe) === 0xfc ||
    bytes[0] === 0xfe || bytes[0] === 0xff ||
    (bytes[0] === 0x20 && bytes[1] === 0x02) ||
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) ||
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) ||
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) ||
    (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) ||
    (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
      bytes[4] === 0x00 && bytes[5] === 0x01)
  );
};

const isPrivateAddress = (address, family = net.isIP(address)) =>
  family === 4 ? isPrivateIpv4(address) : family === 6 ? isPrivateIpv6(address) : true;

const normalizedHostname = (hostname) =>
  String(hostname).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

const isObviousInternalHostname = (hostname) => {
  const host = normalizedHostname(hostname);
  return (
    !host || host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.localdomain') ||
    host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home') ||
    host === 'metadata.google.internal' || host === 'instance-data' ||
    host === 'ip6-localhost' || host === 'ip6-loopback' || !host.includes('.')
  );
};

const isBatchFixtureContext = (context) => context === BATCH_FIXTURE_CONTEXT;

const isLoopbackAddress = (address, family) => {
  if (typeof address !== 'string' || net.isIP(address) !== family) return false;
  return (family === 4 && /^127\./.test(address)) || (family === 6 && address === '::1');
};

const isLoopbackHostname = (hostname) => {
  const host = normalizedHostname(hostname);
  return host === 'localhost' || isLoopbackAddress(host, net.isIP(host));
};

const assertSafeUrl = (value, { batchFixtureContext } = {}) => {
  const allowBatchFixture = isBatchFixtureContext(batchFixtureContext);
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new UrlSecurityError('URL_INVALID', 'companyUrl must be a valid public HTTP/HTTPS URL.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new UrlSecurityError('URL_INVALID', 'companyUrl must be a valid public HTTP/HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSecurityError('URL_PROTOCOL_NOT_ALLOWED', 'Only HTTP and HTTPS company URLs are allowed.');
  }
  if (!url.hostname || url.username || url.password) {
    throw new UrlSecurityError('URL_INVALID', 'companyUrl must not contain credentials or an empty host.');
  }
  const hostname = normalizedHostname(url.hostname);
  if (net.isIP(hostname) === 0 && isObviousInternalHostname(hostname) &&
      !(allowBatchFixture && isLoopbackHostname(hostname))) {
    throw new UrlSecurityError('URL_HOST_NOT_ALLOWED', 'companyUrl must not target a local or internal hostname.');
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname) &&
      !(allowBatchFixture && isLoopbackHostname(hostname))) {
    throw new UrlSecurityError('URL_ADDRESS_NOT_ALLOWED', 'companyUrl must not target a private or reserved address.');
  }
  return url;
};

const lookupWithTimeout = async (lookup, hostname, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new UrlSecurityError('URL_DNS_TIMEOUT', 'The company URL hostname lookup timed out.', 504)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const assertSafeDestination = async (value, {
  lookup = dns.lookup,
  batchFixtureContext,
  timeoutMs = DEFAULT_DNS_TIMEOUT_MS,
} = {}) => {
  const url = assertSafeUrl(value, { batchFixtureContext });
  const allowBatchFixture = isBatchFixtureContext(batchFixtureContext);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (allowBatchFixture && !isLoopbackAddress(hostname, literalFamily)) {
      throw new UrlSecurityError('URL_ADDRESS_NOT_ALLOWED', 'Batch fixtures may use loopback literals only.');
    }
    return [{ address: hostname, family: literalFamily }];
  }
  let records;
  try {
    records = await lookupWithTimeout(lookup, hostname, timeoutMs);
  } catch (error) {
    if (error instanceof UrlSecurityError) throw error;
    throw new UrlSecurityError('URL_DNS_FAILURE', 'The company URL hostname could not be resolved.', 502);
  }
  if (!Array.isArray(records)) records = records ? [records] : [];
  if (records.length === 0) {
    throw new UrlSecurityError('URL_DNS_FAILURE', 'The company URL hostname could not be resolved.', 502);
  }
  if (allowBatchFixture) {
    const loopbackRecords = records.every((record) => {
      const family = Number.isInteger(record?.family) ? record.family : net.isIP(record?.address);
      return isLoopbackAddress(record?.address, family);
    });
    if (!loopbackRecords) {
      throw new UrlSecurityError('URL_ADDRESS_NOT_ALLOWED', 'Batch fixtures may resolve only to loopback addresses.');
    }
  }
  for (const record of records) {
    const family = Number.isInteger(record?.family) ? record.family : net.isIP(record?.address);
    const loopbackFixture = allowBatchFixture && isLoopbackAddress(record?.address, family);
    if (
      !record || typeof record.address !== 'string' ||
      !Number.isInteger(record.family) || (!loopbackFixture && isPrivateAddress(record.address, record.family))
    ) {
      throw new UrlSecurityError('URL_ADDRESS_NOT_ALLOWED', 'companyUrl resolved to a private or reserved address.');
    }
  }
  return records.map((record) => ({
    address: record.address,
    family: Number.isInteger(record.family) ? record.family : net.isIP(record.address),
  }));
};

const headerValue = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
};

const requestOnce = async (url, options = {}) => {
  const urlValue = typeof url === 'string' ? url : url.href;
  const parsed = assertSafeUrl(urlValue, { batchFixtureContext: options.batchFixtureContext });
  const lookup = options.lookup || dns.lookup;
  const records = await assertSafeDestination(parsed.href, {
    lookup,
    batchFixtureContext: options.batchFixtureContext,
  });
  const allowBatchFixture = isBatchFixtureContext(options.batchFixtureContext);
  const selected = allowBatchFixture
    ? (records.find((record) => record.family === 4) || records[0])
    : records[0];
  const requestImpl = options.requestImpl || (parsed.protocol === 'https:' ? https.request : http.request);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
    ? options.maxResponseBytes : DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const timeoutError = () => new UrlSecurityError(
      'FETCH_TIMEOUT',
      `Company research request timed out after ${timeoutMs}ms.`,
      504
    );
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: normalizedHostname(parsed.hostname),
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      // The Host protocol field is a restricted header in fetch, but Node's
      // http/https client requires it to preserve the original hostname and port
      // while the custom lookup callback pins the connection to `selected`.
      headers: {
        Host: parsed.host,
        'User-Agent': 'Trao-Interview-Prep-Backend/1.0 (company research)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
      },
      lookup: (hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) {
          callback(null, [{ address: selected.address, family: selected.family }]);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    };
    if (parsed.protocol === 'https:' && net.isIP(normalizedHostname(parsed.hostname)) === 0) {
      requestOptions.servername = normalizedHostname(parsed.hostname);
    }

    let request;
    try {
      request = requestImpl(requestOptions, (response) => {
        const chunks = [];
        let total = 0;
        const contentLength = Number(headerValue(response.headers, 'content-length'));
        if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > maxBytes)) {
          response.destroy();
          fail(new UrlSecurityError('FETCH_RESPONSE_TOO_LARGE', 'Company research response exceeded the size limit.', 502));
          return;
        }
        response.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > maxBytes) {
            response.destroy();
            fail(new UrlSecurityError('FETCH_RESPONSE_TOO_LARGE', 'Company research response exceeded the size limit.', 502));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          finish(resolve, {
            status: response.statusCode,
            statusText: response.statusMessage || '',
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', fail);
      });
    } catch (error) {
      fail(new UrlSecurityError('FETCH_CONNECTION_FAILURE', 'Unable to connect to the company URL.', 502));
      return;
    }

    timer = setTimeout(() => {
      try { request.destroy(timeoutError()); } catch (error) { fail(timeoutError()); }
    }, timeoutMs);
    request.on('error', (error) => {
      if (error?.code === 'FETCH_TIMEOUT') fail(error);
      else fail(new UrlSecurityError('FETCH_CONNECTION_FAILURE', 'Unable to connect to the company URL.', 502));
    });
    request.setTimeout?.(timeoutMs, () => {
      try { request.destroy(timeoutError()); } catch (error) { fail(timeoutError()); }
    });
    request.end();
  });
};

const secureFetch = async (value, options = {}) => {
  const urlValue = typeof value === 'string' ? value : value.href;
  let current = assertSafeUrl(urlValue, { batchFixtureContext: options.batchFixtureContext });
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await requestOnce(current, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { ...response, url: current.href };
    }
    const location = headerValue(response.headers, 'location');
    if (!location) throw new FetchHttpError(response.status, response.statusText);
    current = assertSafeUrl(new URL(location, current).href, {
      batchFixtureContext: options.batchFixtureContext,
    });
  }
  throw new UrlSecurityError('FETCH_TOO_MANY_REDIRECTS', 'Company research exceeded the redirect limit.', 502);
};

module.exports = {
  MAX_URL_LENGTH,
  MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  UrlSecurityError,
  FetchHttpError,
  isPrivateAddress,
  isObviousInternalHostname,
  assertSafeUrl,
  assertSafeDestination,
  secureFetch,
};