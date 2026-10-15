// AI answer feedback: limits (the same as the API's), verdict styling and the
// stored attempt history (kit.answer_feedback, latest 5 per question, oldest
// first).

export const MIN_ANSWER_LENGTH = 40;
export const MAX_ANSWER_LENGTH = 4000;
export const MAX_FEEDBACK_HISTORY = 5;
export const INTERVIEW_MODE_SECONDS = 120;

// strong = green, solid = light green, needs_work = amber, off_track = red.
export const VERDICTS = {
  strong: { label: 'Strong', className: 'bg-brand-600 text-white' },
  solid: { label: 'Solid', className: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200' },
  needs_work: { label: 'Needs work', className: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-200' },
  off_track: { label: 'Off track', className: 'bg-danger-50 text-danger-700 ring-1 ring-inset ring-danger-200' },
};

export const verdictOf = (verdict) => VERDICTS[verdict] || VERDICTS.needs_work;

export const answerLengthProblem = (answer) => {
  const length = String(answer || '').trim().length;
  if (length < MIN_ANSWER_LENGTH) return `${MIN_ANSWER_LENGTH - length} more character${MIN_ANSWER_LENGTH - length === 1 ? '' : 's'} needed`;
  if (length > MAX_ANSWER_LENGTH) return `${length - MAX_ANSWER_LENGTH} character${length - MAX_ANSWER_LENGTH === 1 ? '' : 's'} over the limit`;
  return '';
};

// Kits saved before answer feedback existed have no answer_feedback.
export const feedbackHistoryFor = (kit, questionId) => {
  const history = kit?.answer_feedback?.[questionId];
  return Array.isArray(history) ? history : [];
};

// The kit with one more attempt for a question, capped like the API.
export const withFeedbackAttempt = (kit, questionId, attempt) => {
  if (!kit) return kit;
  const history = feedbackHistoryFor(kit, questionId).filter((item) => item?.id !== attempt?.id);
  return { ...kit, answer_feedback: { ...(kit.answer_feedback || {}), [questionId]: [...history, attempt].slice(-MAX_FEEDBACK_HISTORY) } };
};

// The question a flashcard practices (its first linked question).
export const questionForFlashcard = (kit, flashcard) => {
  const ids = Array.isArray(flashcard?.questionIds) ? flashcard.questionIds : [];
  return (kit?.questions || []).find((question) => ids.includes(question.id)) || null;
};

export const formatClock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
