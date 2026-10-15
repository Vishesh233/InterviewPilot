// Deterministic schedule day titles, from the day's questions: the requirements
// they reference are mapped to topics ("Testing", "Accessibility", ...), and
// the two strongest topics name the day ("Day 2 — Testing & accessibility").
// A question's first topic counts fully and its other topics half, so every
// question's main subject outranks side mentions. Questions without a
// matching requirement fall back to their category.

const TOPICS = [
  ['Testing', /\b(test|testing|jest|playwright|cypress|vitest|mocha|selenium|tdd)\b/i],
  ['Accessibility', /\b(wcag|accessib\w*|aria|screen[- ]reader|keyboard)\b/i],
  ['Performance', /\b(performance|core web vitals|lighthouse|bundle|code splitting|caching|latency|optimi[sz]\w*)\b/i],
  ['APIs', /\b(rest|graphql|api|apis|grpc|endpoint\w*)\b/i],
  ['Next.js', /\bnext\.?js\b/i],
  ['React', /\breact\b/i],
  ['TypeScript', /\btypescript\b/i],
  ['JavaScript', /\bjavascript\b/i],
  ['HTML & CSS', /\b(html|css|tailwind|sass|design systems?)\b/i],
  ['Databases', /\b(sql|postgres\w*|mysql|mongo\w*|redis|database\w*)\b/i],
  ['Cloud & DevOps', /\b(aws|gcp|azure|docker|kubernetes|ci\/?cd|terraform|deploy\w*)\b/i],
  ['Collaboration', /\b(git|code reviews?|collaborat\w*|communicat\w*|stakeholder\w*)\b/i],
];

const CATEGORY_TOPICS = {
  technical: 'Technical depth',
  behavioral: 'Behavioral stories',
  company: 'Company knowledge',
  role_specific: 'Role scenarios',
  resume: 'Your projects',
};

const topicsFor = (question) => {
  const refs = Array.isArray(question?.requirementRefs) ? question.requirementRefs : [];
  const found = [];
  for (const ref of refs) {
    for (const [topic, pattern] of TOPICS) {
      if (typeof ref === 'string' && pattern.test(ref) && !found.includes(topic)) found.push(topic);
    }
  }
  if (found.length > 0) return found;
  const category = CATEGORY_TOPICS[question?.category];
  return category ? [category] : [];
};

// Generic topics are lower-cased after the first word; names keep their case.
const GENERIC_TOPICS = new Set(['Testing', 'Accessibility', 'Performance', 'Databases', 'Collaboration']);

export const dayTopics = (questions) => {
  const scores = new Map();
  for (const question of questions) {
    topicsFor(question).forEach((topic, position) => scores.set(topic, (scores.get(topic) || 0) + (position === 0 ? 1 : 0.5)));
  }
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([topic]) => topic);
  if (top.length === 0) return '';
  const [first, second] = top;
  if (!second) return first;
  const tail = GENERIC_TOPICS.has(second) ? second.toLowerCase() : second;
  // "HTML & CSS" already has an ampersand: "Accessibility, HTML & CSS".
  return first.includes('&') || tail.includes('&') ? `${first}, ${tail}` : `${first} & ${tail}`;
};

export const dayTitle = ({ index, total, questions }) => {
  if (total > 1 && index === total - 1) return 'Final review';
  const topics = dayTopics(questions);
  if (index === 0) return topics ? `Start here — ${topics}` : 'Start here';
  return topics ? `Day ${index + 1} — ${topics}` : `Day ${index + 1}`;
};
