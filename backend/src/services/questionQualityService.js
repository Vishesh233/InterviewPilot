// Deterministic question-quality checks.
// Pure and LLM-free: the same questions always produce the same report. These
// checks never delete or rewrite a question on their own — callers decide, and any
// regeneration must go through the existing LLM services.
//
// Codes reported:
//   DUPLICATE_QUESTION              identical text (normalized)
//   NEAR_DUPLICATE_QUESTION         highly similar text (token Jaccard >= threshold)
//   REDUNDANT_REQUIREMENT_COVERAGE  same category + exactly the same requirementRefs
//   UNRELATED_REQUIREMENT_COVERAGE  no referenced requirement token appears in the question
//   REPETITIVE_CATEGORY             one category dominates the bank

const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.8;
const DEFAULT_MAX_CATEGORY_SHARE = 0.6;
const MIN_CATEGORY_REPETITION_COUNT = 3;

// Generic words carry no requirement meaning, so they never count as coverage.
const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'was', 'were', 'are', 'has',
  'have', 'had', 'use', 'used', 'using', 'work', 'works', 'worked', 'experience', 'experienced',
  'team', 'teams', 'year', 'years', 'role', 'roles', 'company', 'ability', 'strong', 'good', 'plus',
  'including', 'etc', 'you', 'your', 'our', 'their', 'his', 'her', 'will', 'would', 'should', 'must',
  'into', 'over', 'more', 'most', 'other', 'others', 'such', 'about', 'across', 'during', 'while',
]);

const normalizeQuestionText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\.[\s.]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokensOf = (value) =>
  normalizeQuestionText(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

const tokenSetOf = (value) => new Set(tokensOf(value));

const jaccardSimilarity = (left, right) => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
};

const questionText = (question) =>
  typeof question?.question === 'string'
    ? question.question
    : typeof question?.prompt === 'string'
      ? question.prompt
      : '';

const refsOf = (question) =>
  (Array.isArray(question?.requirementRefs)
    ? question.requirementRefs
    : Array.isArray(question?.requirementIds)
      ? question.requirementIds
      : []
  ).filter((ref) => typeof ref === 'string' && ref.trim());

const idOf = (question) => (typeof question?.id === 'string' && question.id.trim() ? question.id.trim() : '');

/** Exact duplicate text groups (first occurrence wins; later ones are duplicates). */
const findExactDuplicates = (questions) => {
  const seen = new Set();
  const duplicates = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const text = normalizeQuestionText(questionText(question));
    if (!text) continue;
    if (seen.has(text)) duplicates.push(idOf(question));
    else seen.add(text);
  }
  return duplicates;
};

/** Near-duplicate pairs above the similarity threshold (exact duplicates excluded). */
const findNearDuplicates = (questions, threshold = DEFAULT_NEAR_DUPLICATE_THRESHOLD) => {
  const list = Array.isArray(questions) ? questions : [];
  const pairs = [];
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const leftText = normalizeQuestionText(questionText(list[left]));
      const rightText = normalizeQuestionText(questionText(list[right]));
      if (!leftText || !rightText || leftText === rightText) continue;
      const similarity = jaccardSimilarity(tokenSetOf(leftText), tokenSetOf(rightText));
      if (similarity >= threshold) {
        pairs.push({ questionIds: [idOf(list[left]), idOf(list[right])], similarity: Number(similarity.toFixed(3)) });
      }
    }
  }
  return pairs;
};

/** Questions in the same category that reference exactly the same requirement set. */
const findRedundantRequirementCoverage = (questions) => {
  const groups = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    const refs = refsOf(question);
    if (refs.length === 0) continue;
    const category = typeof question?.category === 'string' ? question.category : '';
    const key = `${category}|${[...refs].sort().join('|')}`;
    if (!groups.has(key)) groups.set(key, { category, requirementRefs: [...refs], questionIds: [] });
    groups.get(key).questionIds.push(idOf(question));
  }
  return [...groups.values()].filter((group) => group.questionIds.length > 1);
};

// Requirement tokens use the SAME tokenizer as questions (digits and plus signs
// kept, generic words dropped, punctuation-normalized) so the comparison is
// symmetric: "Node.js" on both sides must not become "node.js" versus "node js".
const requirementTokens = (value) => tokensOf(value);

