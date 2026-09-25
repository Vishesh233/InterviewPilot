// Company research orchestration service.
// Flow: fetch homepage -> discover relevant links -> select a few
//       -> fetch them -> collect sources.
// No LLM, no routes, no invented URLs — only links discovered from the homepage.

const { researchCompany } = require('./companyResearchService');
const { discoverRelevantLinks } = require('./companyLinkDiscoveryService');

const MAX_ADDITIONAL_PAGES = 3;
const RELEVANT_CATEGORIES = ['careers', 'jobs', 'hiring', 'interview'];

// Pick up to `limit` links, taking one from each relevant category per pass so
// the selection is spread across careers/jobs/hiring/interview.
const selectLinks = (buckets, limit) => {
  const queues = RELEVANT_CATEGORIES.map((category) =>
    (buckets[category] || []).map((link) => ({ url: link.url, category }))
  );
  const selected = [];
  while (selected.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (selected.length >= limit) break;
      const next = queue.shift();
      if (next) selected.push(next);
    }
  }
  return selected;
};

const researchCompanyPipeline = async ({ companyUrl, batchFixtureContext } = {}, deps = {}) => {
  const fetchResearchPage = deps.researchCompany || researchCompany;
  // 1. Fetch the initial company page (a failure here fails the pipeline —
  //    there is nothing to research without the homepage).
  const home = await fetchResearchPage({ companyUrl, batchFixtureContext, includeHtml: true });

  // 2-3. Discover relevant links from the homepage HTML and select a limited set.
  //      If discovery cannot run, continue with the homepage as the only source.
  let selected = [];
  try {
    const buckets = discoverRelevantLinks({ html: home.html, baseUrl: home.companyUrl });
    const homeNormalized = new URL(home.companyUrl).href;
    selected = selectLinks(buckets, MAX_ADDITIONAL_PAGES)
      .filter((link) => link.url !== homeNormalized); // never repeat the homepage
  } catch (error) {
    // Discovery is best-effort — the homepage source below is already secured.
  }

  // The homepage is always the first source.
  const sources = [
    { url: home.companyUrl, title: home.title, text: home.text, category: 'homepage' },
  ];

  // 4. Fetch the selected discovered pages; skip any that fail so one broken
  //    link never fails the entire pipeline.
  for (const link of selected) {
    try {
      const page = await fetchResearchPage({ companyUrl: link.url, batchFixtureContext });
      sources.push({
        url: page.companyUrl,
        title: page.title,
        text: page.text,
        category: link.category,
      });
    } catch (error) {
      // Continue with the remaining pages.
    }
  }

  // 5. Return the collected sources
  return {
    companyUrl: home.companyUrl,
    companyTitle: home.title,
    sources,
  };
};

module.exports = { researchCompanyPipeline };
