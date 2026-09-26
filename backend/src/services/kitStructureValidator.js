// Kit Structure Validator — assignment Appendix A.
// Deterministic, LLM-independent service. Never throws for validation failures:
// always returns { valid, errors: [{ path, message, code }] }.

const {
  isBoundedString,
  isPlainSafeObject,
  isPlainObject,
  hasUnsafeKeys,
  isSafeIdentifier,
  MAX_TEXT_LENGTH,
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_JOB_ROLE_LENGTH,
} = require('./inputValidationService');

const REQUIRED_TOP_LEVEL = [
  'source',
  'company_brief',
  'role',
  'questions',
  'flashcards',
  'schedule',
  'coverage',
];

const MIN_INTERVIEW_DAYS = 1;
const MAX_INTERVIEW_DAYS = 60;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 3;

const isNonEmptyString = (value, maxLength = MAX_TEXT_LENGTH) =>
  isBoundedString(value, maxLength);

const isValidHttpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

const requirementEntryText = (entry) => {
  if (typeof entry === 'string') return entry.trim();
  if (!isPlainObject(entry)) return '';
  const candidates = [entry.id, entry.text, entry.requirement, entry.name, entry.title];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
};

const normalizeDifficulty = (difficulty) => {
  if (Number.isInteger(difficulty)) return difficulty;
  if (typeof difficulty === 'string') {
    const normalized = difficulty.trim().toLowerCase();
    if (normalized === 'easy') return 1;
    if (normalized === 'medium') return 2;
    if (normalized === 'hard') return 3;
  }
  return null;
};

const scheduleDayIds = (day) => {
  if (Array.isArray(day.question_ids)) return day.question_ids;
  if (Array.isArray(day.questionIds)) return day.questionIds;
  if (Array.isArray(day.questions)) return day.questions;
  return null;
};

const questionRequirementRefs = (question) => {
  if (Array.isArray(question.requirementRefs)) return question.requirementRefs;
  if (Array.isArray(question.requirementIds)) return question.requirementIds;
  if (Array.isArray(question.requirements)) return question.requirements;
  return null;
};

const questionText = (question) => {
  const candidates = [question.question, question.prompt, question.text, question.title];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
};

