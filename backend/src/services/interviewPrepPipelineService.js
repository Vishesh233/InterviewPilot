// Core interview-prep pipeline: orchestrates the existing services in order and
// returns the final pipeline data. All logic lives in the individual services —
// this file only sequences them, validates inputs, labels stage failures, and
// exposes a validator-compatible adapter for those same stage outputs.

const { extractRequirements } = require('./requirementExtractionService');
const { researchCompanyPipeline } = require('./companyResearchPipelineService');
const { generateQuestions } = require('./questionGenerationService');
const { checkCoverage } = require('./coverageService');
const { fillCoverageGaps } = require('./gapFillService');
const { createSchedule } = require('./scheduleService');
const { analyzeResumeMatch } = require('./resumeMatchService');
const { generateResumeQuestions } = require('./resumeQuestionService');
const { toResumeMetadata } = require('./resumeInputService');
// MAX_RESUME_TEXT_LENGTH is the single source of truth for the resume length
// limit. It is imported (never re-declared) so the pipeline can never enforce a
// different bound than the one resumeTextExtractor/resumeInputService already
// applied at the API boundary.
const { MAX_RESUME_TEXT_LENGTH } = require('./resumeTextExtractor');
const { assertSafeUrl } = require('./urlSecurityService');
const { BATCH_FIXTURE_CONTEXT } = require('./batchFixtureContext');
const { sanitizeCompanyBriefText } = require('./companyBriefSanitizer');
const { runCheckpointedStage } = require('./stageCheckpoint');

// Stage names, in order. They are the checkpoint keys of a background job, so
// renaming one invalidates the checkpoints of jobs that are still unfinished.
const KIT_PIPELINE_STAGES = Object.freeze({
  EXTRACTION: 'Requirement extraction',
  RESEARCH: 'Company research',
  GENERATION: 'Question generation',
  COVERAGE: 'Coverage check',
  GAP_FILL: 'Coverage gap filling',
  FINAL_COVERAGE: 'Final coverage check',
  RESUME_ANALYSIS: 'Resume gap analysis',
  RESUME_QUESTIONS: 'Resume question generation',
  SCHEDULE: 'Interview scheduling',
});

const MIN_INTERVIEW_DAYS = 1;
const MAX_INTERVIEW_DAYS = 60;
const {
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_JOB_ROLE_LENGTH,
  isBoundedString,
  isPlainObject,
} = require('./inputValidationService');

const validateInputs = ({ jobRole, jobDescription, companyUrl, interviewDays, batchFixtureContext, resumeText } = {}) => {
  // jobRole is optional at this boundary so the evaluate CLI keeps working;
  // the HTTP API enforces it as required. When supplied it must be valid.
  if (jobRole !== undefined && !isBoundedString(jobRole, MAX_JOB_ROLE_LENGTH)) {
    throw new Error(`jobRole must be a non-empty string no longer than ${MAX_JOB_ROLE_LENGTH} characters.`);
  }
  if (!isBoundedString(jobDescription, MAX_JOB_DESCRIPTION_LENGTH)) {
    throw new Error(`jobDescription must be a non-empty string no longer than ${MAX_JOB_DESCRIPTION_LENGTH} characters.`);
  }
  if (jobDescription.includes('\u0000')) {
    throw new Error('jobDescription contains an invalid null character.');
  }
  // resumeText is optional: when absent the pipeline is exactly the JD-only flow.
  // It is bounded by MAX_RESUME_TEXT_LENGTH — the same constant the API boundary
  // already applied in resumeTextExtractor. It deliberately does NOT reuse
  // MAX_TEXT_LENGTH: that is the generic per-field text cap (20_000) and using it
  // here rejected every resume between 20_001 and MAX_RESUME_TEXT_LENGTH with a
  // bare Error, surfacing as a generic HTTP 500 before the LLM was ever reached.
  if (resumeText !== undefined && !isBoundedString(resumeText, MAX_RESUME_TEXT_LENGTH)) {
    throw new Error(`resumeText must be a non-empty string no longer than ${MAX_RESUME_TEXT_LENGTH} characters.`);
  }
  try {
    assertSafeUrl(companyUrl, { batchFixtureContext });
  } catch (error) {
    throw new Error(error.message || 'companyUrl must be a valid public HTTP/HTTPS URL.');
  }
  if (
    !Number.isInteger(interviewDays) ||
    interviewDays < MIN_INTERVIEW_DAYS ||
    interviewDays > MAX_INTERVIEW_DAYS
  ) {
    throw new Error(
      `interviewDays must be an integer between ${MIN_INTERVIEW_DAYS} and ${MAX_INTERVIEW_DAYS}.`
    );
  }
};

