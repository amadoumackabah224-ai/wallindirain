// Verrouillage de l'application par code (4 à 6 chiffres) et, si le téléphone le permet, empreinte ou visage.
// Tout reste sur le téléphone : le code n'est jamais envoyé au serveur ; seule son empreinte (PBKDF2 + sel) est gardée ici.
// Déconnexion = code oublié : la personne se reconnecte avec son mot de passe, ce qui retire le verrouillage.
import { h, ask, toast } from './ui.js';

const LK = 'wld-lock';
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const read = () => { try { return JSON.parse(localStorage.getItem(LK) || 'null'); } catch { return null; } };
const write = (r) => { try { if (r) localStorage.setItem(LK, JSON.stringify(r)); else localStorage.removeItem(LK); } catch { /* ignoré */ } };
export const clearLock = () => write(null);

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256));
}
const DELAYS = [[0, 'Dès que je quitte l\'application'], [1, 'Après 1 minute'], [5, 'Après 5 minutes'], [15, 'Après 15 minutes']];
export const biometricAvailable = async () => { try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; } };

let me = null; let onForget = null; let screen = null; let hiddenAt = 0;

/** À appeler une fois la personne connectée. Verrouille tout de suite si un code est actif. */
export function initLock(user, forget) {
  onForget = forget;
  if (me && me.id === user.id) return;                       // déjà initialisé pour cette session
  me = user;
  const r = read();
  if (r && r.user !== user.id) write(null);                  // code d'une autre personne sur ce téléphone : on l'oublie
  if (read() && !screen) showLock();
  if (!initLock.bound) {
    initLock.bound = true;
    document.addEventListener('visibilitychange', () => {
      const rec = read();
      if (!me || !rec) return;
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt >= (rec.delay || 0) * 60000 && !screen) showLock();
    });
  }
}
export const stopLock = () => { me = null; screen?.remove(); screen = null; };

function showLock() {
  const rec = read(); if (!rec || screen) return;
  let pin = ''; let timer = null;
  const dots = h('div', { class: 'lock-dots', 'aria-hidden': 'true' });
  const msg = h('p', { class: 'lock-msg', role: 'status', 'aria-live': 'polite' }, '');
  const paintDots = () => dots.replaceChildren(...Array.from({ length: rec.len || 4 }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  const wait = () => Math.max(0, Math.ceil(((read()?.until || 0) - Date.now()) / 1000));
  const keys = [];
  const unlock = () => { clearInterval(timer); screen?.remove(); screen = null; document.removeEventListener('keydown', onKey); hiddenAt = 0; };
  const tick = () => { const s = wait(); msg.textContent = s > 0 ? `Trop d'essais. Réessayez dans ${s} s.` : msg.textContent.startsWith('Trop') ? '' : msg.textContent; keys.forEach((k) => { k.disabled = s > 0; }); };
  const check = async () => {
    const cur = read(); if (!cur) return unlock();
    const ok = (await hashPin(pin, unb64(cur.salt))) === cur.hash; pin = ''; paintDots();
    if (ok) { write({ ...cur, fails: 0, until: 0 }); return unlock(); }
    const fails = (cur.fails || 0) + 1;
    if (fails >= 10) { write(null); unlock(); toast('Trop d\'essais : reconnectez-vous avec votre mot de passe.', 'bad'); return onForget?.(); }
    write({ ...cur, fails, until: fails >= 5 ? Date.now() + 30000 * (fails - 4) : 0 });
    msg.textContent = fails >= 5 ? '' : `Code incorrect (${10 - fails} essais restants).`; tick();
  };
  const press = (d) => { if (wait() > 0 || pin.length >= (rec.len || 4)) return; pin += d; paintDots(); if (pin.length === (rec.len || 4)) check(); };
  const del = () => { pin = pin.slice(0, -1); paintDots(); };
  const onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') del(); };
  const pad = h('div', { class: 'lock-pad' }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => { const b = h('button', { type: 'button', onclick: () => press(String(d)), 'aria-label': String(d) }, String(d)); keys.push(b); return b; }),
    rec.bio ? h('button', { type: 'button', class: 'lock-aux', onclick: () => bio(), 'aria-label': 'Déverrouiller avec l\'empreinte ou le visage' }, '☝') : h('span', {}),
    (() => { const b = h('button', { type: 'button', onclick: () => press('0'), 'aria-label': '0' }, '0'); keys.push(b); return b; })(),
    h('button', { type: 'button', class: 'lock-aux', onclick: del, 'aria-label': 'Effacer' }, '⌫'));
  async function bio() {
    try {
      await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: unb64(rec.bio) }], userVerification: 'required', timeout: 60000 } });
      write({ ...rec, fails: 0, until: 0 }); unlock();
    } catch { /* annulé : on reste sur le code */ }
  }
  screen = h('div', { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Application verrouillée' },
    h('div', { class: 'lock-box' }, h('div', { class: 'lock-logo' }, 'WALLINDIRAIN'), h('h2', {}, 'Entrez votre code'), dots, msg, pad,
      h('button', { type: 'button', class: 'lock-forgot', onclick: () => { if (window.confirm('Se déconnecter ? Vous vous reconnecterez avec votre mot de passe, et le code sera retiré.')) { write(null); unlock(); onForget?.(); } } }, 'Code oublié ? Se déconnecter')));
  document.body.append(screen); document.addEventListener('keydown', onKey); paintDots();
  timer = setInterval(tick, 1000); tick();
  if (rec.bio && wait() === 0) bio();
}

