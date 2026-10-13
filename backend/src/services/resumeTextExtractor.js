// Resume file validation and text extraction.
// Deterministic, no I/O, no network, no third-party parser: text-like files are
// decoded with TextDecoder and PDF text is recovered with Node's built-in zlib.
//
// Security/PRIVACY contract for every caller:
//   * the raw bytes and the extracted text are never logged, persisted, or
//     returned to a client — only the extracted text is handed back to the
//     in-memory pipeline;
//   * the extracted text is untrusted data (exactly like the job description).
//
// PDF extraction is deliberately best-effort and bounded: FlateDecode content
// streams are inflated and their text-showing operators are read. Anything that
// cannot be recovered confidently fails with a clear, public error instead of
// producing silent garbage.

const zlib = require('node:zlib');

const MAX_RESUME_FILE_BYTES = 2 * 1024 * 1024; // decoded upload size
const MAX_RESUME_TEXT_LENGTH = 40_000; // characters of extracted text
const MIN_RESUME_TEXT_LENGTH = 100;
const MIN_RESUME_WORD_COUNT = 20;
const MIN_PRINTABLE_RATIO = 0.85;
// Base64 grows a payload by 4/3, plus the JSON envelope and the other fields.
const RESUME_REQUEST_JSON_LIMIT_BYTES = 4 * 1024 * 1024;

const MAX_PDF_STREAM_COUNT = 128;
const MAX_INFLATED_STREAM_BYTES = 4 * 1024 * 1024;
const PDF_DICTIONARY_WINDOW = 2048;

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown']);
const PDF_EXTENSIONS = new Set(['pdf']);
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/md']);
const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);
// Browsers are inconsistent about these, so they are treated as "unknown" and the
// file extension decides. Anything else must match the extension's family.
const UNKNOWN_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const SUPPORTED_FILE_HINT = 'PDF (.pdf) and text (.txt, .md) files up to 2 MB are supported.';

class ResumeFileError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ResumeFileError';
    this.code = code;
    this.status = status;
    this.isPublic = true;
  }
}

const baseNameOf = (value) =>
  String(value).split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, '').trim();

const extensionOf = (fileName) => {
  const base = baseNameOf(fileName || '');
  const index = base.lastIndexOf('.');
  return index === -1 ? '' : base.slice(index + 1).toLowerCase();
};

/** Extension + declared media type -> 'pdf' | 'text'. Throws for anything else. */
const resolveResumeFileType = ({ fileName, mimeType } = {}) => {
  const extension = extensionOf(fileName);
  const mime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const knownMime = UNKNOWN_MIME_TYPES.has(mime) ? '' : mime;

  const extensionType = PDF_EXTENSIONS.has(extension) ? 'pdf' : TEXT_EXTENSIONS.has(extension) ? 'text' : '';
  const declaredType = PDF_MIME_TYPES.has(knownMime) ? 'pdf' : TEXT_MIME_TYPES.has(knownMime) ? 'text' : '';

  if (knownMime && !declaredType) {
    throw new ResumeFileError(
      'RESUME_UNSUPPORTED_FILE_TYPE',
      `Unsupported resume file type. ${SUPPORTED_FILE_HINT}`
    );
  }
  if (extension && !extensionType) {
    throw new ResumeFileError(
      'RESUME_UNSUPPORTED_FILE_TYPE',
      `Unsupported resume file type. ${SUPPORTED_FILE_HINT}`
    );
  }
  if (extensionType && declaredType && extensionType !== declaredType) {
    throw new ResumeFileError(
      'RESUME_FILE_TYPE_MISMATCH',
      'The resume file extension and media type disagree.'
    );
  }
  const fileType = extensionType || declaredType;
  if (!fileType) {
    throw new ResumeFileError(
      'RESUME_UNSUPPORTED_FILE_TYPE',
      `Unsupported resume file type. ${SUPPORTED_FILE_HINT}`
    );
  }
  return fileType;
};


const literalEscapes = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
};

