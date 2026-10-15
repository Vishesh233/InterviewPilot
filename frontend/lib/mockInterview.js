// Mock interview helpers: chat messages from a session's turns, score colors
// for the report bars, and the pending-turn note that lets a reload during
// grading keep polling the same job.

export const MOCK_LENGTHS = [3, 4, 5];

// One interviewer message (and, once answered, the user's answer and its
// feedback) per turn; follow-ups share the number of their main question.
export function chatTurns(session) {
  let number = 0;
  return (session?.turns || []).map((turn, index) => {
    if (turn.kind === 'main') number += 1;
    return { ...turn, index, number };
  });
}

// "Question 2 of 3" (+ " · follow-up").
export const progressLabel = (question) =>
  question ? `Question ${question.number} of ${question.of}${question.kind === 'followUp' ? ' · follow-up' : ''}` : '';

// One line for the compact feedback: what to add first, or what worked for a strong answer.
export const feedbackLine = (feedback) => {
  if (!feedback) return '';
  if (feedback.score >= 8 && feedback.strengths?.length) return feedback.strengths[0];
  return feedback.gaps?.[0] || feedback.strengths?.[0] || '';
};

// Bar color for a 1-10 score (design tokens): 8-10 green, 6-7 light green, 4-5 amber, 1-3 red.
export const scoreBarClass = (score) => {
  if (score >= 8) return 'bg-brand-600';
  if (score >= 6) return 'bg-brand-500';
  if (score >= 4) return 'bg-warning-700';
  return 'bg-danger-500';
};

export const sessionStatusLabel = (summary) => {
  if (summary.status === 'completed') return summary.overallScore ? `${summary.overallScore}/10` : 'No report';
  if (summary.status === 'active') return 'In progress';
  return 'Ended';
};

// The job of an answer that is being graded, kept for this tab only so a
// reload can continue polling it. Storage may be unavailable (private mode,
// blocked site data); then a reload simply shows the question again.
const pendingKey = (sessionId) => `interviewpilot:mock-pending:${sessionId}`;

export function savePendingTurn(sessionId, pending) {
  try {
    window.sessionStorage.setItem(pendingKey(sessionId), JSON.stringify(pending));
  } catch (error) {
    console.warn('Could not remember the answer being graded.', error?.name || error);
  }
}

export function loadPendingTurn(sessionId) {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(sessionId));
    const pending = raw ? JSON.parse(raw) : null;
    return pending && typeof pending.jobId === 'string' && typeof pending.answer === 'string' ? pending : null;
  } catch (error) {
    console.warn('Could not read the answer being graded.', error?.name || error);
    return null;
  }
}

export function clearPendingTurn(sessionId) {
  try {
    window.sessionStorage.removeItem(pendingKey(sessionId));
  } catch (error) {
    console.warn('Could not clear the answer being graded.', error?.name || error);
  }
}
