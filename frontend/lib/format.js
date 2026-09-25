export function formatDate(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', ...options }).format(date);
}

export function formatRelativeDate(value) {
  if (!value) return 'Recently';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(value);
}

export function percent(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
}

export function getKitId(kit) {
  return kit?._id || kit?.id || '';
}

export function difficultyLabel(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === '1' || normalized === 'easy') return 'Easy';
  if (normalized === '3' || normalized === 'hard') return 'Hard';
  return 'Medium';
}

export function questionText(question) {
  return question?.question || question?.prompt || question?.text || '';
}

export function answerPoints(question) {
  return Array.isArray(question?.expectedAnswerPoints)
    ? question.expectedAnswerPoints
    : Array.isArray(question?.answerOutline)
      ? question.answerOutline
      : [];
}

export function formatDuration(count) {
  if (!Number.isFinite(Number(count)) || Number(count) <= 0) return 'Not provided';
  const minutes = Number(count);
  return `${minutes} min`;
}
