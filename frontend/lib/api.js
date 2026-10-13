const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || '/api/proxy').replace(/\/$/, '');

// Every request is cut off client-side after this long. Long generations run as
// background jobs, so no single request needs more than a few seconds.
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', details = null, jobId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    // Set on 409 JOB_ALREADY_RUNNING: the job that is already running.
    this.jobId = jobId;
  }
}

const describeWait = (seconds) => {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

// 429 from the API rate limits: a friendly message with the wait time, taken
// from Retry-After (or the body's retryAfterSeconds when a proxy drops it).
const rateLimitError = (response, payload) => {
  const header = Number.parseInt(response.headers.get('Retry-After') || '', 10);
  const fromBody = Number(payload?.error?.retryAfterSeconds);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(fromBody) && fromBody > 0 ? Math.ceil(fromBody) : null;
  const message = seconds
    ? `You're doing that too often. Please wait ${describeWait(seconds)} and try again.`
    : "You're doing that too often. Please wait a few minutes and try again.";
  return new ApiError(message, { status: 429, code: 'RATE_LIMITED', details: seconds ? { retryAfterSeconds: seconds } : null });
};

const readError = async (response) => {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 429) return rateLimitError(response, payload);
  const error = payload?.error;
  if (error && typeof error === 'object') {
    return new ApiError(error.message || 'The request could not be completed.', {
      status: response.status,
      code: error.code || 'API_ERROR',
      details: error.details || null,
      jobId: typeof error.jobId === 'string' ? error.jobId : null,
    });
  }
  return new ApiError(
    payload?.message || 'The request could not be completed.',
    { status: response.status, code: 'API_ERROR' }
  );
};

export async function apiRequest(path, { token, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (fetchError) {
    if (controller.signal.aborted) {
      throw new ApiError(`The service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Please try again.`, {
        code: 'REQUEST_TIMEOUT',
      });
    }
    throw new ApiError('Unable to reach the interview-prep service. Check your connection and try again.', {
      code: 'NETWORK_ERROR',
      details: fetchError instanceof Error ? fetchError.name : null,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('interviewpilot:unauthorized'));
  }
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new ApiError('The service returned an invalid response.', {
      status: response.status,
      code: 'INVALID_RESPONSE',
    });
  }
}

export const api = {
  register: (body) => apiRequest('/api/auth/register', { method: 'POST', body }),
  login: (body) => apiRequest('/api/auth/login', { method: 'POST', body }),
  listKits: (token) => apiRequest('/api/kits', { token }),
  getKit: (token, id) => apiRequest(`/api/kits/${encodeURIComponent(id)}`, { token }),
  createKit: (token, body) => apiRequest('/api/kits', { method: 'POST', token, body }),
  updateKit: (token, id, body) => apiRequest(`/api/kits/${encodeURIComponent(id)}`, { method: 'PUT', token, body }),
  deleteKit: (token, id) => apiRequest(`/api/kits/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
  // Generation endpoints answer 202 { jobId }; poll getJob for progress.
  generateKit: (token, body) => apiRequest('/api/interview-prep', { method: 'POST', token, body }),
  getJob: (token, jobId) => apiRequest(`/api/jobs/${encodeURIComponent(jobId)}`, { token }),
  resumeJob: (token, jobId) => apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST', token, body: {} }),
  editQuestion: (token, kitId, questionId, body) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/${encodeURIComponent(questionId)}`, { method: 'PATCH', token, body }),
  reorderQuestions: (token, kitId, questionIds) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/reorder`, { method: 'PATCH', token, body: { questionIds } }),
  pinQuestion: (token, kitId, questionId, pinned) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/${encodeURIComponent(questionId)}/pin`, { method: 'PATCH', token, body: { pinned } }),
  regenerateSection: (token, kitId, category) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/regenerate`, { method: 'POST', token, body: { category } }),
  generateGapQuestions: (token, kitId) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/gaps`, { method: 'POST', token, body: {} }),
  getPractice: (token, kitId) => apiRequest(`/api/kits/${encodeURIComponent(kitId)}/practice`, { token }),
  updatePractice: (token, kitId, flashcardId, changes) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/practice/${encodeURIComponent(flashcardId)}`, { method: 'PATCH', token, body: changes }),
};
