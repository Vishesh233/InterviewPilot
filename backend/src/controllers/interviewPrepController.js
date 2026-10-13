const { startJob, runnerFrom } = require('./generationJobsController');
const { assertSafeUrl } = require('../services/urlSecurityService');
const { normalizeResumeInput, ResumeInputError } = require('../services/resumeInputService');
const { MAX_JOB_DESCRIPTION_LENGTH, MAX_JOB_ROLE_LENGTH, isBoundedString, isPlainSafeObject, hasUnsafeKeys } = require('../services/inputValidationService');

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
// Input is validated synchronously (bad input -> 400). Valid input starts a
// background kit job and answers 202 { jobId }; poll GET /api/jobs/:id.
const generateInterviewPrep = async (req, res, deps = {}) => {
  if (!isPlainSafeObject(req.body) || hasUnsafeKeys(req.body)) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body must be a safe JSON object.',
      },
    });
  }

  const { jobRole, jobDescription, companyUrl, interviewDays } = req.body;

  if (
    !isBoundedString(jobRole, MAX_JOB_ROLE_LENGTH) ||
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
          'jobRole must be a non-empty string, jobDescription must be a non-empty string, companyUrl must be a valid HTTP/HTTPS URL, and interviewDays must be an integer between 1 and 60.',
      },
    });
  }

  // The resume is optional. It exists in memory for this request only: it is
  // normalized to text, passed to the pipeline, and never logged, persisted,
  // echoed back, or placed in a URL.
  let resume;
  try {
    resume = normalizeResumeInput(req.body.resume);
  } catch (error) {
    if (error instanceof ResumeInputError) {
      return res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    return res.status(400).json({
      error: {
        code: 'RESUME_INVALID_PAYLOAD',
        message: 'The resume attachment could not be read.',
      },
    });
  }

  // Valid input: the generation runs as a background job. The resume text is
  // handed to the job in memory only; the stored job input never contains it.
  return startJob(res, runnerFrom(deps), {
    userId: req.userId,
    type: 'kit',
    input: {
      jobRole: jobRole.trim(),
      jobDescription,
      companyUrl,
      interviewDays,
      hasResume: Boolean(resume),
    },
    ...(resume ? { memoryInput: { resume } } : {}),
  });
};

module.exports = { generateInterviewPrep };
