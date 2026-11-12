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
  if (method !== 'GET') netState(true);
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(data?.message || 'Une erreur est survenue.', res.status, data?.error);
  }
  return data;
}

// Dernières données gardées sur le téléphone de la personne (jamais dans le cache partagé du navigateur), pour consulter Mes finances sans réseau.
// Effacées à la déconnexion. Seules ces lectures sont gardées.
const CACHEABLE = /^\/(auth\/me|pf\/(status|settings|currencies|home|accounts|categories|shop|transactions)(\?.*)?)$/;
const CK = 'wld-cache:';
export const clearCache = () => { try { Object.keys(localStorage).filter((k) => k.startsWith(CK)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignoré */ } };
export const rememberUser = (user) => { try { localStorage.setItem(`${CK}/auth/me`, JSON.stringify({ at: Date.now(), d: { user } })); } catch { /* ignoré */ } };
const netState = (online) => { if (netState.on !== online) { netState.on = online; window.dispatchEvent(new Event('wld-net')); } };
export const isOffline = () => netState.on === false;
export async function get(p) {
  if (!CACHEABLE.test(p)) return api('GET', p);
  try {
    const d = await api('GET', p); netState(true);
    try { localStorage.setItem(CK + p, JSON.stringify({ at: Date.now(), d })); } catch { /* stockage plein : ignoré */ }
    return d;
  } catch (e) {
    if (e.code !== 'network') throw e;
    let c = null; try { c = JSON.parse(localStorage.getItem(CK + p) || localStorage.getItem(CK + p.split('?')[0]) || 'null'); } catch { /* ignoré */ }   // à défaut, la même page sans réglage de période
    netState(false);
    if (!c) throw e;
    return c.d;
  }
}
export const post = (p, b = {}) => api('POST', p, b);