/** Read one PDF literal string starting at `start` (the opening parenthesis). */
const readLiteralString = (content, start) => {
  let index = start + 1;
  let depth = 1;
  let value = '';
  while (index < content.length) {
    const char = content[index];
    if (char === '\\') {
      const next = content[index + 1];
      if (next === '\r' || next === '\n') {
        index += next === '\r' && content[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (next >= '0' && next <= '7') {
        let octal = '';
        let cursor = index + 1;
        while (cursor < content.length && octal.length < 3 && content[cursor] >= '0' && content[cursor] <= '7') {
          octal += content[cursor];
          cursor += 1;
        }
        value += String.fromCharCode(parseInt(octal, 8));
        index = cursor;
        continue;
      }
      if (next === undefined) {
        index += 1;
        continue;
      }
      value += Object.prototype.hasOwnProperty.call(literalEscapes, next) ? literalEscapes[next] : next;
      index += 2;
      continue;
    }
    if (char === '(') {
      depth += 1;
      value += char;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      value += char;
      continue;
    }
    value += char;
    index += 1;
  }
  return { value, next: index };
};

const utf16beFromHex = (hex) => {
  let out = '';
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
};

/** Best-effort decode of a PDF hexadecimal string. */
const decodeHexString = (raw) => {
  const hex = String(raw).replace(/[^0-9A-Fa-f]/g, '');
  if (!hex) return '';
  if (hex.length >= 4 && hex.slice(0, 4).toLowerCase() === 'feff') {
    return utf16beFromHex(hex.slice(4));
  }
  if (hex.length % 2 !== 0) return '';
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
  const oneByte = bytes.map((byte) => String.fromCharCode(byte)).join('');
  const oneBytePrintable = oneByte.replace(/[^\u0020-\u007E]/g, '').length;
  if (oneByte.length > 0 && oneBytePrintable / oneByte.length < 0.65) {
    const twoByte = utf16beFromHex(hex);
    const twoBytePrintable = twoByte.replace(/[^\u0020-\u007E]/g, '').length;
    if (twoByte.length > 0 && twoBytePrintable / twoByte.length > oneBytePrintable / oneByte.length) {
      return twoByte;
    }
  }
  return oneByte;
};

/**
 * Pull visible text out of one decoded PDF content stream. Literal and hex
 * strings are the only text carriers; positioning operators start new lines.
 */
const extractTextFromContentStream = (content) => {
  const lines = [];
  let pending = '';
  let index = 0;
  const flush = () => {
    const line = pending.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    pending = '';
  };

  while (index < content.length) {
    const char = content[index];
    if (char === '(') {
      const { value, next } = readLiteralString(content, index);
      pending += value;
      index = next;
      continue;
    }
    if (char === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index);
      if (end === -1) break;
      pending += decodeHexString(content.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    const operator = /^(T\*|TD|Td|Tm|ET)(?![A-Za-z0-9])/.exec(content.slice(index, index + 3));
    if (operator) {
      flush();
      index += operator[1].length;
      continue;
    }
    index += 1;
  }
  flush();
  return lines.join('\n');
};

const collectPdfStreams = (latin1) => {
  const streams = [];
  let cursor = 0;
  while (streams.length < MAX_PDF_STREAM_COUNT) {
    const streamIndex = latin1.indexOf('stream', cursor);
    if (streamIndex === -1) break;
    // The keyword must start its own token (not "endstream", "streams", ...).
    const before = latin1[streamIndex - 1];
    if (before && /[A-Za-z0-9]/.test(before)) {
      cursor = streamIndex + 6;
      continue;
    }
    let dataStart = streamIndex + 'stream'.length;
    if (latin1[dataStart] === '\r') dataStart += 1;
    if (latin1[dataStart] === '\n') dataStart += 1;

    const header = latin1.slice(Math.max(0, streamIndex - PDF_DICTIONARY_WINDOW), streamIndex);
    const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(header);
    let dataEnd = -1;
    if (lengthMatch) {
      dataEnd = dataStart + Number(lengthMatch[1]);
    } else {
      const endKeyword = latin1.indexOf('endstream', dataStart);
      if (endKeyword !== -1) dataEnd = endKeyword;
    }
    if (dataStart >= latin1.length || dataEnd <= dataStart) {
      cursor = streamIndex + 'stream'.length;
      continue;
    }
    streams.push({ start: dataStart, end: Math.min(dataEnd, latin1.length), header });
    const endKeyword = latin1.indexOf('endstream', dataEnd);
    cursor = endKeyword === -1 ? dataEnd : endKeyword + 'endstream'.length;
  }
  return streams;
};

/** Inflate a stream when it is FlateDecode; skip unsupported filters entirely. */
const inflatePdfStream = (bytes, header) => {
  const isFlate = /\/FlateDecode\b/.test(header);
  if (/\/Filter\b/.test(header) && !isFlate) return null;
  if (!isFlate) return bytes.toString('latin1');
  try {
    return zlib.inflateSync(bytes, { maxOutputLength: MAX_INFLATED_STREAM_BYTES }).toString('latin1');
  } catch (error) {
    try {
      // A few generators omit the zlib header on an otherwise valid deflate stream.
      return zlib.inflateRawSync(bytes, { maxOutputLength: MAX_INFLATED_STREAM_BYTES }).toString('latin1');
    } catch (rawError) {
      return null;
    }
  }
};

const extractPdfText = (buffer) => {
  const latin1 = buffer.toString('latin1');
  if (latin1.includes('/Encrypt')) {
    throw new ResumeFileError(
      'RESUME_ENCRYPTED_PDF',
      'This PDF is password-protected, so its text could not be read. Upload a text file instead.',
      422
    );
  }
  if (!/^[\s\S]{0,1024}%PDF-/.test(latin1)) {
    throw new ResumeFileError('RESUME_INVALID_FILE', 'The uploaded file is not a readable PDF.');
  }

  const parts = [];
  for (const stream of collectPdfStreams(latin1)) {
    const content = inflatePdfStream(buffer.subarray(stream.start, stream.end), stream.header);
    if (!content) continue;
    const text = extractTextFromContentStream(content);
    if (text) parts.push(text);
  }
  return parts.join('\n');
};

const decodeUtf8Text = (buffer) => {
  if (buffer.includes(0x00)) {
    throw new ResumeFileError('RESUME_INVALID_FILE', 'The uploaded text file contains binary data.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ResumeFileError('RESUME_INVALID_FILE', 'The uploaded text file is not valid UTF-8 text.');
  }
};

/** Normalize extracted text: keep line structure, drop control characters. */
const sanitizeResumeText = (value) =>
  String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const countWordTokens = (text) => (text.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]{1,}/g) || []).length;

const printableRatioOf = (text) => {
  if (!text) return 0;
  let printable = 0;
  for (const char of text) {
    if (char === '\n' || char === ' ' || char === '\t') printable += 1;
    else if (/[^\u0000-\u001F\u007F-\u009F]/.test(char)) printable += 1;
  }
  return printable / text.length;
};

/**
 * Assert that extracted text is plausible resume text. Throws ResumeFileError
 * with a public message instead of forwarding unreadable content downstream.
 */
const assertUsableResumeText = (text) => {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ResumeFileError(
      'RESUME_NO_TEXT',
      'No readable text was found in the uploaded resume. Upload a text file instead.',
      422
    );
  }
  if (text.length > MAX_RESUME_TEXT_LENGTH) {
    throw new ResumeFileError(
      'RESUME_TEXT_TOO_LONG',
      `The resume text is longer than ${MAX_RESUME_TEXT_LENGTH} characters.`,
      413
    );
  }
  if (text.length < MIN_RESUME_TEXT_LENGTH) {
    throw new ResumeFileError(
      'RESUME_TEXT_TOO_SHORT',
      'The extracted resume text was too short to be analyzed.',
      422
    );
  }
  if (printableRatioOf(text) < MIN_PRINTABLE_RATIO || countWordTokens(text) < MIN_RESUME_WORD_COUNT) {
    throw new ResumeFileError(
      'RESUME_UNREADABLE_TEXT',
      'The resume text could not be read reliably. Upload a text file instead.',
      422
    );
  }
  return text;
};

/**
 * Validate + extract resume text from an in-memory buffer.
 * Returns { text, fileType } with sanitized, untrusted (but readable) text.
 */
const extractResumeText = ({ buffer, fileName, mimeType } = {}) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new ResumeFileError('RESUME_INVALID_FILE', 'The uploaded resume could not be read.');
  }
  if (buffer.length === 0) {
    throw new ResumeFileError('RESUME_INVALID_FILE', 'The uploaded resume file is empty.');
  }
  if (buffer.length > MAX_RESUME_FILE_BYTES) {
    throw new ResumeFileError(
      'RESUME_FILE_TOO_LARGE',
      `The resume file is larger than ${Math.round(MAX_RESUME_FILE_BYTES / (1024 * 1024))} MB.`,
      413
    );
  }

  const fileType = resolveResumeFileType({ fileName, mimeType });
  const raw = fileType === 'pdf' ? extractPdfText(buffer) : decodeUtf8Text(buffer);
  return { text: assertUsableResumeText(sanitizeResumeText(raw)), fileType };
};

module.exports = {
  MAX_RESUME_FILE_BYTES,
  MAX_RESUME_TEXT_LENGTH,
  MIN_RESUME_TEXT_LENGTH,
  RESUME_REQUEST_JSON_LIMIT_BYTES,
  SUPPORTED_FILE_HINT,
  ResumeFileError,
  resolveResumeFileType,
  sanitizeResumeText,
  assertUsableResumeText,
  extractResumeText,
};

