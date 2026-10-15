// A fixed, valid company brief for pipeline tests: the brief stage never
// reaches a model provider in tests.
const MOCK_COMPANY_BRIEF = Object.freeze({
  about: 'Example builds developer tools that help engineering teams ship web applications. Its products cover hosting, previews and performance monitoring for frontend projects.',
  offerings: ['Hosting for web applications', 'Preview deployments for every change'],
  roleRelevance: ['The role builds the frontend features those developer tools rely on.'],
  generated: true,
});

const mockGenerateCompanyBrief = async () => ({
  ...MOCK_COMPANY_BRIEF,
  offerings: [...MOCK_COMPANY_BRIEF.offerings],
  roleRelevance: [...MOCK_COMPANY_BRIEF.roleRelevance],
});

module.exports = { MOCK_COMPANY_BRIEF, mockGenerateCompanyBrief };
