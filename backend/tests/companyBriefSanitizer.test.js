// Company-brief sanitizer regression tests.
//
// The brief was previously the raw extracted text of the first research source,
// which surfaced navigation menus, "read more" fragments, HTML entity remnants
// and duplicated blocks in the UI. These tests pin the deterministic cleaning
// that now happens before the text becomes the displayed Company Brief.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeCompanyBriefText, DEFAULT_MAX_LENGTH } = require('../src/services/companyBriefSanitizer');
const { researchCompany } = require('../src/services/companyResearchService');
const { buildFinalKit } = require('../src/services/interviewPrepPipelineService');
const { validateKitStructure } = require('../src/services/kitStructureValidator');

const expectCode = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
};

const htmlPage = (body) => `<html><head><title>Example</title><script>bad()</script></head><body>${body}</body></html>`;

const response = (body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(body),
  url: 'https://example.com/',
});

// A realistic noisy page: menus, footer chrome, a cookie banner, a duplicated
// paragraph, a "read more" link and encoded entities.
const NOISY_BODY = `
<nav><a href="/">Home</a><a href="/about">About</a><a href="/careers">Careers</a><a href="/blog">Blog</a></nav>
<main>
<h1>Acme</h1>
<p>Acme builds reliable backend infrastructure for engineering teams.</p>
<p>Acme builds reliable backend infrastructure for engineering teams.</p>
<p>Our platform powers payments in 40 countries.</p>
<a href="/pricing">Pricing</a><a href="/more">Read more</a>
</main>
<div>We use cookies to improve your experience. Accept all cookies</div>
<footer>&copy; 2024 Acme Inc. All rights reserved. Privacy Policy | Terms of Use</footer>
`;

const CLEAN_SUMMARY = 'Acme builds reliable backend infrastructure for engineering teams. Our platform powers payments in 40 countries.';

const pipelineResult = (text) => ({
  requirements: {
    role: 'Backend Developer',
    seniority: null,
    mustHaveSkills: ['Node.js'],
    niceToHaveSkills: [],
    responsibilities: [],
    qualifications: [],
    interviewSignals: [],
  },
  research: {
    companyUrl: 'https://example.com/',
    companyTitle: 'Example',
    sources: [{ url: 'https://example.com/', title: 'Example', text }],
  },
  questions: [{
    id: 'q1',
    question: 'Explain Node.js.',
    category: 'technical',
    difficulty: 'medium',
    why: 'Core to the role.',
    expectedAnswerPoints: ['Event loop'],
    followUps: [],
    sources: [],
    requirementRefs: ['Node.js'],
  }],
  coverage: { coveredRequirements: ['Backend Developer', 'Node.js'], missingRequirements: [], coveragePercent: 100 },
  schedule: { interviewDays: 3, days: [{ day: 1, question_ids: ['q1'] }] },
});

const NOISY_TEXT = 'Home About Careers Blog Contact Us | Products Services Pricing | ' +
  'Acme builds reliable backend infrastructure for engineering teams. Read more. ' +
  'Acme builds reliable backend infrastructure for engineering teams.';

