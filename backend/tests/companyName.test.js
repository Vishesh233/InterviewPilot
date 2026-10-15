const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { deriveCompanyName, cleanStoredCompanyName, companyNameFromResearch, brandTokenFor } = require('../src/services/companyName');
const { extractSiteNames } = require('../src/services/companyResearchService');

describe('company name derivation', () => {
  it("uses og:site_name first (Vercel's real homepage head)", () => {
    // <title>Agentic Infrastructure - Vercel</title>, <meta property="og:site_name" content="Vercel"/>
    const html = '<head><title>Agentic Infrastructure - Vercel</title><meta property="og:site_name" content="Vercel"/></head>';
    const names = extractSiteNames(html);
    assert.equal(names.siteName, 'Vercel');
    assert.equal(deriveCompanyName({ ...names, title: 'Agentic Infrastructure - Vercel', url: 'https://vercel.com/' }), 'Vercel');
  });

  it("takes the title segment matching the domain when there is no site name (Vercel's title alone)", () => {
    assert.equal(deriveCompanyName({ title: 'Agentic Infrastructure - Vercel', url: 'https://vercel.com/' }), 'Vercel');
  });

  it('handles "Careers | Stripe"', () => {
    assert.equal(deriveCompanyName({ title: 'Careers | Stripe', url: 'https://stripe.com/jobs' }), 'Stripe');
  });

  it('prefers a site with og:site_name over its title and domain', () => {
    assert.equal(
      deriveCompanyName({ siteName: 'Acme Robotics', title: 'Home — Acme', url: 'https://www.acme-robotics.io/' }),
      'Acme Robotics'
    );
  });

  it('uses application-name when there is no og:site_name', () => {
    const names = extractSiteNames('<meta name="application-name" content="Linear">');
    assert.deepEqual(names, { siteName: null, applicationName: 'Linear' });
    assert.equal(deriveCompanyName({ ...names, title: 'Plan and build products', url: 'https://linear.app/' }), 'Linear');
  });

  it('falls back to the title-cased domain for a site with no metadata', () => {
    assert.equal(deriveCompanyName({ title: null, url: 'https://vercel.com/' }), 'Vercel');
    assert.equal(deriveCompanyName({ title: 'Welcome to our homepage', url: 'https://www.acme-robotics.co.uk/about' }), 'Acme Robotics');
    assert.equal(brandTokenFor('https://careers.example.co.uk/'), 'example');
  });

  it('ignores an over-long site name and keeps going down the order', () => {
    const siteName = 'The most complete platform for building and shipping modern web applications at scale';
    assert.equal(deriveCompanyName({ siteName, title: 'Careers | Stripe', url: 'https://stripe.com/' }), 'Stripe');
  });

  it('reads the derived name from research, or derives it for an older research checkpoint', () => {
    assert.equal(companyNameFromResearch({ companyName: 'Vercel', companyTitle: 'x' }), 'Vercel');
    assert.equal(companyNameFromResearch({ companyTitle: 'Agentic Infrastructure - Vercel', companyUrl: 'https://vercel.com/' }), 'Vercel');
  });
});

describe('stored company names on read', () => {
  it('shortens a stored multi-part title to the segment naming the kit domain', () => {
    assert.equal(cleanStoredCompanyName('Agentic Infrastructure - Vercel', 'https://vercel.com/'), 'Vercel');
  });

  it('keeps any other stored name unchanged', () => {
    assert.equal(cleanStoredCompanyName('Vercel', 'https://vercel.com/'), 'Vercel');
    assert.equal(cleanStoredCompanyName('Meta', 'https://facebook.com/'), 'Meta');
    assert.equal(cleanStoredCompanyName('Home - Welcome', 'https://acme.com/'), 'Home - Welcome');
    assert.equal(cleanStoredCompanyName(undefined, 'https://acme.com/'), undefined);
  });
});