/** Carte de réglage du verrouillage (profil). */
export function lockCard(user, rerender) {
  const rec = read(); const on = !!rec && rec.user === user.id;
  const askPin = async (title, text) => {
    const v = await ask({ title, text, submit: 'Continuer', fields: [
      { name: 'pin', label: 'Code (4 à 6 chiffres)', type: 'password', inputmode: 'numeric', maxlength: 6 },
      { name: 'pin2', label: 'Confirmez le code', type: 'password', inputmode: 'numeric', maxlength: 6 }] });
    if (!v) return null;
    if (!/^\d{4,6}$/.test(v.pin)) { toast('Le code doit avoir 4 à 6 chiffres.', 'bad'); return null; }
    if (v.pin !== v.pin2) { toast('Les deux codes ne sont pas identiques.', 'bad'); return null; }
    return v.pin;
  };
  const save = async (pin, extra = {}) => { const salt = crypto.getRandomValues(new Uint8Array(16)); write({ user: user.id, salt: b64(salt), hash: await hashPin(pin, salt), len: pin.length, delay: 1, bio: null, fails: 0, until: 0, ...extra }); };
  const turnOn = async () => { const pin = await askPin('Choisir un code', 'Ce code protège l\'application sur ce téléphone. Il n\'est jamais envoyé sur Internet.'); if (!pin) return; await save(pin); toast('Verrouillage activé', 'ok'); rerender?.(); };
  const change = async () => { const pin = await askPin('Changer le code', ''); if (!pin) return; await save(pin, { delay: rec.delay, bio: rec.bio }); toast('Code modifié', 'ok'); rerender?.(); };
  const off = async () => {
    const v = await ask({ title: 'Désactiver le verrouillage', text: 'Entrez votre code actuel.', submit: 'Désactiver', danger: true, fields: [{ name: 'pin', label: 'Code actuel', type: 'password', inputmode: 'numeric', maxlength: 6 }] });
    if (!v) return;
    if ((await hashPin(v.pin, unb64(rec.salt))) !== rec.hash) { toast('Code incorrect.', 'bad'); return; }
    write(null); toast('Verrouillage désactivé', 'ok'); rerender?.();
  };
  const setDelay = (e) => { write({ ...read(), delay: Number(e.target.value) }); toast('Réglage enregistré', 'ok'); };
  const setBio = async () => {
    if (rec.bio) { write({ ...rec, bio: null }); toast('Empreinte ou visage retiré', 'ok'); return rerender?.(); }
    try {
      const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Wallindirain' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: user.phone || 'compte', displayName: user.full_name || 'Compte' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' }, timeout: 60000 } });
      write({ ...rec, bio: b64(c.rawId) }); toast('Empreinte ou visage activé', 'ok'); rerender?.();
    } catch { toast('Activation annulée ou impossible sur ce téléphone.', 'bad'); }
  };
  const box = h('div', { class: 'card' }, h('h2', {}, 'Verrouillage de l\'application'));
  if (!on) {
    box.append(h('p', { class: 'small muted' }, 'Protégez votre argent et vos données : un code est demandé à l\'ouverture. Désactivé par défaut.'), h('button', { class: 'btn btn-gold', type: 'button', onclick: turnOn }, 'Activer le code'));
    return box;
  }
  const sel = h('select', { 'aria-label': 'Quand verrouiller', onchange: setDelay }, DELAYS.map(([v, l]) => h('option', { value: v, selected: v === (rec.delay || 0) }, l)));
  box.append(h('p', { class: 'small muted' }, 'Le code est demandé à l\'ouverture de l\'application, puis selon le délai choisi quand vous la quittez.'), h('label', { class: 'small' }, 'Verrouiller ', sel),
    h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: change }, 'Changer le code'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: off }, 'Désactiver')));
  biometricAvailable().then((ok) => { if (ok) box.append(h('button', { class: 'btn btn-ghost mt', type: 'button', onclick: setBio }, rec.bio ? 'Retirer l\'empreinte ou le visage' : 'Utiliser l\'empreinte ou le visage')); });
  return box;
}
