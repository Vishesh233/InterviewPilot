// Deterministic interview schedule builder.
// No LLM, no I/O — the same questions and interviewDays always produce the same schedule.

const MIN_INTERVIEW_DAYS = 1;
const MAX_INTERVIEW_DAYS = 60;

/**
 * Spread question ids evenly across interviewDays.
 * Returns { interviewDays, days: [{ day, questions: [id, ...] }] }.
 *
 * Balancing: every day gets floor(total / days) questions, and the first
 * `total % days` days get one extra — so day sizes differ by at most 1.
 * Question order is preserved and each question appears exactly once.
 */
const createSchedule = ({ questions, interviewDays } = {}) => {
  if (
    !Number.isInteger(interviewDays) ||
    interviewDays < MIN_INTERVIEW_DAYS ||
    interviewDays > MAX_INTERVIEW_DAYS
  ) {
    throw new Error(
      `interviewDays must be an integer between ${MIN_INTERVIEW_DAYS} and ${MAX_INTERVIEW_DAYS}.`
    );
  }

  if (!Array.isArray(questions)) {
    throw new Error('questions must be an array of question objects.');
  }

  // Only the ids are copied — the original question objects are never modified.
  const questionIds = questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new Error(`questions[${index}] must be a question object.`);
    }
    if (typeof question.id !== 'string' || !question.id.trim()) {
      throw new Error(`questions[${index}].id must be a non-empty string.`);
    }
    return question.id;
  });

  const total = questions.length;
  const baseCount = Math.floor(total / interviewDays);
  const extraCount = total % interviewDays; // first `extraCount` days get one more

  const days = [];
  let cursor = 0;
  for (let day = 1; day <= interviewDays; day++) {
    const count = baseCount + (day <= extraCount ? 1 : 0);
    days.push({ day, questions: questionIds.slice(cursor, cursor + count) });
    cursor += count;
  }

  return { interviewDays, days };
};

module.exports = { createSchedule };
