// Deterministic clean-up of an extractRequirements() result. No LLM, no I/O:
// the same input always yields the same output, so extraction quality does not
// depend on the model following every prompt rule.
//
//  1. Role metadata is not a requirement: list items that are the job title,
//     the seniority ("Mid Level", "senior") or a years-of-experience line
//     ("3+ years of ...") are removed. The years become `yearsExperience`.
//  2. Something under responsibilities / "you will" is required: a
//     nice-to-have item that the job description never mentions inside a
//     nice-to-have / bonus / preferred section moves to mustHaveSkills.
//  3. Duplicates are removed: exact duplicates across lists (normalized), and
//     interview signals or qualifications that only reword other requirements.

const REQUIREMENT_LIST_FIELDS = [
  'mustHaveSkills',
  'niceToHaveSkills',
  'responsibilities',
  'qualifications',
  'interviewSignals',
];

// Priority for exact duplicates: the first list that holds an item keeps it.
const DEDUPE_PRIORITY = ['mustHaveSkills', 'responsibilities', 'qualifications', 'niceToHaveSkills', 'interviewSignals'];

const SENIORITY_WORDS = 'junior|jr\\.?|mid|middle|intermediate|senior|sr\\.?|lead|principal|staff|entry|associate|graduate|intern';
const SENIORITY_ONLY = new RegExp(`^(?:${SENIORITY_WORDS})(?:[\\s-]*(?:level|grade))?$`, 'i');
// "3+ years", "3-5 years", "5 or more years", "2 yrs"
const YEARS_PATTERN = /\b(\d{1,2})\s*(\+|plus|or\s+more)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?)\b/i;

const OPTIONAL_MARKER = /\b(?:nice[\s-]to[\s-]have|good[\s-]to[\s-]have|bonus|preferred|a\s+plus|desirable|optional)\b/i;
const BULLET_LINE = /^\s*(?:[-*•–]|\d+[.)])\s+/;

// Words that carry no requirement meaning when comparing two phrasings.
const FILLER_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'in', 'on', 'with', 'to', 'for', 'using', 'use', 'like', 'such', 'as',
  'or', 'at', 'by', 'from', 'into', 'via', 'e', 'g', 'eg', 'etc', 'including', 'plus', 'them', 'it',
  'experience', 'experienced', 'ability', 'able', 'proficiency', 'proficient', 'familiarity', 'familiar',
  'knowledge', 'knowledgeable', 'understanding', 'understand', 'strong', 'solid', 'good', 'excellent',
  'deep', 'proven', 'demonstrated', 'hands', 'skills', 'skill', 'skilled', 'practical', 'professional',
]);
const SUFFIXES = ['izations', 'ization', 'isations', 'isation', 'ations', 'ation', 'ments', 'ment', 'izing', 'ising', 'ize', 'ise', 'ings', 'ing', 'ers', 'er', 'ies', 'es', 'ed', 's'];

const normalizedKey = (value) => value.toLowerCase().replace(/[^a-z0-9+#]+/g, '');

const stemOnce = (word) => {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return suffix === 'ies' ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
    }
  }
  return word;
};

