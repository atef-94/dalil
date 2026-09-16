import { api } from './api.js';

export const session = {
  me: null,
  manifest: null,
};

export async function loadSession() {
  session.me = await api.get('/api/me');
  session.manifest = await api.get('/api/me/manifest');
  return session;
}

export function can(resource, action) {
  if (!session.manifest) return false;
  const entry = session.manifest.entries.find((e) => e.resource === resource && e.action === action);
  return !!entry?.allowed;
}

const LOCALE_KEY = 'active_os_locale';
export function getLocale() {
  return localStorage.getItem(LOCALE_KEY) || 'en';
}
export function setLocale(locale) {
  localStorage.setItem(LOCALE_KEY, locale);
}
