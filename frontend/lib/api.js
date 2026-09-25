const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || '/api/proxy').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const readError = async (response) => {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const error = payload?.error;
  if (error && typeof error === 'object') {
    return new ApiError(error.message || 'The request could not be completed.', {
      status: response.status,
      code: error.code || 'API_ERROR',
      details: error.details || null,
    });
  }
  return new ApiError(
    payload?.message || 'The request could not be completed.',
    { status: response.status, code: 'API_ERROR' }
  );
};

export async function apiRequest(path, { token, body, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Unable to reach the interview-prep service. Check your connection and try again.', {
      code: 'NETWORK_ERROR',
    });
  }

  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('trao:unauthorized'));
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
  generateKit: (token, body) => apiRequest('/api/interview-prep', { method: 'POST', token, body }),
  editQuestion: (token, kitId, questionId, body) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/${encodeURIComponent(questionId)}`, { method: 'PATCH', token, body }),
  reorderQuestions: (token, kitId, questionIds) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/reorder`, { method: 'PATCH', token, body: { questionIds } }),
  pinQuestion: (token, kitId, questionId, pinned) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/questions/${encodeURIComponent(questionId)}/pin`, { method: 'PATCH', token, body: { pinned } }),
  regenerateSection: (token, kitId, category) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/regenerate`, { method: 'POST', token, body: { category } }),
  getPractice: (token, kitId) => apiRequest(`/api/kits/${encodeURIComponent(kitId)}/practice`, { token }),
  updatePractice: (token, kitId, flashcardId, changes) =>
    apiRequest(`/api/kits/${encodeURIComponent(kitId)}/practice/${encodeURIComponent(flashcardId)}`, { method: 'PATCH', token, body: changes }),
};
