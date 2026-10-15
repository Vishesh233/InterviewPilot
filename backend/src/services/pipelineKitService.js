// Turns a finished pipeline result into the stored kit and prepares any kit for
// storage. A background kit job saves the kit itself, so this builds exactly
// the kit the browser used to build from the pipeline response and send to
// POST /api/kits, and runs the same checks POST /api/kits runs.

const kitBuilderService = require('./kitBuilderService');
const practiceService = require('./practiceService');
const { validateKitStructure } = require('./kitStructureValidator');
const { assertSafeUrl } = require('./urlSecurityService');
const { companyBriefFields } = require('./companyBriefService');
const { companyNameFromResearch } = require('./companyName');

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

const kitFromPipeline = (input, result) => {
  const requirements = result?.requirements || {};
  const research = result?.research || {};
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  // The supplied job role is canonical; the extracted role is only a fallback.
  const canonicalRole = nonEmpty(input.jobRole)
    ? input.jobRole.trim()
    : nonEmpty(requirements.role)
      ? requirements.role.trim()
      : '';
  const roleTitle = canonicalRole || 'Role not specified';
  const listOf = (field, kind) =>
    (Array.isArray(requirements[field]) ? requirements[field] : []).map((id) => ({ id, kind }));
  const requirementEntries = [
    ...listOf('mustHaveSkills', 'must_have'),
    ...listOf('niceToHaveSkills', 'nice_to_have'),
    ...listOf('responsibilities', 'responsibility'),
    ...listOf('qualifications', 'qualification'),
    ...listOf('interviewSignals', 'interview_signal'),
  ];
  // The job title, seniority and years of experience are role metadata
  // (role.title / role.level / role.yearsExperience), never requirements.
  const seenRequirementIds = new Set();
  const dedupedRequirementEntries = requirementEntries.filter((entry) => {
    if (seenRequirementIds.has(entry.id)) return false;
    seenRequirementIds.add(entry.id);
    return true;
  });
  const sources = Array.isArray(research.sources) ? research.sources.filter((source) => nonEmpty(source?.url)) : [];
  const companyUrl = input.companyUrl.trim();
  return {
    source: {
      ...(nonEmpty(input.jobRole) ? { jobRole: input.jobRole.trim() } : {}),
      jobDescription: input.jobDescription.trim(),
      companyUrl,
      interviewDays: input.interviewDays,
    },
    company_brief: {
      // Same brief as the evaluation path (buildFinalKit).
      ...companyBriefFields({ companyName: companyNameFromResearch(research, companyUrl), companyBrief: result?.companyBrief, research }),
      sources: sources.map(({ url, title }) => ({ url, title: nonEmpty(title) ? title : '' })),
    },
    role: {
      title: roleTitle,
      ...(nonEmpty(requirements.seniority) ? { level: requirements.seniority.trim() } : {}),
      ...(nonEmpty(requirements.yearsExperience) ? { yearsExperience: requirements.yearsExperience.trim() } : {}),
      requirements: dedupedRequirementEntries,
    },
    questions,
    flashcards: questions.map((question, index) => ({
      id: `f${index + 1}`,
      front: question.question,
      back: [...(question.expectedAnswerPoints || []), ...(question.followUps || [])].join('\n') || question.why,
      questionIds: [question.id],
    })),
    schedule: result.schedule,
    coverage: result.coverage,
    // Additive: present only when the generation request carried a resume.
    ...(result.resume && result.resume.provided === true ? { resume: result.resume } : {}),
    ...(result.resume_analysis ? { resume_analysis: result.resume_analysis } : {}),
  };
};

const assertPublicKitUrls = (kit) => {
  const urls = [
    ['$.source.companyUrl', kit.source?.companyUrl],
    ...(Array.isArray(kit.company_brief?.sources)
      ? kit.company_brief.sources.map((source, index) => [`$.company_brief.sources[${index}].url`, source?.url])
      : []),
  ];
  for (const [path, value] of urls) {
    if (typeof value !== 'string') continue;
    try {
      assertSafeUrl(value);
    } catch (error) {
      return { path, code: 'URL_NOT_ALLOWED' };
    }
  }
  return null;
};

// Builder metadata + practice defaults, then the structure validator and the
// public-URL check: the same gate POST /api/kits applies.
// Returns { kit } or { errors }.
const prepareKitForStorage = (rawKit) => {
  const kit = practiceService.applyKitPracticeDefaults(kitBuilderService.applyKitQuestionMetadata(rawKit));
  const result = validateKitStructure(kit);
  if (!result.valid) return { errors: result.errors };
  const urlError = assertPublicKitUrls(kit);
  if (urlError) return { errors: [urlError] };
  return { kit };
};

module.exports = { kitFromPipeline, prepareKitForStorage, assertPublicKitUrls };