/** True when at least one referenced requirement token appears in the question. */
const questionMentionsRequirement = (question, requirement) => {
  const expected = requirementTokens(requirement);
  if (expected.length === 0) return true; // nothing meaningful to verify
  const questionTokens = tokenSetOf(
    [questionText(question), question?.why, ...(Array.isArray(question?.expectedAnswerPoints) ? question.expectedAnswerPoints : [])]
      .filter((value) => typeof value === 'string')
      .join(' ')
  );
  return expected.some((token) => questionTokens.has(token));
};

/** Questions whose referenced requirements are nowhere mentioned in the question. */
const findUnrelatedQuestions = (questions) => {
  const unrelated = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const refs = refsOf(question);
    if (refs.length === 0) continue;
    if (!refs.some((ref) => questionMentionsRequirement(question, ref))) {
      unrelated.push({ questionId: idOf(question), requirementRefs: [...refs] });
    }
  }
  return unrelated;
};

/** Categories whose share of the bank exceeds maxShare (small banks are ignored). */
const findRepetitiveCategories = (questions, maxShare = DEFAULT_MAX_CATEGORY_SHARE) => {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length < MIN_CATEGORY_REPETITION_COUNT) return [];
  const counts = new Map();
  for (const question of list) {
    const category = typeof question?.category === 'string' && question.category ? question.category : 'uncategorized';
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_CATEGORY_REPETITION_COUNT && count / list.length > maxShare)
    .map(([category, count]) => ({ category, count, share: Number((count / list.length).toFixed(3)) }));
};

/**
 * Full deterministic quality report.
 * Returns { ok, summary, issues } — `issues` is empty for a clean question bank.
 */
const reportQuestionQuality = ({
  questions,
  nearDuplicateThreshold = DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  maxCategoryShare = DEFAULT_MAX_CATEGORY_SHARE,
} = {}) => {
  if (!Array.isArray(questions)) {
    throw new Error('questions must be an array of question objects.');
  }

  const duplicateIds = findExactDuplicates(questions);
  const nearDuplicates = findNearDuplicates(questions, nearDuplicateThreshold);
  const redundant = findRedundantRequirementCoverage(questions);
  const unrelated = findUnrelatedQuestions(questions);
  const repetitiveCategories = findRepetitiveCategories(questions, maxCategoryShare);

  const issues = [];
  if (duplicateIds.length > 0) issues.push({ code: 'DUPLICATE_QUESTION', questionIds: duplicateIds });
  for (const pair of nearDuplicates) {
    issues.push({ code: 'NEAR_DUPLICATE_QUESTION', questionIds: pair.questionIds, similarity: pair.similarity });
  }
  for (const group of redundant) {
    issues.push({ code: 'REDUNDANT_REQUIREMENT_COVERAGE', questionIds: group.questionIds, requirementRefs: group.requirementRefs });
  }
  for (const entry of unrelated) {
    issues.push({ code: 'UNRELATED_REQUIREMENT_COVERAGE', questionIds: [entry.questionId], requirementRefs: entry.requirementRefs });
  }
  for (const entry of repetitiveCategories) {
    issues.push({ code: 'REPETITIVE_CATEGORY', category: entry.category, count: entry.count, share: entry.share });
  }

  return {
    ok: issues.length === 0,
    summary: {
      totalQuestions: questions.length,
      duplicateQuestions: duplicateIds.length,
      nearDuplicatePairs: nearDuplicates.length,
      redundantRequirementGroups: redundant.length,
      unrelatedRequirementQuestions: unrelated.length,
      repetitiveCategories: repetitiveCategories.length,
    },
    issues,
  };
};

/**
 * Keep the first occurrence of each question text and report what was dropped.
 * Used by the gap-fill workflows so an identical question is never appended twice
 * while the caller can still report exactly what happened.
 */
const dropExactDuplicates = (questions) => {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const text = normalizeQuestionText(questionText(question));
    if (text && seen.has(text)) {
      dropped.push(idOf(question));
      continue;
    }
    if (text) seen.add(text);
    kept.push(question);
  }
  return { kept, dropped };
};

module.exports = {
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  DEFAULT_MAX_CATEGORY_SHARE,
  normalizeQuestionText,
  jaccardSimilarity,
  findExactDuplicates,
  findNearDuplicates,
  findRedundantRequirementCoverage,
  findUnrelatedQuestions,
  findRepetitiveCategories,
  questionMentionsRequirement,
  reportQuestionQuality,
  dropExactDuplicates,
};
