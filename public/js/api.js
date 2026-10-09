const TOKEN_KEY = 'active_os_token';
const COMPANY_ID_KEY = 'active_os_company_id';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  sessionExpiredNotified = false;
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Fired once per session on the first 401 — app.js listens for this to
// drop back to the login screen with a clear message, instead of leaving
// an already-rendered page silently signed out while every further action
// throws a raw "invalid or expired token" error.
let sessionExpiredNotified = false;
function notifySessionExpired() {
  clearToken();
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  window.dispatchEvent(new CustomEvent('session-expired'));
}
export function getSavedCompanyId() {
  return localStorage.getItem(COMPANY_ID_KEY) || '';
}
export function saveCompanyId(companyId) {
  if (companyId) localStorage.setItem(COMPANY_ID_KEY, companyId);
}
export function isAuthenticated() {
  return !!getToken();
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, query } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    if (qs) url += (path.includes('?') ? '&' : '?') + qs;
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined;

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    if (res.status === 401) notifySessionExpired();
    const message = (parsed && (parsed.error || parsed.message)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return parsed;
}

/** File uploads (Lead/Inventory/Payment import) use multipart/form-data,
 * not JSON — the browser sets Content-Type (with its boundary) itself
 * when given a FormData body, so this bypasses request()'s JSON headers
 * entirely rather than fighting them. */
async function upload(path, formData) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { method: 'POST', headers, body: formData });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    if (res.status === 401) notifySessionExpired();
    const message = (parsed && (parsed.error || parsed.message)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return parsed;
}

/** Project media files (master plan, cover image, gallery, brochure) are
 * returned as base64 JSON (see app.ts's GET /api/inventory/files/:fileId —
 * this app has no raw-binary response path), so a real <img>/<a> src needs
 * a real browser Blob URL built from that base64. Cached per fileId for
 * the lifetime of the page — repeatedly re-opening the same Project Details
 * modal never re-fetches/re-decodes the same file twice. */
const fileBlobUrlCache = new Map();
async function getFileBlobUrl(fileId) {
  if (!fileId) return undefined;
  if (fileBlobUrlCache.has(fileId)) return fileBlobUrlCache.get(fileId);
  const promise = (async () => {
    const result = await request(`/api/inventory/files/${fileId}`);
    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: result.contentType });
    return URL.createObjectURL(blob);
  })();
  fileBlobUrlCache.set(fileId, promise);
  try {
    return await promise;
  } catch (err) {
    fileBlobUrlCache.delete(fileId);
    throw err;
  }
}

export const api = {
  get: (path, query) => request(path, { method: 'GET', query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  delete: (path) => request(path, { method: 'DELETE' }),
  upload,
  getFileBlobUrl,
};
