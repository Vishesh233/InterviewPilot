// Background generation job helpers: stage labels, polling cadence, and
// user-facing messages for job error codes.

export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'retrying'];

export const isActiveJob = (job) => Boolean(job) && ACTIVE_JOB_STATUSES.includes(job.status);

// Poll every 2 s, then every 5 s once the job has been watched for a minute.
export const pollDelayMs = (elapsedMs) => (elapsedMs < 60_000 ? 2_000 : 5_000);

const STAGE_LABELS = {
  'Requirement extraction': 'Reading job requirements',
  'Company research': 'Researching the company',
  'Company brief': 'Writing the company brief',
  'Question generation': 'Generating interview questions',
  'Coverage check': 'Checking requirement coverage',
  'Coverage gap filling': 'Filling coverage gaps',
  'Final coverage check': 'Re-checking coverage',
  'Resume gap analysis': 'Matching your resume to the role',
  'Resume question generation': 'Writing questions about your projects',
  'Interview scheduling': 'Building the preparation schedule',
  'Saving kit': 'Saving your kit',
  'Answer feedback': 'Reviewing your answer',
  'Saving feedback': 'Saving your feedback',
};

export const stageLabel = (stage) => (stage && STAGE_LABELS[stage]) || stage || 'Getting started';

const PROVIDER_BUSY_CODES = ['LLM_PROVIDER_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_NETWORK_ERROR'];

const MESSAGES = {
  JOB_TIMEOUT: 'The generation took too long and was stopped.',
  JOB_INTERRUPTED: 'The server restarted while this generation was running.',
  INSUFFICIENT_JOB_DESCRIPTION: 'The job description did not contain enough detail to extract requirements. Add more detail and start over.',
  NO_QUESTIONS_GENERATED: 'No usable interview questions were generated.',
  REGENERATE_NO_USABLE_QUESTIONS: 'The AI models did not return any usable questions for this section, so nothing was changed. Please try again in a minute.',
  LLM_NO_USABLE_OUTPUT: 'The AI models returned answers that could not be used. Please try again in a minute.',
  KIT_VALIDATION_FAILED: 'The generated kit did not pass validation, so it was not saved.',
  KIT_NOT_FOUND: 'This kit no longer exists.',
  QUESTION_NOT_FOUND: 'This question is no longer in the kit.',
  LLM_THINKING_CONFIG_REJECTED: 'The AI provider rejected the server configuration.',
  LLM_INVALID_CONFIG: 'The AI provider is misconfigured on the server.',
  LLM_NOT_CONFIGURED: 'The AI provider is not configured on the server.',
};

// A short sentence for the failure, mapped from the job's error code. Codes
// without a mapping use the server's own (already user-safe) message.
export function jobFailureMessage(error) {
  const code = error?.code || '';
  if (PROVIDER_BUSY_CODES.includes(code)) return 'The AI providers stayed busy even after automatic retries.';
  if (MESSAGES[code]) return MESSAGES[code];
  if (code === 'RESEARCH_INSUFFICIENT_TEXT' || code === 'RESEARCH_NO_READABLE_TEXT') {
    return 'The company page was reached, but it had too little readable public information to research. Try a more detailed page, such as the About or Careers page.';
  }
  if (code.startsWith('RESEARCH_')) return 'We could not read the company website.';
  return error?.message || 'The generation could not be completed.';
}