const validateKitStructure = (kit) => {
  const errors = [];
  const push = (path, message, code) => errors.push({ path, message, code });
  if (hasUnsafeKeys(kit)) {
    return { valid: false, errors: [{ path: '$', message: 'kit contains unsafe object keys.', code: 'UNSAFE_KEYS' }] };
  }

  if (!isPlainSafeObject(kit)) {
    return { valid: false, errors: [{ path: '$', message: 'kit must be an object.', code: 'INVALID_TYPE' }] };
  }
  for (const section of REQUIRED_TOP_LEVEL) {
    if (kit[section] === undefined || kit[section] === null) {
      push(`$.${section}`, `missing required section: ${section}.`, 'MISSING_SECTION');
    }
  }

  const requirementIds = new Set();
  const questionIds = new Set();
  const flashcardIds = new Set();

  if (kit.source !== undefined && kit.source !== null) {
    if (!isPlainObject(kit.source)) {
      push('$.source', 'source must be an object.', 'INVALID_TYPE');
    } else {
      if (!isNonEmptyString(kit.source.jobDescription, MAX_JOB_DESCRIPTION_LENGTH)) {
        push('$.source.jobDescription', 'source.jobDescription must be a non-empty string.', 'MISSING_FIELD');
      }
      if (!isValidHttpUrl(kit.source.companyUrl)) {
        push('$.source.companyUrl', 'source.companyUrl must be a valid HTTP/HTTPS URL.', 'INVALID_VALUE');
      }
      if (
        kit.source.interviewDays !== undefined &&
        (!Number.isInteger(kit.source.interviewDays) ||
          kit.source.interviewDays < MIN_INTERVIEW_DAYS ||
          kit.source.interviewDays > MAX_INTERVIEW_DAYS)
      ) {
        push(
          '$.source.interviewDays',
          `source.interviewDays must be an integer between ${MIN_INTERVIEW_DAYS} and ${MAX_INTERVIEW_DAYS} when present.`,
          'INVALID_VALUE'
        );
      }

      // Optional for backward compatibility: kits saved before the Job role
      // field existed have no source.jobRole and must keep loading normally.
      if (kit.source.jobRole !== undefined) {
        if (!isNonEmptyString(kit.source.jobRole)) {
          push('$.source.jobRole', 'source.jobRole must be a non-empty string when present.', 'MISSING_FIELD');
        } else if (kit.source.jobRole.length > MAX_JOB_ROLE_LENGTH) {
          push('$.source.jobRole', 'source.jobRole must be no longer than ' + MAX_JOB_ROLE_LENGTH + ' characters.', 'INVALID_VALUE');
        }
      }
    }
  }

  if (kit.company_brief !== undefined && kit.company_brief !== null) {
    if (!isPlainObject(kit.company_brief)) {
      push('$.company_brief', 'company_brief must be an object.', 'INVALID_TYPE');
    } else {
      if (!isNonEmptyString(kit.company_brief.name)) {
        push('$.company_brief.name', 'company_brief.name must be a non-empty string.', 'MISSING_FIELD');
      }
      if (!isNonEmptyString(kit.company_brief.summary)) {
        push('$.company_brief.summary', 'company_brief.summary must be a non-empty string.', 'MISSING_FIELD');
      }
      if (!Array.isArray(kit.company_brief.sources)) {
        push('$.company_brief.sources', 'company_brief.sources must be an array.', 'INVALID_TYPE');
      } else {
        kit.company_brief.sources.forEach((source, index) => {
          const base = `$.company_brief.sources[${index}]`;
          if (!isPlainObject(source)) {
            push(base, 'source entry must be an object.', 'INVALID_TYPE');
            return;
          }
          if (!isValidHttpUrl(source.url)) {
            push(`${base}.url`, 'source url must be a valid HTTP/HTTPS URL.', 'INVALID_VALUE');
          }
          if (source.title !== undefined && source.title !== null && !isBoundedString(source.title, 300, { allowEmpty: true })) {
            push(`${base}.title`, 'source title must be a string when present.', 'INVALID_TYPE');
          }
        });
      }
    }
  }

  // ---- role + requirements ----
  if (kit.role !== undefined && kit.role !== null) {
    if (!isPlainObject(kit.role)) {
      push('$.role', 'role must be an object.', 'INVALID_TYPE');
    } else {
      if (!isNonEmptyString(kit.role.title)) {
        push('$.role.title', 'role.title must be a non-empty string.', 'MISSING_FIELD');
      }
      if (kit.role.level !== undefined && kit.role.level !== null && !isBoundedString(kit.role.level, 100, { allowEmpty: true })) {
        push('$.role.level', 'role.level must be a string when present.', 'INVALID_TYPE');
      }
      if (kit.role.requirements === undefined || kit.role.requirements === null) {
        push('$.role.requirements', 'role.requirements is required.', 'MISSING_FIELD');
      } else if (!Array.isArray(kit.role.requirements)) {
        push('$.role.requirements', 'role.requirements must be an array.', 'INVALID_TYPE');
      } else {
        kit.role.requirements.forEach((entry, index) => {
          const base = `$.role.requirements[${index}]`;
          const text = requirementEntryText(entry);
          if (!text || text.length > MAX_TEXT_LENGTH) {
            push(base, 'requirement entry must be a non-empty string or object id/text.', 'MISSING_FIELD');
            return;
          }
          const id = isPlainObject(entry) && isNonEmptyString(entry.id) ? entry.id.trim() : text;
          if (requirementIds.has(id)) {
            push(base, `duplicate requirement id: ${id}.`, 'DUPLICATE_ID');
          } else {
            requirementIds.add(id);
          }
        });
      }
    }
  }

  // ---- questions ----
  if (kit.questions !== undefined && kit.questions !== null) {
    if (!Array.isArray(kit.questions) || kit.questions.length === 0) {
      push('$.questions', 'questions must be a non-empty array.', 'INVALID_VALUE');
    } else {
      kit.questions.forEach((question, index) => {
        const base = `$.questions[${index}]`;
        if (!isPlainObject(question)) {
          push(base, 'question must be an object.', 'INVALID_TYPE');
          return;
        }
        if (!isSafeIdentifier(question.id)) {
          push(`${base}.id`, 'question.id must be a safe non-empty string.', 'MISSING_FIELD');
        } else if (questionIds.has(question.id)) {
          push(`${base}.id`, `duplicate question id: ${question.id.trim()}.`, 'DUPLICATE_ID');
        } else {
          questionIds.add(question.id);
        }
        if (!isNonEmptyString(question.question || question.prompt || question.text || question.title, MAX_TEXT_LENGTH)) {
          push(`${base}.question`, 'question text must be non-empty.', 'MISSING_FIELD');
        }
        const difficulty = normalizeDifficulty(question.difficulty);
        if (difficulty === null || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
          push(`${base}.difficulty`, 'question difficulty must be 1-3.', 'INVALID_VALUE');
        }
        if (
          question.category !== undefined && question.category !== null &&
          (!isBoundedString(question.category, 100) ||
            !['technical', 'behavioral', 'company', 'role_specific'].includes(question.category))
        ) {
          push(`${base}.category`, 'question category must be a supported category.', 'INVALID_VALUE');
        }
        if (question.status !== undefined && !['generated', 'edited'].includes(question.status)) {
          push(`${base}.status`, 'question status must be generated or edited.', 'INVALID_VALUE');
        }
        if (question.pinned !== undefined && typeof question.pinned !== 'boolean') {
          push(`${base}.pinned`, 'question pinned must be a boolean.', 'INVALID_TYPE');
        }
        if (question.why !== undefined && !isNonEmptyString(question.why, MAX_TEXT_LENGTH)) {
          push(`${base}.why`, 'question why must be a bounded non-empty string.', 'INVALID_VALUE');
        }
        for (const field of ['expectedAnswerPoints', 'followUps', 'sources', 'requirementRefs']) {
          if (question[field] === undefined) continue;
          const values = question[field];
          const validArray = Array.isArray(values) && values.length <= 100;
          const validItems = validArray && values.every((value) => isBoundedString(value, MAX_TEXT_LENGTH));
          if (!validItems || (field === 'sources' && values.some((value) => !isValidHttpUrl(value)))) {
            push(`${base}.${field}`, `${field} must be a bounded array of valid strings.`, 'INVALID_VALUE');
          }
        }
      });
    }
  }

  // ---- flashcards ----
  if (kit.flashcards !== undefined && kit.flashcards !== null) {
    if (!Array.isArray(kit.flashcards)) {
      push('$.flashcards', 'flashcards must be an array.', 'INVALID_TYPE');
    } else {
      kit.flashcards.forEach((card, index) => {
        const base = `$.flashcards[${index}]`;
        if (!isPlainObject(card)) {
          push(base, 'flashcard must be an object.', 'INVALID_TYPE');
          return;
        }
        if (!isSafeIdentifier(card.id)) {
          push(`${base}.id`, 'flashcard.id must be a safe non-empty string.', 'MISSING_FIELD');
        } else if (flashcardIds.has(card.id)) {
          push(`${base}.id`, `duplicate flashcard id: ${card.id.trim()}.`, 'DUPLICATE_ID');
        } else {
          flashcardIds.add(card.id);
        }
        if (!isNonEmptyString(card.front) && !isNonEmptyString(card.term)) {
          push(`${base}.front`, 'flashcard front/term must be non-empty.', 'MISSING_FIELD');
        }
        if (!isNonEmptyString(card.back) && !isNonEmptyString(card.definition)) {
          push(`${base}.back`, 'flashcard back/definition must be non-empty.', 'MISSING_FIELD');
        }
      });
    }
  }

  // ---- schedule ----
  if (kit.schedule !== undefined && kit.schedule !== null) {
    if (!isPlainObject(kit.schedule)) {
      push('$.schedule', 'schedule must be an object.', 'INVALID_TYPE');
    } else {
      const daysValue = kit.schedule.interviewDays;
      if (
        daysValue === undefined ||
        daysValue === null ||
        !Number.isInteger(daysValue) ||
        daysValue < MIN_INTERVIEW_DAYS ||
        daysValue > MAX_INTERVIEW_DAYS
      ) {
        push('$.schedule.interviewDays', 'schedule.interviewDays must be 1-60.', 'INVALID_VALUE');
      }
      if (!Array.isArray(kit.schedule.days)) {
        push('$.schedule.days', 'schedule.days must be an array.', 'INVALID_TYPE');
      } else {
        const seenDayNumbers = new Set();
        kit.schedule.days.forEach((day, index) => {
          const base = `$.schedule.days[${index}]`;
          if (!isPlainObject(day)) {
            push(base, 'schedule day must be an object.', 'INVALID_TYPE');
            return;
          }
          const dayNumber = day.day ?? index + 1;
          if (!Number.isInteger(dayNumber) || dayNumber < 1) {
            push(`${base}.day`, 'schedule day number must be positive.', 'INVALID_VALUE');
          } else if (seenDayNumbers.has(dayNumber)) {
            push(`${base}.day`, 'schedule day numbers must be unique.', 'DUPLICATE_ID');
          } else {
            seenDayNumbers.add(dayNumber);
          }
          const ids = scheduleDayIds(day);
          if (ids === null) {
            push(`${base}.question_ids`, 'schedule day must list question ids.', 'MISSING_FIELD');
          } else {
            ids.forEach((id, idIndex) => {
              if (!isSafeIdentifier(id)) {
                push(`${base}.question_ids[${idIndex}]`, 'scheduled id must be a safe non-empty string.', 'INVALID_VALUE');
              }
            });
          }
        });
      }
    }
  }

  // ---- coverage ----
  if (kit.coverage !== undefined && kit.coverage !== null) {
    if (!isPlainObject(kit.coverage)) {
      push('$.coverage', 'coverage must be an object.', 'INVALID_TYPE');
    } else {
      const pct = kit.coverage.coveragePercent;
      if (pct !== undefined && pct !== null && (typeof pct !== 'number' || pct < 0 || pct > 100)) {
        push('$.coverage.coveragePercent', 'coveragePercent must be 0-100.', 'INVALID_VALUE');
      }
      for (const field of ['coveredRequirements', 'missingRequirements']) {
        const value = kit.coverage[field];
        if (value !== undefined && value !== null && !Array.isArray(value)) {
          push(`$.coverage.${field}`, `${field} must be an array when present.`, 'INVALID_TYPE');
        }
      }
    }
  }

  // ---- cross-reference checks ----
  if (questionIds.size > 0) {
    if (Array.isArray(kit.questions)) {
      kit.questions.forEach((question, index) => {
        if (!isPlainObject(question)) return;
        const refs = questionRequirementRefs(question);
        if (refs === null) return;
        refs.forEach((ref, refIndex) => {
          if (typeof ref !== 'string' || !ref.trim()) {
            push(`$.questions[${index}].requirementRefs[${refIndex}]`, 'ref must be non-empty.', 'INVALID_VALUE');
          } else if (requirementIds.size > 0 && !requirementIds.has(ref.trim())) {
            push(`$.questions[${index}].requirementRefs[${refIndex}]`, `unknown ref: ${ref.trim()}.`, 'UNKNOWN_REFERENCE');
          }
        });
      });
    }
    if (isPlainObject(kit.schedule) && Array.isArray(kit.schedule.days)) {
      kit.schedule.days.forEach((day, index) => {
        if (!isPlainObject(day)) return;
        const ids = scheduleDayIds(day);
        if (ids === null) return;
        ids.forEach((id, idIndex) => {
          if (!isSafeIdentifier(id)) return;
          if (!questionIds.has(id)) {
            push(`$.schedule.days[${index}].question_ids[${idIndex}]`, `unknown id: ${id.trim()}.`, 'UNKNOWN_REFERENCE');
          }
        });
      });
    }
    if (Array.isArray(kit.flashcards)) {
      kit.flashcards.forEach((card, index) => {
        if (!isPlainObject(card)) return;
        const refs = Array.isArray(card.questionIds) ? card.questionIds : null;
        if (refs === null) return;
        refs.forEach((ref, refIndex) => {
          if (!isSafeIdentifier(ref)) {
            push(`$.flashcards[${index}].questionIds[${refIndex}]`, 'ref must be a safe non-empty string.', 'INVALID_VALUE');
          } else if (!questionIds.has(ref)) {
            push(`$.flashcards[${index}].questionIds[${refIndex}]`, `unknown id: ${ref.trim()}.`, 'UNKNOWN_REFERENCE');
          }
        });
      });
    }
  }

  return { valid: errors.length === 0, errors };
};

module.exports = { validateKitStructure };
