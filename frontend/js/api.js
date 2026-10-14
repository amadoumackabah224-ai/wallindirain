// Appels à l'API. Toutes les erreurs deviennent des exceptions avec un message lisible en français.
export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'x-wld': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw new ApiError('Connexion impossible. Vérifiez votre réseau.', 0, 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(data?.message || 'Une erreur est survenue.', res.status, data?.error);
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
