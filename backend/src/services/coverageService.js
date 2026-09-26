// Deterministic requirement-coverage checker.
// No LLM, no I/O — the same inputs always produce the same output.

const REQUIREMENT_LIST_FIELDS = [
  'mustHaveSkills',
  'niceToHaveSkills',
  'responsibilities',
  'qualifications',
  'interviewSignals',
];

// Extract the requirement strings from an extractRequirements()-style object.
// Strings are trimmed and de-duplicated (first occurrence order is preserved).
const extractRequirementStrings = (requirements) => {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw new Error('requirements must be an object returned by extractRequirements().');
  }

  // The collected requirement universe MUST be identical to the one
  // buildFinalKit() writes into `role.requirements`
  // (interviewPrepPipelineService.uniqueRequirementIds): the role title and
  // seniority are requirements too.
  //
  // They used to be type-checked here but never collected, so they appeared in
  // neither coveredRequirements nor missingRequirements even though the UI
  // rendered them from role.requirements. A question was therefore free to
  // reference the role (which questionGenerationService explicitly allows, and
  // kitStructureValidator requires to be declared) while coverage reported the
  // role as neither covered nor missing — showing it as a Gap and computing
  // coveragePercent over a smaller denominator than the displayed total.
  //
  // Order matters: it mirrors uniqueRequirementIds so the coverage arrays stay
  // aligned with the role.requirements order the UI renders.
  const raw = [];
  for (const field of ['role', 'seniority']) {
    const value = requirements[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`requirements.${field} must be a string or null.`);
    }
    raw.push(value);
  }
  for (const field of REQUIREMENT_LIST_FIELDS) {
    const value = requirements[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`requirements.${field} must be an array of strings.`);
    }
    raw.push(...value);
  }

  const seen = new Set();
  const strings = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      strings.push(trimmed);
    }
  }
  return strings;
};

/**
 * Check which requirement strings are referenced by at least one question.
 * Returns { coveredRequirements, missingRequirements, coveragePercent }.
 */
const checkCoverage = ({ requirements, questions } = {}) => {
  const requirementStrings = extractRequirementStrings(requirements);

  if (!Array.isArray(questions)) {
    throw new Error('questions must be an array of question objects.');
  }

  // Collect every usable requirementRef — invalid question objects are ignored
  // safely instead of crashing the check.
  const refs = new Set();
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
    if (!Array.isArray(question.requirementRefs)) continue;
    for (const ref of question.requirementRefs) {
      if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
    }
  }

  // Exact match only — no semantic or fuzzy matching.
  const coveredRequirements = requirementStrings.filter((requirement) => refs.has(requirement));
  const missingRequirements = requirementStrings.filter((requirement) => !refs.has(requirement));

  const coveragePercent =
    requirementStrings.length === 0
      ? 100
      : Math.round((coveredRequirements.length / requirementStrings.length) * 100);

  return { coveredRequirements, missingRequirements, coveragePercent };
};

module.exports = { checkCoverage };
