// Saisie hors connexion : une dépense, un revenu ou une vente saisis sans réseau sont gardés sur le téléphone,
// puis envoyés automatiquement quand le réseau revient. Chaque opération porte une clé unique : si l'envoi est répété,
// le serveur ne l'enregistre qu'une fois.
import { api, get, isOffline } from './api.js';
import { h, toast } from './ui.js';

const QK = 'wld-offq';
let who = null;
export const setOfflineUser = (id) => { who = id; };
const read = () => { try { return JSON.parse(localStorage.getItem(QK) || '[]'); } catch { return []; } };
const write = (l) => { try { localStorage.setItem(QK, JSON.stringify(l)); } catch { /* ignoré */ } window.dispatchEvent(new Event('wld-offq')); };
export const pending = () => read().filter((i) => i.user === who);
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 40);

/** Envoie l'opération ; sans réseau, la garde sur le téléphone et rend { queued: true }. Les refus du serveur (solde, stock, saisie invalide) restent des erreurs. */
export async function postOffline(path, body, label) {
  const client_key = newKey();
  try { return await api('POST', path, { ...body, client_key }); }
  catch (e) {
    if (e.code !== 'network' || !who) throw e;
    write([...read(), { key: client_key, user: who, path, body, label, at: Date.now() }]);
    return { queued: true };
  }
}

let flushing = false;
export async function flush() {
  if (flushing || !who) return;
  flushing = true; let sent = 0;
  try {
    for (const item of read().filter((i) => i.user === who && !i.error)) {
      try { await api('POST', item.path, { ...item.body, client_key: item.key }); write(read().filter((i) => i.key !== item.key)); sent += 1; }
      catch (e) {
        if (e.code === 'network' || e.status === 401) break;                                   // pas de réseau ou session expirée : on réessaiera
        if (e.status === 409 && /en cours/.test(e.message)) break;
        write(read().map((i) => (i.key === item.key ? { ...i, error: e.message } : i)));      // refusé par le serveur : la personne décide
      }
    }
  } finally { flushing = false; }
  if (sent > 0) { toast(sent > 1 ? `${sent} opérations envoyées` : 'Opération envoyée', 'ok'); window.dispatchEvent(new Event('wld-synced')); }
}

let started = false;
export function startSync() {
  if (started) return; started = true;
  window.addEventListener('online', flush);
  setInterval(() => { if (pending().some((i) => !i.error)) flush(); }, 20000);
  flush();
}

/** Bandeau en haut de Mes finances : état du réseau, opérations en attente, refus à traiter. */
export function offlineBar(onSynced) {
  const root = h('div', { class: 'off-bar-wrap' });
  const paint = () => {
    const list = pending(); const waiting = list.filter((i) => !i.error); const failed = list.filter((i) => i.error);
    const kids = [];
    if (isOffline()) kids.push(h('div', { class: 'off-bar', role: 'status' }, h('b', {}, 'Hors connexion'), h('span', {}, ' · vos saisies sont gardées sur le téléphone et envoyées dès que le réseau revient.')));
    if (waiting.length) kids.push(h('div', { class: 'off-bar wait', role: 'status' }, h('span', { class: 'grow' }, `${waiting.length} opération${waiting.length > 1 ? 's' : ''} en attente d'envoi : ${waiting.map((i) => i.label).slice(0, 3).join(', ')}${waiting.length > 3 ? '…' : ''}`),
      h('button', { class: 'off-btn', type: 'button', onclick: async () => { await flush(); if (pending().some((i) => !i.error)) toast('Toujours pas de réseau : vos saisies restent gardées.', 'bad'); } }, 'Envoyer')));
    failed.forEach((i) => kids.push(h('div', { class: 'off-bar bad', role: 'alert' }, h('span', { class: 'grow' }, h('b', {}, `${i.label} : refusé`), ` · ${i.error}`),
      h('button', { class: 'off-btn', type: 'button', onclick: () => write(read().filter((x) => x.key !== i.key)) }, 'Supprimer'))));
    root.replaceChildren(...kids);
  };
  const live = () => root.isConnected;
  const on = () => { if (live()) paint(); else { ['wld-net', 'wld-offq'].forEach((e) => window.removeEventListener(e, on)); window.removeEventListener('wld-synced', synced); } };
  const synced = () => { if (live()) { paint(); onSynced?.(); } };
  ['wld-net', 'wld-offq'].forEach((e) => window.addEventListener(e, on)); window.addEventListener('wld-synced', synced);
  paint();
  return root;
}

/** À l'ouverture de Mes finances (avec réseau), garde les dernières données utiles pour pouvoir les consulter et saisir sans réseau. */
let warmed = false;
export function warmCache(extra = []) {
  if (warmed || isOffline()) return; warmed = true;
  Promise.allSettled(['/pf/accounts', '/pf/categories', '/pf/transactions', '/pf/home', ...extra].map((p) => get(p)));
}
