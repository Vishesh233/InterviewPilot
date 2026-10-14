// Curated list of well-known technologies, tools and standards, used as a
// deterministic safety net after requirement extraction: a listed tool that the
// job description names but the model did not extract is added back.
//
// To extend: add an entry with the canonical requirement `name` and any
// `aliases` (other spellings that mean the same tool). Matching is
// case-insensitive on word boundaries. Names that are also ordinary English
// words ("express", "rest", "aria", ...) set `caseSensitive: true`, so only
// the tool's own capitalization matches ("Express", "REST"). Known limitation:
// such a word capitalized at the start of a sentence ("Express your ideas")
// still matches.

const NAMED_TOOLS = [
  // Frontend
  { name: 'React', aliases: ['React.js', 'ReactJS'] },
  { name: 'Next.js', aliases: ['NextJS'] },
  { name: 'Vue.js', aliases: ['Vue', 'VueJS'] },
  { name: 'Angular' },
  { name: 'Svelte' },
  { name: 'Redux' },
  { name: 'TypeScript' },
  { name: 'JavaScript' },
  { name: 'HTML', aliases: ['HTML5'] },
  { name: 'CSS', aliases: ['CSS3'] },
  { name: 'Sass', aliases: ['SCSS'] },
  { name: 'Tailwind CSS', aliases: ['Tailwind', 'TailwindCSS'] },
  { name: 'Storybook' },
  // Backend
  { name: 'Node.js', aliases: ['NodeJS'] },
  { name: 'Express', aliases: ['Express.js', 'ExpressJS'], caseSensitive: true },
  { name: 'NestJS' },
  { name: 'Python' },
  { name: 'Django' },
  { name: 'Flask', caseSensitive: true },
  { name: 'FastAPI' },
  { name: 'Java' },
  { name: 'Spring Boot' },
  { name: 'Go', aliases: ['Golang'], caseSensitive: true, matchAliasesOnly: true },
  { name: 'C#', aliases: ['.NET', 'dotnet'] },
  { name: 'Ruby on Rails', aliases: ['Rails'], caseSensitive: true },
  { name: 'REST', aliases: ['RESTful'], caseSensitive: true },
  { name: 'GraphQL' },
  { name: 'gRPC' },
  { name: 'JWT', aliases: ['JSON Web Token', 'JSON Web Tokens'] },
  { name: 'OAuth', aliases: ['OAuth2'] },
  // Testing
  { name: 'Jest' },
  { name: 'Vitest' },
  { name: 'React Testing Library', aliases: ['RTL', 'Testing Library'] },
  { name: 'Playwright' },
  { name: 'Cypress' },
  { name: 'Selenium' },
  { name: 'Mocha' },
  // Version control / CI
  { name: 'Git' },
  { name: 'GitHub Actions' },
  { name: 'Jenkins' },
  // Cloud / infrastructure
  { name: 'Docker' },
  { name: 'Kubernetes', aliases: ['K8s'] },
  { name: 'Terraform' },
  { name: 'AWS', aliases: ['Amazon Web Services'] },
  { name: 'Azure', caseSensitive: true },
  { name: 'Google Cloud', aliases: ['GCP', 'Google Cloud Platform'] },
  // Data
  { name: 'PostgreSQL', aliases: ['Postgres'] },
  { name: 'MySQL' },
  { name: 'MongoDB', aliases: ['Mongo'] },
  { name: 'Redis' },
  { name: 'Elasticsearch' },
  { name: 'Kafka', aliases: ['Apache Kafka'] },
  { name: 'RabbitMQ' },
  { name: 'SQL', caseSensitive: true },
  // Accessibility
  { name: 'WCAG' },
  { name: 'ARIA', aliases: ['WAI-ARIA'], caseSensitive: true },
  // Performance
  { name: 'Core Web Vitals', aliases: ['CWV'] },
  { name: 'Lighthouse', caseSensitive: true },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One pattern per spelling. "Word boundary" means: not glued to another letter
// or digit, so "React" never matches inside "Reactive" and "Java" never inside
// "JavaScript".
const SPELLINGS = NAMED_TOOLS
  .flatMap((tool) => [...(tool.matchAliasesOnly ? [] : [tool.name]), ...(tool.aliases || [])].map((spelling) => ({ tool, spelling })))
  .sort((a, b) => b.spelling.length - a.spelling.length) // longest first: "React Testing Library" before "React"
  .map(({ tool, spelling }) => ({
    tool,
    pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(spelling)}(?![A-Za-z0-9])`, tool.caseSensitive ? 'g' : 'gi'),
  }));

// Scans `text` once: longer spellings are matched first and their text is
// masked, so the shorter "React" inside "React Testing Library" is not counted
// separately. Returns { found: Map(name -> first index), masked }.
const scanNamedTools = (text) => {
  const found = new Map();
  let masked = typeof text === 'string' ? text : '';
  for (const { tool, pattern } of SPELLINGS) {
    masked = masked.replace(pattern, (match, offset) => {
      if (!found.has(tool.name) || found.get(tool.name) > offset) found.set(tool.name, offset);
      return ' '.repeat(match.length);
    });
  }
  return { found, masked };
};

/** Every listed tool named in `text`, in order of first mention: [{ name, index }]. */
const findNamedTools = (text) =>
  [...scanNamedTools(text).found.entries()].map(([name, index]) => ({ name, index })).sort((a, b) => a.index - b.index);

/** `text` with every listed tool spelling blanked out. */
const stripNamedTools = (text) => scanNamedTools(text).masked;

module.exports = { NAMED_TOOLS, findNamedTools, stripNamedTools };
