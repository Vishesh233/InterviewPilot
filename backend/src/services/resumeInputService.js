// Optional resume input normalization for the preparation-kit request.
//
// Two practical shapes are accepted on the JSON request body:
//   { "resume": { "text": "..." } }                              (typed/pasted text)
//   { "resume": { "fileName": "cv.pdf", "mimeType": "application/pdf",
//                 "dataBase64": "..." } }                         (file upload)
//
// The upload is fully validated here (type allowlist, decoded size limit, real
// file signature/decodability) and converted to plain text. Nothing is written to
// disk, logged, echoed in an error, or returned to a client: the caller only ever
// receives { text, fileName, fileType, charCount }.
//
// The extracted text is UNTRUSTED data. Every prompt that consumes it must treat
// it as evidence, never as instructions.

const {
  MAX_RESUME_FILE_BYTES,
  MAX_RESUME_TEXT_LENGTH,
  ResumeFileError,
  extractResumeText,
  resolveResumeFileType,
  assertUsableResumeText,
  sanitizeResumeText,
} = require('./resumeTextExtractor');
const { isPlainObject, hasUnsafeKeys, isBoundedString } = require('./inputValidationService');

const MAX_RESUME_FILE_NAME_LENGTH = 200;
const MAX_RESUME_BASE64_LENGTH = Math.ceil((MAX_RESUME_FILE_BYTES * 4) / 3) + 8;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

class ResumeInputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ResumeInputError';
    this.code = code;
    this.status = status;
    this.isPublic = true;
  }
}

const asResumeInputError = (error) => {
  if (error instanceof ResumeInputError) return error;
  if (error instanceof ResumeFileError) {
    return new ResumeInputError(error.code, error.message, error.status);
  }
  return new ResumeInputError('RESUME_INVALID_PAYLOAD', 'The resume attachment could not be read.');
};

// Display-only: a basename is kept, any directory component is dropped.
const safeFileName = (value) =>
  typeof value === 'string' && isBoundedString(value, MAX_RESUME_FILE_NAME_LENGTH, { allowEmpty: true })
    ? value.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, '').trim()
    : '';

/** Strict, padding-checked base64 decode. Never trusts Buffer.from() alone. */
const decodeBase64Resume = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'The resume file data is missing.');
  }
  if (value.length > MAX_RESUME_BASE64_LENGTH) {
    throw new ResumeInputError(
      'RESUME_FILE_TOO_LARGE',
      `The resume file is larger than ${Math.round(MAX_RESUME_FILE_BYTES / (1024 * 1024))} MB.`,
      413
    );
  }
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'The resume file data is not valid base64.');
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'The resume file data is empty.');
  }
  if (buffer.length > MAX_RESUME_FILE_BYTES) {
    throw new ResumeInputError(
      'RESUME_FILE_TOO_LARGE',
      `The resume file is larger than ${Math.round(MAX_RESUME_FILE_BYTES / (1024 * 1024))} MB.`,
      413
    );
  }
  if (buffer.toString('base64') !== normalized) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'The resume file data is not valid base64.');
  }
  return buffer;
};

/** Plain typed/pasted resume text (no file involved). */
const normalizeResumeText = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'resume.text must be a non-empty string.');
  }
  if (value.length > MAX_RESUME_TEXT_LENGTH) {
    throw new ResumeInputError(
      'RESUME_TEXT_TOO_LONG',
      `The resume text is longer than ${MAX_RESUME_TEXT_LENGTH} characters.`,
      413
    );
  }
  return assertUsableResumeText(sanitizeResumeText(value));
};

/**
 * Normalize the optional `resume` request field.
 * Returns null when no resume was supplied (the JD-only flow is unchanged).
 * Throws ResumeInputError with a machine-readable code for anything invalid.
 */
const normalizeResumeInput = (resume) => {
  if (resume === undefined || resume === null) return null;
  if (!isPlainObject(resume) || hasUnsafeKeys(resume)) {
    throw new ResumeInputError('RESUME_INVALID_PAYLOAD', 'resume must be a safe JSON object.');
  }

  const fileName = safeFileName(resume.fileName);
  try {
    // The declared file type is validated even when `text` is supplied: an
    // unsupported type is never accepted, whatever else the payload carries.
    const declaredType = fileName || resume.mimeType
      ? resolveResumeFileType({ fileName, mimeType: resume.mimeType })
      : null;

    if (resume.text !== undefined) {
      const text = normalizeResumeText(resume.text);
      return { text, fileName, fileType: declaredType || 'text', charCount: text.length };
    }

    const base64 = resume.dataBase64 !== undefined ? resume.dataBase64 : resume.base64;
    if (base64 === undefined) {
      throw new ResumeInputError(
        'RESUME_INVALID_PAYLOAD',
        'resume must contain either text or a base64-encoded file.'
      );
    }
    const buffer = decodeBase64Resume(base64);
    const extracted = extractResumeText({ buffer, fileName, mimeType: resume.mimeType });
    return {
      text: extracted.text,
      fileName,
      fileType: extracted.fileType,
      charCount: extracted.text.length,
    };
  } catch (error) {
    throw asResumeInputError(error);
  }
};

/** Additive, non-content resume metadata for the generated kit. */
const toResumeMetadata = (normalized) => {
  if (!normalized) return null;
  const text = typeof normalized.text === 'string' ? normalized.text : '';
  return {
    provided: true,
    ...(safeFileName(normalized.fileName) ? { fileName: safeFileName(normalized.fileName) } : {}),
    fileType: normalized.fileType === 'pdf' ? 'pdf' : 'text',
    charCount: Number.isInteger(normalized.charCount) ? normalized.charCount : text.length,
  };
};

module.exports = {
  MAX_RESUME_FILE_NAME_LENGTH,
  ResumeInputError,
  normalizeResumeInput,
  normalizeResumeText,
  toResumeMetadata,
};