describe('sanitizeCompanyBriefText', () => {
  it('removes markup and entity remnants from scraped text', () => {
    const cleaned = sanitizeCompanyBriefText(
      '<div class="hero"><p>Acme&nbsp;builds&nbsp;tools&nbsp;&amp; services.</p></div>'
    );
    assert.equal(cleaned, 'Acme builds tools & services.');
    assert.doesNotMatch(cleaned, /[<>]/);
    assert.doesNotMatch(cleaned, /&[a-z#0-9]{2,};/i);

    assert.equal(sanitizeCompanyBriefText('Acme &#8212; caf&eacute; team.'), 'Acme — café team.');
  });

  it('drops navigation, menu, cookie and "read more" fragments while keeping content', () => {
    assert.equal(
      sanitizeCompanyBriefText(
        'Skip to main content Home About Careers Blog Contact Us | Products Services Pricing | ' +
        'Acme builds reliable backend infrastructure for engineering teams. Read more'
      ),
      'Acme builds reliable backend infrastructure for engineering teams.'
    );
    assert.equal(sanitizeCompanyBriefText(NOISY_TEXT), 'Acme builds reliable backend infrastructure for engineering teams.');
    // Dash-separated menus are chrome; dashes inside prose are not.
    assert.equal(sanitizeCompanyBriefText('Home – About – Careers – Products – Contact'), '');
    assert.equal(sanitizeCompanyBriefText('Acme — a Berlin company — builds tools.'), 'Acme — a Berlin company — builds tools.');
    // Glued menu prefixes are removed; real sentences that merely use menu-ish
    // words are preserved.
    assert.equal(
      sanitizeCompanyBriefText(
        'Home About Careers Blog Contact Us Products Services Pricing Acme builds reliable backend infrastructure for engineering teams.'
      ),
      'Acme builds reliable backend infrastructure for engineering teams.'
    );
    assert.equal(
      sanitizeCompanyBriefText('We offer our products and services.'),
      'We offer our products and services.'
    );
    // A heading glued to the paragraph under it is not repeated.
    assert.equal(
      sanitizeCompanyBriefText('Acme Acme builds reliable backend infrastructure for engineering teams.'),
      'Acme builds reliable backend infrastructure for engineering teams.'
    );
  });

  it('removes duplicated blocks and keeps distinct sentences', () => {
    assert.equal(
      sanitizeCompanyBriefText(
        'Acme builds developer tools. Acme builds developer tools. Acme builds developer tools for data teams. Contact Us Contact Us'
      ),
      'Acme builds developer tools. Acme builds developer tools for data teams.'
    );
  });

  it('returns an empty brief instead of navigation leftovers', () => {
    assert.equal(sanitizeCompanyBriefText('<nav>Home</nav><nav>About</nav><footer>Privacy Policy Terms of Use</footer>'), '');
    assert.equal(sanitizeCompanyBriefText('Home | About | Careers | Contact Us | Products | Services'), '');
    assert.equal(sanitizeCompanyBriefText('Read more'), '');
    assert.equal(sanitizeCompanyBriefText('© 2024'), '');
    assert.equal(sanitizeCompanyBriefText(''), '');
    assert.equal(sanitizeCompanyBriefText('   '), '');
    assert.equal(sanitizeCompanyBriefText(null), '');
    assert.equal(sanitizeCompanyBriefText(undefined), '');
    assert.equal(sanitizeCompanyBriefText({ text: 'Acme' }), '');
  });

  it('keeps meaningful sentences and source URLs intact', () => {
    const text = 'Acme publishes its engineering blog at https://acme.example.com/blog for candidates. Founded in 2011.';
    assert.equal(sanitizeCompanyBriefText(text), text);
  });

  it('bounds the brief length without cutting mid-word', () => {
    const long = Array.from(
      { length: 120 },
      (_, index) => `Acme engineering note number ${index} covers reliable backend delivery for team ${index}.`
    ).join(' ');
    const bounded = sanitizeCompanyBriefText(long, { maxLength: 400 });
    assert.ok(bounded.length <= 400, bounded.length);
    assert.equal(bounded.endsWith('.'), true);
    assert.match(bounded, /team \d+\.$/);
    assert.ok(sanitizeCompanyBriefText(long).length <= DEFAULT_MAX_LENGTH);
    assert.ok(sanitizeCompanyBriefText(long).length > 400);
  });

  it('is idempotent', () => {
    const once = sanitizeCompanyBriefText(NOISY_TEXT);
    assert.equal(sanitizeCompanyBriefText(once), once);
  });
});

describe('company brief integration', () => {
  const build = (text) =>
    buildFinalKit(
      { jobDescription: 'Backend role.', companyUrl: 'https://example.com/', interviewDays: 3 },
      pipelineResult(text)
    );

  it('returns clean, deduplicated research text for a noisy company page', async () => {
    const result = await researchCompany({
      companyUrl: 'https://example.com/',
      fetchImpl: async () => response(htmlPage(NOISY_BODY)),
    });
    assert.equal(result.title, 'Example');
    assert.equal(result.text, CLEAN_SUMMARY);
    for (const noise of ['Home', 'Careers', 'Blog', 'Pricing', 'Read more', 'cookies', 'All rights reserved', '©', '<', '&', 'Accept all']) {
      assert.equal(result.text.includes(noise), false, `"${noise}" leaked into: ${result.text}`);
    }
  });

  it('keeps failing thin or chrome-only pages through the existing fallback', async () => {
    await expectCode(
      () =>
        researchCompany({
          companyUrl: 'https://example.com/',
          fetchImpl: async () =>
            response(htmlPage('<nav><a href="/">Home</a><a href="/careers">Careers</a><a href="/blog">Blog</a></nav>')),
        }),
      'RESEARCH_NO_READABLE_TEXT'
    );
    await expectCode(
      () =>
        researchCompany({
          companyUrl: 'https://example.com/',
          fetchImpl: async () => response(htmlPage('<main>Small shop.</main>')),
        }),
      'RESEARCH_INSUFFICIENT_TEXT'
    );
  });

  it('sanitizes the displayed brief even when a caller supplies noisy research text', () => {
    const kit = build(
      'Home About Careers Blog Contact Us. Acme builds reliable backend infrastructure for engineering teams. Read more'
    );
    assert.equal(kit.company_brief.name, 'Example');
    assert.equal(kit.company_brief.summary, 'Acme builds reliable backend infrastructure for engineering teams.');
    assert.deepEqual(kit.company_brief.sources, [{ url: 'https://example.com/', title: 'Example' }]);
    const validation = validateKitStructure(kit);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });

  it('falls back to the existing source note when the research text is pure chrome', () => {
    const kit = build('Home | About | Careers | Contact Us');
    assert.equal(kit.company_brief.summary, 'Research collected from https://example.com/.');
  });

  it('keeps genuine sentences and drops only the repeated block', () => {
    const kit = build(
      'Acme is headquartered in Berlin. Acme is headquartered in Berlin. Its engineering blog is at https://acme.example.com/blog.'
    );
    assert.equal(
      kit.company_brief.summary,
      'Acme is headquartered in Berlin. Its engineering blog is at https://acme.example.com/blog.'
    );
  });
});