// Run one stage and re-throw with the stage name so callers know what failed.
class PipelineError extends Error {
  constructor(stage, cause) {
    const isPublic = cause?.isPublic === true;
    const code = isPublic && typeof cause.code === 'string' ? cause.code : 'PIPELINE_STAGE_FAILED';
    const message = isPublic && typeof cause.message === 'string'
      ? `${stage} failed: ${cause.message}`
      : `${stage} failed.`;
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.stage = stage;
    this.status = isPublic && Number.isInteger(cause.status) ? cause.status : 500;
    this.isPublic = true;
  }
}

const runStage = async (stage, action) => {
  try {
    return await action();
  } catch (error) {
    throw new PipelineError(stage, error);
  }
};

const normalizeTitle = (value, fallback) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const safeText = (value, fallback) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const hasExtractedRequirements = (requirements) => {
  const listFields = [
    'mustHaveSkills',
    'niceToHaveSkills',
    'responsibilities',
    'qualifications',
    'interviewSignals',
  ];
  return [requirements.role, requirements.seniority].some((value) => typeof value === 'string' && value.trim()) ||
    listFields.some((field) => Array.isArray(requirements[field]) && requirements[field].some((value) => typeof value === 'string' && value.trim()));
};

const pipelineValidationError = (stage, code, message, status = 422) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isPublic = true;
  return new PipelineError(stage, error);
};

const uniqueRequirementIds = (requirements) =>
  [
    requirements.role,
    requirements.seniority,
    ...(Array.isArray(requirements.mustHaveSkills) ? requirements.mustHaveSkills : []),
    ...(Array.isArray(requirements.niceToHaveSkills) ? requirements.niceToHaveSkills : []),
    ...(Array.isArray(requirements.responsibilities) ? requirements.responsibilities : []),
    ...(Array.isArray(requirements.qualifications) ? requirements.qualifications : []),
    ...(Array.isArray(requirements.interviewSignals) ? requirements.interviewSignals : []),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index);

const buildFinalKit = ({ jobRole, jobDescription, companyUrl, interviewDays }, pipelineResult) => {
  const { requirements, research, questions, coverage, schedule, resume, resume_analysis } = pipelineResult || {};
  if (!isPlainObject(requirements) || !isPlainObject(research) || !Array.isArray(research.sources)) {
    throw new Error('Pipeline returned malformed requirements or research data.');
  }
  if (!Array.isArray(questions) || !isPlainObject(coverage) || !isPlainObject(schedule)) {
    throw new Error('Pipeline returned malformed questions, coverage, or schedule data.');
  }
  if (!Array.isArray(research.sources) || research.sources.length === 0) {
    throw new Error('Pipeline returned no company research sources.');
  }
  for (const source of research.sources) {
    if (!isPlainObject(source) || typeof source.url !== 'string' || !source.url.trim()) {
      throw new Error('Pipeline returned a malformed company research source.');
    }
  }
  if (typeof research.companyUrl !== 'string' || !research.companyUrl.trim()) {
    throw new Error('Pipeline returned a malformed company research URL.');
  }
  const roleTitle = normalizeTitle(requirements.role, 'Role not specified');
  const firstSourceText = research.sources.find((source) => source.text)?.text;
  const sourceUrl = research.companyUrl;
  const companyName = normalizeTitle(research.companyTitle, new URL(sourceUrl).hostname || roleTitle);
  const companySummary = safeText(
    sanitizeCompanyBriefText(firstSourceText),
    `Research collected from ${sourceUrl}.`
  );

  return {
    source: {
      ...(typeof jobRole === 'string' && jobRole.trim() ? { jobRole: jobRole.trim() } : {}),
      jobDescription,
      companyUrl,
      interviewDays,
    },
    company_brief: {
      name: companyName,
      summary: companySummary,
      sources: research.sources.map(({ url, title }) => ({ url, title })),
    },
    role: {
      title: roleTitle,
      ...(normalizeTitle(requirements.seniority, '') ? { level: requirements.seniority.trim() } : {}),
      requirements: uniqueRequirementIds(requirements).map((id) => ({ id })),
    },
    questions,
    flashcards: questions.map((question, index) => ({
      id: `f${index + 1}`,
      front: question.question,
      back: [...question.expectedAnswerPoints, ...question.followUps].join('\n') || question.why,
      questionIds: [question.id],
    })),
    schedule,
    coverage,
    // Additive and optional: present only when a resume was supplied, so the
    // JD-only response shape is unchanged.
    ...(isPlainObject(resume) ? { resume } : {}),
    ...(isPlainObject(resume_analysis) ? { resume_analysis } : {}),
  };
};

