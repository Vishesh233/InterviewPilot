const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findNamedTools, NAMED_TOOLS } = require('../src/services/namedTools');
const { refineRequirements } = require('../src/services/requirementPostProcessing');

const cases = require(path.join(__dirname, '..', 'scripts', 'cases', 'requirement-quality.json'));
const frontendJd = cases.find((testCase) => testCase.id === 'frontend-react-nextjs').jd;
const backendJd = cases.find((testCase) => testCase.id === 'backend-nodejs').jd;

const names = (text) => findNamedTools(text).map((tool) => tool.name);
const emptyExtraction = (overrides = {}) => ({
  role: null, seniority: null, mustHaveSkills: [], niceToHaveSkills: [],
  responsibilities: [], qualifications: [], interviewSignals: [], ...overrides,
});
const allItems = (result) =>
  ['mustHaveSkills', 'niceToHaveSkills', 'responsibilities', 'qualifications', 'interviewSignals'].flatMap((field) => result[field]);

describe('named tool detection', () => {
  it('finds the tools of the saved Frontend JD case', () => {
    const found = names(frontendJd);
    for (const tool of ['React', 'Next.js', 'TypeScript', 'Jest', 'React Testing Library', 'Playwright', 'WCAG', 'Core Web Vitals', 'Git', 'HTML', 'CSS', 'Tailwind CSS', 'GraphQL', 'JavaScript', 'REST']) {
      assert.ok(found.includes(tool), tool);
    }
  });

  it('finds the tools of the saved Backend JD case', () => {
    const found = names(backendJd);
    for (const tool of ['Node.js', 'Express', 'TypeScript', 'PostgreSQL', 'MongoDB', 'JWT', 'OAuth', 'Redis', 'RabbitMQ', 'Docker', 'AWS', 'Jest', 'Git', 'GraphQL', 'Kubernetes', 'Terraform', 'REST']) {
      assert.ok(found.includes(tool), tool);
    }
    assert.equal(found.includes('WCAG'), false);
  });

  it('maps aliases to the canonical tool', () => {
    assert.deepEqual(names('Unit tests with RTL.'), ['React Testing Library']);
    assert.deepEqual(names('We use Testing Library and track CWV.'), ['React Testing Library', 'Core Web Vitals']);
    assert.deepEqual(names('Data lives in Postgres; deploys go to K8s.'), ['PostgreSQL', 'Kubernetes']);
  });

  it('matches on word boundaries only', () => {
    assert.deepEqual(names('Reactive programming with RxJS streams.'), []);
    assert.deepEqual(names('Strong JavaScript skills.'), ['JavaScript'], 'Java is not found inside JavaScript');
    assert.deepEqual(names('Build with React.'), ['React']);
  });

  it('counts "React Testing Library" once, not also as React', () => {
    assert.deepEqual(names('Tests with React Testing Library.'), ['React Testing Library']);
  });

  it('matches common English words only in their tool capitalization', () => {
    assert.deepEqual(names('Please express your ideas and rest well; we value aria-friendly design talk.'), []);
    // Known limitation: a sentence-initial "Express" is capitalized like the tool.
    assert.deepEqual(names('Express your ideas.'), ['Express']);
    assert.deepEqual(names('APIs with Express and REST.'), ['Express', 'REST']);
  });

  it('keeps the list easy to extend: every entry has a name', () => {
    assert.ok(NAMED_TOOLS.length > 40);
    for (const tool of NAMED_TOOLS) assert.equal(typeof tool.name, 'string');
  });
});

describe('named-tool safety net in requirement post-processing', () => {
  it('adds WCAG and Core Web Vitals for the Frontend case when the model left them inside responsibilities', () => {
    const result = refineRequirements(emptyExtraction({
      mustHaveSkills: ['React', 'TypeScript', 'Next.js', 'JavaScript', 'REST APIs', 'Jest', 'React Testing Library', 'Playwright', 'HTML', 'CSS', 'Git'],
      niceToHaveSkills: ['Tailwind CSS', 'design systems', 'GraphQL'],
      responsibilities: [
        'Meet WCAG 2.1 AA accessibility: semantic HTML, keyboard navigation and screen-reader support',
        'Improve performance: Core Web Vitals, code splitting, image optimization and bundle size',
      ],
    }), { jobDescription: frontendJd });
    assert.ok(result.mustHaveSkills.includes('WCAG'));
    assert.ok(result.mustHaveSkills.includes('Core Web Vitals'));
    assert.equal(result.mustHaveSkills.filter((item) => item === 'React').length, 1, 'no duplicate React');
    assert.equal(allItems(result).includes('REST'), false, '"REST APIs" already stands for REST');
  });

  it('does not add a tool that an existing short requirement already stands for', () => {
    const result = refineRequirements(emptyExtraction({ mustHaveSkills: ['WCAG 2.1 AA', 'OAuth 2.0'] }), {
      jobDescription: 'Responsibilities:\n- Meet WCAG 2.1 AA.\n- Implement OAuth 2.0 login.',
    });
    assert.deepEqual(result.mustHaveSkills, ['WCAG 2.1 AA', 'OAuth 2.0']);
  });

  it('puts a tool named only in a nice-to-have section under nice-to-have', () => {
    const result = refineRequirements(emptyExtraction({ mustHaveSkills: ['React'] }), {
      jobDescription: 'Responsibilities:\n- Build UI in React.\n\nNice to have:\n- Cypress\n- Storybook',
    });
    assert.deepEqual(result.mustHaveSkills, ['React']);
    assert.deepEqual(result.niceToHaveSkills, ['Cypress', 'Storybook']);
  });

  it('makes a tool required when the JD names it outside the nice-to-have section too', () => {
    const result = refineRequirements(emptyExtraction(), {
      jobDescription: 'You will write end-to-end tests with Cypress.\nBonus: Cypress component testing.',
    });
    assert.deepEqual(result.mustHaveSkills, ['Cypress']);
    assert.deepEqual(result.niceToHaveSkills, []);
  });

  it('adds aliases under their canonical name, and never a tool the JD does not name', () => {
    const result = refineRequirements(emptyExtraction(), { jobDescription: 'Write tests with RTL. Our services run on Postgres.' });
    assert.deepEqual(result.mustHaveSkills, ['React Testing Library', 'PostgreSQL']);
    assert.equal(allItems(result).includes('React'), false);
    assert.equal(allItems(result).includes('Jest'), false);
  });

  it('ignores a tool name inside another word', () => {
    const result = refineRequirements(emptyExtraction(), { jobDescription: 'Experience with Reactive Extensions and event sourcing.' });
    assert.deepEqual(allItems(result), []);
  });

  it('is idempotent', () => {
    const once = refineRequirements(emptyExtraction({ mustHaveSkills: ['React'] }), { jobDescription: frontendJd });
    assert.deepEqual(refineRequirements(once, { jobDescription: frontendJd }), once);
  });
});
