const {
  generateInterviewPrepKit,
} = require('../services/interviewPrepPipelineService');
const { assertSafeUrl } = require('../services/urlSecurityService');
const { MAX_JOB_DESCRIPTION_LENGTH, isBoundedString, isPlainSafeObject, hasUnsafeKeys } = require('../services/inputValidationService');

const MAX_INTERVIEW_DAYS = 60;

const isValidCompanyUrl = (value) => {
  if (typeof value !== 'string' || !isBoundedString(value, 2048)) return false;
  try {
    assertSafeUrl(value);
    return true;
  } catch (error) {
    return false;
  }
};

// POST /api/interview-prep
const generateInterviewPrep = async (req, res, deps = {}) => {
  const generate = deps.generateInterviewPrepKit || generateInterviewPrepKit;
  if (!isPlainSafeObject(req.body) || hasUnsafeKeys(req.body)) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body must be a safe JSON object.',
      },
    });
  }

  const { jobDescription, companyUrl, interviewDays } = req.body;

  if (
    !isBoundedString(jobDescription, MAX_JOB_DESCRIPTION_LENGTH) ||
    !isValidCompanyUrl(companyUrl) ||
    !Number.isInteger(interviewDays) ||
    interviewDays < 1 ||
    interviewDays > MAX_INTERVIEW_DAYS
  ) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'jobDescription must be a non-empty string, companyUrl must be a valid HTTP/HTTPS URL, and interviewDays must be an integer between 1 and 60.',
      },
    });
  }

  try {
    const kit = await generate({
      jobDescription,
      companyUrl,
      interviewDays,
    });

    return res.status(200).json(kit);
  } catch (error) {
    if (error?.code === 'KIT_VALIDATION_FAILED') return res.status(400).json({
      error: { code: 'KIT_VALIDATION_FAILED', message: 'Interview-prep kit failed structure validation.' },
    });
    console.error('Interview-prep generation failed.', {
      name: error?.name,
      code: error?.code,
      status: error?.status,
    });

    const status = [422, 429, 502, 504].includes(error?.status) ? error.status : 500;
    return res.status(status).json({
      error: {
        code: status === 422
          ? 'INTERVIEW_PREP_INSUFFICIENT_INPUT'
          : status === 429
            ? 'INTERVIEW_PREP_RATE_LIMITED'
            : 'INTERVIEW_PREP_GENERATION_FAILED',
        message:
          status === 422
            ? 'The job description did not provide enough supported information.'
            : status === 429
              ? 'The interview-prep service is busy. Please try again later.'
              : 'Unable to generate the interview-prep kit. Please try again later.',
      },
    });
  }
};

module.exports = { generateInterviewPrep };