/**
 * Build the full interview-prep kit while preserving the established API response.
 * `buildFinalKit` adapts the untouched stage outputs for consumers that require
 * the existing kit validator shape.
 *
 * `context` is optional ({ onStage, checkpoints, saveCheckpoint }, see
 * stageCheckpoint.js). Without it every stage runs, exactly as before.
 */
const generateInterviewPrepKit = async (input = {}, deps = {}, context = undefined) => {
  const { jobRole, jobDescription, companyUrl, interviewDays } = input;
  // Optional, already validated resume payload ({ text, fileName, fileType,
  // charCount }) normalized by resumeInputService. Absent => pure JD-only flow.
  const resumeInput = input.resume && typeof input.resume === 'object' && !Array.isArray(input.resume) ? input.resume : null;
  const resumeText = typeof resumeInput?.text === 'string' && resumeInput.text.trim() ? resumeInput.text : undefined;
  const batchFixtureContext = input[BATCH_FIXTURE_CONTEXT];
  validateInputs({ jobRole, jobDescription, companyUrl, interviewDays, batchFixtureContext, resumeText });

  const extract = deps.extractRequirements || extractRequirements;
  const researchStage = deps.researchCompanyPipeline || researchCompanyPipeline;
  const generate = deps.generateQuestions || generateQuestions;
  const fillGaps = deps.fillCoverageGaps || fillCoverageGaps;
  const analyzeResume = deps.analyzeResumeMatch || analyzeResumeMatch;
  const generateResumeQuestionSet = deps.generateResumeQuestions || generateResumeQuestions;

  const S = KIT_PIPELINE_STAGES;
  const stage = (name, isValid, run) => runCheckpointedStage(context, name, { isValid, run });
  const hasQuestionList = (value) => isPlainObject(value) && Array.isArray(value.questions);

  // 1. Extract structured requirements from the job description. The gate runs
  //    inside the stage so an insufficient extraction is never checkpointed.
  const extracted = await stage(S.EXTRACTION, (value) => isPlainObject(value) && hasExtractedRequirements(value), async () => {
    const output = await runStage(S.EXTRACTION, () => extract({ jobDescription }));
    if (!isPlainObject(output) || !hasExtractedRequirements(output)) {
      throw pipelineValidationError(
        S.EXTRACTION,
        'INSUFFICIENT_JOB_DESCRIPTION',
        'The job description did not provide enough supported information.'
      );
    }
    return output;
  });

  // 1b. The caller-supplied job role is the canonical target role for every
  //     later stage: the question prompt, deterministic coverage, gap filling,
  //     and the final role.requirements list all read requirements.role.
  //     It is applied only AFTER the gate above so a thin JD cannot be masked
  //     by a valid role, and the extracted object is copied rather than mutated
  //     because extraction stubs/fixtures may be shared between calls.
  const canonicalRole = typeof jobRole === 'string' && jobRole.trim() ? jobRole.trim() : '';
  const requirements = canonicalRole ? { ...extracted, role: canonicalRole } : extracted;

  // 2. Research the public company page (homepage + a few relevant pages).
  const research = await stage(S.RESEARCH, (value) => isPlainObject(value) && Array.isArray(value.sources), () =>
    runStage(S.RESEARCH, () => researchStage({ companyUrl, batchFixtureContext }))
  );

  // 3. Generate the initial questions from requirements + research.
  const generated = await stage(S.GENERATION, hasQuestionList, () =>
    runStage(S.GENERATION, () => generate({ requirements, research }))
  );

  // 4. Deterministic coverage check on the initial questions.
  const initialCoverage = await stage(S.COVERAGE, isPlainObject, () =>
    runStage(S.COVERAGE, () => checkCoverage({ requirements, questions: generated.questions }))
  );

  // 5-6. Fill the gaps, then keep the coverage reported by gap filling. An
  //      empty question list fails the stage, so it is never checkpointed.
  const gapFilled = await stage(S.GAP_FILL, (value) => hasQuestionList(value) && value.questions.length > 0, async () => {
    const output = await runStage(S.GAP_FILL, () =>
      fillGaps({
        requirements,
        research,
        questions: generated.questions,
        coverage: initialCoverage,
      })
    );
    if (!Array.isArray(output?.questions) || output.questions.length === 0) {
      throw pipelineValidationError(
        S.GENERATION,
        'NO_QUESTIONS_GENERATED',
        'No usable interview questions were generated.',
        502
      );
    }
    return output;
  });
  const questions = gapFilled.questions;

  // 7. Re-check coverage on the final question list so the returned coverage is
  //    derived from the questions that are actually in the kit.
  const coverage = await stage(S.FINAL_COVERAGE, isPlainObject, () =>
    runStage(S.FINAL_COVERAGE, () => checkCoverage({ requirements, questions }))
  );

  // 8. Optional resume stage. It runs AFTER the deterministic coverage check on
  //    purpose: requirement coverage keeps being computed from the JD-generated and
  //    gap-filled questions only, so appending resume questions can never hide a
  //    coverage gap. Resume questions are appended (never substituted) and then
  //    flow into the same schedule/flashcards stages as every other question.
  let resumeAnalysis;
  let finalQuestions = questions;
  if (resumeText) {
    resumeAnalysis = await stage(S.RESUME_ANALYSIS, isPlainObject, () =>
      runStage(S.RESUME_ANALYSIS, () => analyzeResume({ resumeText, requirements }))
    );
    const resumeQuestionSet = await stage(S.RESUME_QUESTIONS, isPlainObject, () =>
      runStage(S.RESUME_QUESTIONS, () =>
        generateResumeQuestionSet({
          resumeText,
          requirements,
          research,
          startIndex: questions.length,
        })
      )
    );
    const resumeQuestions = Array.isArray(resumeQuestionSet?.questions) ? resumeQuestionSet.questions : [];
    resumeAnalysis = {
      ...resumeAnalysis,
      projects: Array.isArray(resumeQuestionSet?.projects) ? resumeQuestionSet.projects : [],
    };
    if (resumeQuestions.length > 0) {
      finalQuestions = [...questions, ...resumeQuestions];
    }
  }

  // 9. Deterministic interview schedule built from the final question ids.
  const schedule = await stage(S.SCHEDULE, isPlainObject, () =>
    runStage(S.SCHEDULE, () => createSchedule({ questions: finalQuestions, interviewDays }))
  );

  // 10. Preserve the established production API response exactly; the resume
  //     fields below are additive and only present for a resume-enabled request.
  //     The exported buildFinalKit adapter derives the validator shape from these
  //     same values.
  const resumeMetadata = resumeText ? toResumeMetadata({ ...resumeInput, text: resumeText }) : null;
  return {
    requirements,
    research,
    questions: finalQuestions,
    coverage,
    schedule,
    ...(resumeMetadata ? { resume: resumeMetadata } : {}),
    ...(resumeAnalysis ? { resume_analysis: resumeAnalysis } : {}),
  };
};

module.exports = { generateInterviewPrepKit, buildFinalKit, PipelineError, KIT_PIPELINE_STAGES };
