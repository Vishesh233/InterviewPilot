const MAX_JOB_DESCRIPTION_LENGTH = 50_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ID_LENGTH = 128;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasUnsafeKeys = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeKeys(entry, seen));
  return Object.keys(value).some(
    (key) => UNSAFE_KEYS.has(key) || hasUnsafeKeys(value[key], seen)
  );
};

const isBoundedString = (value, maxLength = MAX_TEXT_LENGTH, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && !value.trim()) return false;
  return value.length <= maxLength && !CONTROL_CHARACTERS.test(value);
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isSafeIdentifier = (value) =>
  typeof value === 'string' && IDENTIFIER_PATTERN.test(value) && !UNSAFE_KEYS.has(value);

const isPlainSafeObject = (value) => isPlainObject(value) && !hasUnsafeKeys(value);

module.exports = {
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_ID_LENGTH,
  isPlainObject,
  hasUnsafeKeys,
  isBoundedString,
  isSafeIdentifier,
  isPlainSafeObject,
};