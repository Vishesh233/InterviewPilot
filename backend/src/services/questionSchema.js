// Question schema/validation module for the interview-prep pipeline.
// Pure and deterministic — no LLM, no I/O, no side effects.

const {
  MAX_TEXT_LENGTH,
  isBoundedString,
  isSafeIdentifier,
  isPlainObject,
  hasUnsafeKeys,
} = require('./inputValidationService');

const QUESTION_CATEGORIES = ['technical', 'behavioral', 'company', 'role_specific'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const ARRAY_FIELDS = ['expectedAnswerPoints', 'followUps', 'sources', 'requirementRefs'];

const isPlainQuestionObject = (value) => isPlainObject(value) && !hasUnsafeKeys(value);

const isNonEmptyString = (value, maxLength = MAX_TEXT_LENGTH) => isBoundedString(value, maxLength);
const isStringArray = (value, { allowEmptyItems = false } = {}) =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => isBoundedString(item, MAX_TEXT_LENGTH, { allowEmpty: allowEmptyItems }));

/**
 * Validate a question object.
 * Returns { valid: true } or { valid: false, errors: [...] } with every
 * problem found (all field errors are collected, not just the first).
 */
const validateQuestion = (question) => {
  if (!isPlainQuestionObject(question)) {
    return { valid: false, errors: ['question must be an object'] };
  }

  const errors = [];

  if (!isSafeIdentifier(question.id)) {
    errors.push('id must be a non-empty string');
  }
  if (!isNonEmptyString(question.question)) {
    errors.push('question must be a non-empty string');
  }
  if (!QUESTION_CATEGORIES.includes(question.category)) {
    errors.push(`category must be one of: ${QUESTION_CATEGORIES.join(', ')}`);
  }
  if (!DIFFICULTIES.includes(question.difficulty)) {
    errors.push(`difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
  }
  if (!isNonEmptyString(question.why)) {
    errors.push('why must be a non-empty string');
  }
  for (const field of ARRAY_FIELDS) {
    if (!isStringArray(question[field], { allowEmptyItems: field === 'requirementRefs' })) {
      errors.push(`${field} must be an array of strings`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
};

module.exports = { validateQuestion, QUESTION_CATEGORIES, DIFFICULTIES };