// Repeated until stable, so "implementing" and "implement" (or "deployment"
// and "deploying") end up as the same stem. Crude, but applied to both sides.
const stem = (word) => {
  let current = word;
  for (let round = 0; round < 4; round += 1) {
    const next = stemOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
};

const contentStems = (value) =>
  [...new Set(
    value.toLowerCase().split(/[^a-z0-9+#]+/).filter((word) => word && !FILLER_WORDS.has(word)).map(stem)
  )];

const isTitleOrSeniority = (item, role, seniority) => {
  const key = normalizedKey(item);
  if (!key) return true;
  if (role && key === normalizedKey(role)) return true;
  if (seniority && key === normalizedKey(seniority)) return true;
  return SENIORITY_ONLY.test(item.trim());
};

const formatYears = (match) => {
  const [, from, plus, to] = match;
  if (to) return `${from}–${to} years`;
  return `${from}${plus ? '+' : ''} years`;
};

// The lines of the job description that sit in a nice-to-have / bonus /
// preferred section: the marker line itself plus the bullets (and blank
// lines) right after it, up to the next non-bullet line.
const optionalSectionText = (jobDescription) => {
  if (typeof jobDescription !== 'string') return '';
  const kept = [];
  let inSection = false;
  for (const line of jobDescription.split(/\r?\n/)) {
    if (OPTIONAL_MARKER.test(line)) {
      inSection = true;
      kept.push(line);
    } else if (inSection && (BULLET_LINE.test(line) || !line.trim())) {
      kept.push(line);
    } else {
      inSection = false;
    }
  }
  return kept.join('\n').toLowerCase();
};

// Share of `stems` that also appear in `otherStems`.
const overlap = (stems, otherStems) => {
  if (stems.length === 0) return { shared: 0, ratio: 0 };
  const other = new Set(otherStems);
  const shared = stems.filter((value) => other.has(value)).length;
  return { shared, ratio: shared / stems.length };
};

// An interview signal that mostly repeats ONE other requirement (2+ shared
// content words and at least 60 % of its own) is a rewording of it.
const REWORD_MIN_SHARED = 2;
const REWORD_MIN_RATIO = 0.6;

/**
 * @param {object} extracted extractRequirements()-shaped object
 * @param {{ jobDescription?: string }} [options]
 * @returns {object} same shape plus `yearsExperience` (string or null)
 */
const refineRequirements = (extracted, { jobDescription } = {}) => {
  const role = typeof extracted?.role === 'string' && extracted.role.trim() ? extracted.role.trim() : null;
  const seniority = typeof extracted?.seniority === 'string' && extracted.seniority.trim() ? extracted.seniority.trim() : null;
  let yearsExperience = typeof extracted?.yearsExperience === 'string' && extracted.yearsExperience.trim()
    ? extracted.yearsExperience.trim()
    : null;

  const lists = {};
  for (const field of REQUIREMENT_LIST_FIELDS) {
    const items = Array.isArray(extracted?.[field]) ? extracted[field] : [];
    lists[field] = items
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .filter((item) => {
        // 1. Role metadata, not requirements.
        if (isTitleOrSeniority(item, role, seniority)) return false;
        const years = YEARS_PATTERN.exec(item);
        if (years) {
          if (!yearsExperience) yearsExperience = formatYears(years);
          return false;
        }
        return true;
      });
  }

  // 2. Nice-to-have only when the JD puts it in a nice-to-have section.
  const optionalText = optionalSectionText(jobDescription);
  const jdText = typeof jobDescription === 'string' ? jobDescription.toLowerCase() : '';
  if (jdText) {
    const stillOptional = [];
    for (const item of lists.niceToHaveSkills) {
      const needle = item.toLowerCase();
      if (jdText.includes(needle) && !optionalText.includes(needle)) lists.mustHaveSkills.push(item);
      else stillOptional.push(item);
    }
    lists.niceToHaveSkills = stillOptional;
  }

  // 3a. Exact duplicates (normalized), across and within lists.
  const seen = new Set();
  for (const field of DEDUPE_PRIORITY) {
    lists[field] = lists[field].filter((item) => {
      const key = normalizedKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 3b. Interview signals that reword one other requirement.
  const others = ['mustHaveSkills', 'niceToHaveSkills', 'responsibilities', 'qualifications']
    .flatMap((field) => lists[field])
    .map(contentStems);
  lists.interviewSignals = lists.interviewSignals.filter((item) => {
    const stems = contentStems(item);
    return !others.some((otherStems) => {
      const { shared, ratio } = overlap(stems, otherStems);
      return shared >= REWORD_MIN_SHARED && ratio >= REWORD_MIN_RATIO;
    });
  });

  // 3c. Qualifications that only restate listed skills ("Strong understanding
  //     of REST API design, HTTP and security best practices").
  const skillStems = new Set(lists.mustHaveSkills.concat(lists.niceToHaveSkills).flatMap(contentStems));
  lists.qualifications = lists.qualifications.filter((item) => {
    const stems = contentStems(item);
    return !(stems.length > 0 && stems.every((value) => skillStems.has(value)));
  });

  return { role, seniority, yearsExperience, ...lists };
};

module.exports = { refineRequirements, optionalSectionText, contentStems, REQUIREMENT_LIST_FIELDS };
