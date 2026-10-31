import { icon } from './icons.js';
// Outils d'interface. Règle de sécurité : on ne passe JAMAIS par innerHTML ;
// tout texte est ajouté comme nœud texte, donc aucune injection (XSS) possible.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs || {})) {
    if (val == null || val === false) continue;
    if (k.startsWith('on') && typeof val === 'function') el.addEventListener(k.slice(2).toLowerCase(), val);
    else if (k === 'class') el.className = val;
    else if (k === 'value') el.value = val;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!val;
    else el.setAttribute(k, val === true ? '' : String(val));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Clé d'envoi unique d'un formulaire de commande : renvoyée avec la demande, elle empêche une double commande si l'envoi est répété. */
export const newRequestKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''));
// Mode de paie d'une tournée groupée (choisi par le chef, figé à la création)
export const tourModeText = (mode, bps) => {
  const pc = `${Math.round(Number(bps) / 100)} %`;
  if (mode === 'share') return `Mode A : vous recevez ${pc} des frais de chaque commande livrée de la tournée`;
  if (mode === 'split') return `Mode B : la 1ʳᵉ commande livrée est payée normalement, les suivantes ${pc} pour le livreur`;
  return 'Paie habituelle de chaque commande';
};
export const fmtGNF = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} GNF`;
/** « 25 min », « 3 h », « 2 j » : temps écoulé depuis une date. */
export const since = (d) => { if (!d) return ''; const m = Math.max(0, Math.round((Date.now() - new Date(String(d).replace(' ', 'T').replace(/\+00$/, 'Z')).getTime()) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} j`; };
/** Colis affecté mais pas récupéré depuis plus de `hours` heures (0 = alerte désactivée). */
export const pickupLate = (o, hours) => o.status === 'assigned' && hours > 0 && o.assigned_since && Date.now() - new Date(String(o.assigned_since).replace(' ', 'T').replace(/\+00$/, 'Z')).getTime() > hours * 3600_000;
export const fmtDate = (d) => d ? new Date(d.replace(' ', 'T').replace(/\+00$/, 'Z')).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
export const fmtPhone = (p) => ((p || '').startsWith('+') ? p : (p || '').replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4'));
/** Coordonnées de versement : numéro Mobile Money guinéen, ou texte libre (« autre », versement manuel pour un vendeur de l'étranger). */
export const PAYOUT_LABEL = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo', other: 'Autre (versement manuel)' };
export const payoutText = (method, value) => `${PAYOUT_LABEL[method] || method} · ${method === 'other' ? value : fmtPhone(value)}`;

export const ORDER_STATUS = {
  new: ['Nouvelle', 'gold'], in_call: ['En appel', 'warn'], confirmed: ['Confirmée', 'ok'], assigned: ['Affectée', 'info'],
  picked_up: ['Ramassée', 'info'], on_the_way: ['En route', 'info'], delivered: ['Livrée', 'ok'], failed: ['Échec livraison', 'bad'],
  return_pending: ['Retour attendu', 'warn'], returned: ['Retournée', 'grey'], refused: ['Refusée', 'bad'], cancelled: ['Annulée', 'grey']
};
export const statusBadge = (s) => { const [t, c] = ORDER_STATUS[s] || [s, 'grey']; return h('span', { class: `badge ${c}` }, t); };
export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const ROLE_LABEL = { admin: 'Administrateur', supplier: 'Fournisseur', seller: 'Vendeur', agent: 'Agent call center', call_chief: 'Chef call center', courier: 'Livreur', warehouse: 'Magasinier' };
/** Photos d'un produit (identifiants renvoyés par l'API) ; onDelete ajoute une croix de suppression (fournisseur). */
export const photoStrip = (ids = [], { size = 88, onDelete } = {}) => ids.length ? h('div', { class: 'photo-strip' }, ids.map((id) => h('span', { class: 'photo-wrap' },
  h('img', { class: 'photo-thumb', src: `/api/product-images/${id}`, alt: 'Photo du produit', loading: 'lazy', width: size, height: size }),
  onDelete && h('button', { class: 'photo-del', type: 'button', 'aria-label': 'Supprimer cette photo', onclick: () => onDelete(id) }, '×')))) : null;
export const PICKUP_LABEL = { warehouse: 'Entrepôt Wallindirain', supplier: 'Chez le fournisseur', seller: 'Chez le vendeur' };
export const pickupText = (o) => `${PICKUP_LABEL[o.pickup_place] ?? '—'}${o.pickup_detail ? ` : ${o.pickup_detail}` : o.pickup_missing ? ' (adresse non indiquée)' : ''}`;
export const FAIL_LABEL = { customer_absent: 'Client absent', customer_refusal: 'Client a refusé', address_not_found: 'Adresse introuvable', other: 'Autre' };
export const CAUSE_LABEL = { customer_refusal: 'Refus du client', defective: 'Défectueux à l\'origine', damaged_transport: 'Abîmé pendant le transport' };
export const WALLET_KIND = {
  deposit: 'Dépôt', stock_purchase: 'Achat de stock', seller_gain: 'Gain de vente', supplier_payment: 'Paiement produit', team_pay: 'Rémunération', tour_bonus: 'Bonus de tournée', tour_adjust: 'Ajustement de tournée',
  return_fees: 'Frais de retour', return_fee_supplier: 'Frais de retour (produit défectueux)', prepaid_refund: 'Remboursement de stock', transport_loss: 'Compensation transport',
  cash_shortage: 'Manque de caisse', withdrawal: 'Retrait', referral_bonus: 'Bonus de parrainage', withdrawal_refund: 'Retrait refusé (remboursé)'
};

/** Photo de profil, ou initiales si la personne n'en a pas. `ver` force le rechargement après un changement. */
export function avatar(user, size = 40, ver = '') {
  const initials = (user.name || user.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (!user.has_avatar) return h('span', { class: 'avatar avatar-i', 'aria-hidden': 'true', 'data-size': size }, initials);
  return h('img', { class: 'avatar', src: `/api/users/${user.id}/avatar${ver ? `?v=${ver}` : ''}`, alt: `Photo de ${user.name || user.full_name}`, width: size, height: size });
}

/** Ouvre un texte légal DANS l'application (fenêtre de lecture) : chargé à la demande. */
// Public dont on lit les textes : sert à résoudre « confidentialite » et « conditions » vers le texte du bon rôle.
const LEGAL_DOC = { client: ['conditions-client', 'confidentialite-client'], seller: ['conditions-vendeur', 'confidentialite-vendeur'], supplier: ['conditions-fournisseur', 'confidentialite-fournisseur'],
  courier: ['conditions-livreur', 'confidentialite-livreur'], team: ['regles-equipe', 'confidentialite-equipe'] };
export const AUDIENCE_OF_ROLE = { seller: 'seller', supplier: 'supplier', courier: 'courier', agent: 'team', call_chief: 'team', warehouse: 'team', admin: 'client' };
let legalAudience = 'client';
export const setLegalAudience = (a) => { if (LEGAL_DOC[a]) legalAudience = a; };
/** « conditions » / « confidentialite » deviennent le texte du public concerné ; les autres adresses restent telles quelles. */
export const resolveLegal = (slug, audience = legalAudience) => (slug === 'conditions' ? LEGAL_DOC[audience]?.[0] : slug === 'confidentialite' ? LEGAL_DOC[audience]?.[1] : slug) || slug;
export const showLegal = (slug, audience) => import('./views/legal.js').then((m) => m.openLegal(resolveLegal(slug, audience), audience));
/** Lien-bouton vers un texte légal (reste dans l'application, ne fait pas perdre un formulaire en cours). */
export const legalLink = (slug, text, audience) => h('button', { class: 'linklike', type: 'button', onclick: () => showLegal(slug, audience) }, text);
/** Liens en pied de page, selon qui regarde : visiteur (mentions, cookies), client (ses textes), connecté (« Mes documents » = les textes de son rôle). */
export const legalLinks = (mode = 'public') => {
  const items = mode === 'client'
    ? [['conditions-client', 'Conditions d\'achat'], ['confidentialite-client', 'Confidentialité'], ['retours-remboursements', 'Retours'], ['mentions-legales', 'Mentions légales'], ['cookies', 'Cookies']].map(([slug, t]) => h('li', {}, legalLink(slug, t, 'client')))
    : mode === 'user'
      ? [h('li', {}, legalLink('confidentialite', 'Mes documents')), h('li', {}, legalLink('mentions-legales', 'Mentions légales'))]
      : [h('li', {}, legalLink('mentions-legales', 'Mentions légales')), h('li', {}, legalLink('cookies', 'Cookies')), h('li', {}, h('a', { href: '#/demande-donnees' }, 'Mes données'))];
  return h('ul', { class: 'legal-links' }, items);
};

/** Indicateur cliquable : icône, valeur, libellé, précision. tone : bad, warn, gold, info, ok, grey. */
export function metric({ ico, tone = 'grey', label, value, hint, onclick }) {
  return h('button', { class: `metric ${tone}`, type: 'button', onclick },
    h('span', { class: 'metric-ico' }, icon(ico, 20)), h('span', { class: 'metric-v' }, value), h('span', { class: 'metric-l' }, label), hint && h('span', { class: 'metric-h' }, hint));
}
/** Bandeau d'alerte avec action facultative. tone : '' (ambre) ou 'bad'. */
export function alertRow(tone, ico, text, btnLabel, onclick) {
  return h('div', { class: `alert-row ${tone}`, role: 'note' }, icon(ico, 20), h('span', { class: 'grow' }, text), btnLabel && h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick }, btnLabel));
}
export const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': 'Chargement' });
/** État vide : icône dans une pastille, message, et action facultative. `ico` peut être un nom d'icône ou un ancien emoji. */
export const empty = (ico, text, actionNode) => h('div', { class: 'empty' }, h('span', { class: 'ico' }, icon(ico, 26)), h('p', {}, text), actionNode);
/** En-tête de page : titre, sous-titre et actions alignées à droite. */
export const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, title), sub && h('p', { class: 'page-sub' }, sub)), actions.length > 0 && h('div', { class: 'gap' }, ...actions));

export function toast(message, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3500);
}
export const errToast = (e) => toast(e?.message || 'Erreur', 'bad');

/** Lit une image choisie par l'utilisateur et la réduit (1280 px max, JPEG) pour qu'elle reste légère : renvoie une data URL. */
export function compressImage(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Choisissez une image (capture d\'écran ou photo)'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Image illisible'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image illisible'));
      img.onload = () => {
        let side = maxSide, q = 0.72, out = '';
        for (let i = 0; i < 4; i++) {   // on réduit jusqu'à passer sous ~450 Ko
          const k = Math.min(1, side / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL('image/jpeg', q);
          if (out.length < 600_000) return resolve(out);
          side = Math.round(side * 0.75); q -= 0.1;
        }
        reject(new Error('Image trop lourde : prenez une capture plus petite'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Affiche une capture d'écran de preuve (chargée depuis l'API, droits vérifiés par le serveur). */
export function showProof(id, title = 'Preuve de paiement') {
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h('div', { class: 'modal' }, h('h2', {}, title), h('img', { class: 'proof-img', src: `/api/proofs/${id}`, alt: title }),
      h('div', { class: 'gap mt' }, h('a', { class: 'btn btn-ghost grow', href: `/api/proofs/${id}`, target: '_blank', rel: 'noopener' }, 'Ouvrir en grand'), h('button', { class: 'btn btn-gold grow', onclick: () => overlay.remove() }, 'Fermer'))));
  document.body.append(overlay);
}
export const proofButton = (id, label = 'Voir la preuve') => id ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => showProof(id) }, [icon('receipt', 16), ' ', label]) : null;

/** Fenêtre de saisie. fields: [{name,label,type,options,hint,value,required,placeholder,inputmode,maxlength}] -> valeurs ou null */
// Vrai si la dernière fenêtre de saisie a été annulée : l'action en cours n'affiche alors pas de faux message de réussite.
let askCancelled = false;
export function ask({ title, text, fields = [], submit = 'Valider', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {}, images = {};
    const opener = document.activeElement;
    const close = (v) => { askCancelled = v === null; overlay.remove(); document.removeEventListener('keydown', onKey); opener?.isConnected && opener.focus?.(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') return close(null);
      if (e.key !== 'Tab') return;   // le focus reste dans la fenêtre
      const f = [...overlay.querySelectorAll('button, input, select, textarea, a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        if (f.type === 'image') {
          if (f.required !== false && !images[f.name]) { toast(`${f.label} : ajoutez l'image`, 'bad'); return; }
          out[f.name] = images[f.name] || null;
        } else out[f.name] = inputs[f.name].type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
      }
      close(out);
    } },
      h('h2', { id: 'dlg-title' }, title), text && h('p', { class: 'muted' }, text),
      fields.map((f) => {
        let el;
        if (f.type === 'image') {
          const preview = h('img', { class: 'proof-img hidden', alt: 'Aperçu' });
          const status = h('div', { class: 'small muted' }, 'Aucune image choisie');
          el = h('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
            try { images[f.name] = await compressImage(e.target.files[0]); preview.src = images[f.name]; preview.classList.remove('hidden'); status.textContent = `Image prête (${Math.round(images[f.name].length * 0.75 / 1024)} Ko)`; }
            catch (ex) { images[f.name] = null; preview.classList.add('hidden'); status.textContent = ex.message; errToast(ex); }
          } });
          inputs[f.name] = el;
          return h('label', { class: 'f' }, h('span', {}, f.label), el, status, preview, h('div', { class: 'hint' }, f.hint || 'Cachez les informations qui n\'ont rien à voir avec le transfert (autres contacts, soldes, messages privés) avant de prendre la capture.'));
        }
        if (f.type === 'select') el = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
        else if (f.type === 'textarea') el = h('textarea', { placeholder: f.placeholder, maxlength: f.maxlength });
        else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!f.value });
        else el = h('input', { type: f.type || 'text', value: f.value, placeholder: f.placeholder, inputmode: f.inputmode, maxlength: f.maxlength, required: f.required !== false, autocomplete: 'off', class: f.code ? 'code-input' : '' });
        inputs[f.name] = el;
        return h('label', { class: 'f' }, h('span', {}, f.label), el, f.hint && h('div', { class: 'hint' }, f.hint));
      }),
      h('div', { class: 'gap mt' },
        h('button', { class: `btn grow ${danger ? 'btn-bad' : 'btn-gold'}`, type: 'submit' }, submit),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(null) }, 'Annuler')));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' }, form));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (Object.values(inputs)[0] || form.querySelector('button'))?.focus();
  });
}
export const confirmBox = (title, text, submit = 'Confirmer', danger = false) => ask({ title, text, submit, danger }).then((v) => v !== null);

/** Exécute une action avec retour visuel : désactive le bouton, affiche les erreurs, puis rafraîchit. */
export function action(fn, { ok, refresh } = {}) {
  return async (ev) => {
    const btn = ev?.currentTarget; if (btn) btn.disabled = true;
    askCancelled = false;
    try { const r = await fn(); const msg = ok && !askCancelled ? (typeof ok === 'function' ? ok(r) : ok) : ''; if (msg) toast(msg, 'ok'); if (refresh) await refresh(); return r; }
    catch (e) { errToast(e); }
    finally { if (btn?.isConnected) btn.disabled = false; }
  };
}

export function table(headers, rows, { empty: emptyNode } = {}) {
  if (!rows.length) return emptyNode || empty('∅', 'Rien à afficher');
  // Sur téléphone, chaque ligne devient une carte : le libellé de la colonne s'affiche devant chaque valeur (data-label).
  return h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { class: 'rt' }, h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x === '' ? h('span', { class: 'sr' }, 'Actions') : x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { 'data-label': headers[i] || null }, c)))))));
}
/** Liste libellé / valeur. Un 3ᵉ élément 'key' met la ligne en évidence (montant important). */
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v, key]) => [h('dt', { class: key ? 'key' : null }, k), h('dd', { class: key ? 'key' : null }, v)]));
export const amount = (n, signed = false) => h('span', { class: `amount mono ${signed ? (n < 0 ? 'neg' : 'pos') : ''}` }, (signed && n > 0 ? '+' : '') + fmtGNF(n));
/** Bouton « Appeler » : grande zone à toucher, pour le livreur et le call center. */
export const telBtn = (phone, label = 'Appeler') => h('a', { href: `tel:+224${phone}`, class: 'btn btn-sm btn-ghost' }, icon('phone', 16), label);
export const telLink = (phone, label) => h('a', { href: `tel:+224${phone}`, class: 'nowrap' }, label || fmtPhone(phone));
export const waLink = (phone, text = '') => h('a', { href: `https://wa.me/224${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-sm btn-ghost' }, icon('message', 16), 'WhatsApp');

/** Charge des données, affiche le résultat, rafraîchit toutes les `poll` ms tant que la vue est affichée. */
export function liveView(load, render, { poll = 0, placeholder = null } = {}) {
  const root = h('div', {}, placeholder || spinner());
  let timer = null;
  const refresh = async () => {
    try { const data = await load(); const node = render(data, refresh); root.replaceChildren(node); }
    catch (e) { if (!root.firstChild || root.querySelector('.spinner, .skeleton')) root.replaceChildren(h('div', { class: 'notice bad' }, e.message)); else errToast(e); }
  };
  refresh();
  if (poll) timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else if (!document.querySelector('.overlay')) refresh(); }, poll);
  return root;
}

// ---------- Trophées Wallindirain : coupe au monogramme W posée sur un colis (notre métier : la livraison), étoiles de rang ; dessinés en SVG (aucun style en ligne : la politique de sécurité les interdit) ----------
export const TROPHY = {
  none: { icon: '', name: 'Pas encore de trophée', c1: '#cfd6e0', c2: '#9aa5b5', stars: 0 },
  bronze: { name: 'Bronze', c1: '#e0a064', c2: '#8c5a1f', stars: 1 },
  silver: { name: 'Argent', c1: '#f1f3f6', c2: '#8d96a3', stars: 2 },
  gold: { name: 'Or', c1: '#ffe27a', c2: '#b8860b', stars: 3 },
  platinum: { name: 'Platine', c1: '#f4f8fc', c2: '#8aa3bd', stars: 3, wreath: true },
  diamond: { name: 'Diamant', c1: '#e6fbff', c2: '#35b6d6', stars: 3, wreath: true, gem: true },
  blue_diamond: { name: 'Diamant Bleu', c1: '#6db6ff', c2: '#0b3d91', stars: 3, wreath: true, gem: true, spark: true },
};
export const TROPHY_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'blue_diamond'];
let trophyId = 0;
const STAR = 'M0-3l.9 1.9 2.1.3-1.5 1.5.4 2.1L0 1.8-1.9 2.8l.4-2.1-1.5-1.5 2.1-.3z';
export function trophy(tier = 'none', size = 56) {
  const t = TROPHY[tier] || TROPHY.none;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, ...kids) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };
  const id = `tg${++trophyId}`;
  const none = tier === 'none';
  const g = `url(#${id})`;
  const svg = el('svg', { viewBox: '0 0 64 64', width: size, height: size, role: 'img', 'aria-label': none ? 'Trophée à gagner' : `Trophée Wallindirain ${t.name}`, class: `trophy${none ? ' trophy-none' : ''}` },
    el('defs', {}, el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, el('stop', { offset: '0', 'stop-color': t.c1 }), el('stop', { offset: '1', 'stop-color': t.c2 }))));
  if (t.wreath) svg.append(el('path', { d: 'M10 22C8 34 14 44 24 47M54 22c2 12-4 22-14 25', fill: 'none', stroke: t.c2, 'stroke-opacity': '.85', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-dasharray': '.1 4.2' }));
  // anses
  svg.append(el('path', { d: 'M17 9H10c0 9 3 14 8 16M47 9h7c0 9-3 14-8 16', fill: 'none', stroke: t.c2, 'stroke-width': '3', 'stroke-linecap': 'round' }));
  // coupe + reflet
  svg.append(el('path', { d: 'M15 5h34v17c0 11-7 19-17 19S15 33 15 22z', fill: g, stroke: t.c2, 'stroke-width': '1.5', 'stroke-linejoin': 'round' }),
    el('path', { d: 'M20 9h5v13c0 6 2 10 5 13-6-2-10-8-10-15z', fill: '#ffffff', 'fill-opacity': '.28' }),
    el('rect', { x: '13.5', y: '3.5', width: '37', height: '4', rx: '2', fill: g, stroke: t.c2, 'stroke-width': '1.2' }));
  // monogramme W de Wallindirain
  svg.append(el('path', { d: 'M22 12l4.5 14L32 17l5.5 9L42 12', fill: 'none', stroke: none ? t.c2 : '#ffffff', 'stroke-opacity': none ? '.6' : '1', 'stroke-width': '3.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  // étoiles de rang
  const xs = !t.stars ? [] : t.stars === 1 ? [32] : t.stars === 2 ? [27.5, 36.5] : [24, 32, 40];
  for (const x of xs) svg.append(el('path', { d: STAR, transform: `translate(${x} 32.5)`, fill: '#ffffff', 'fill-opacity': '.95', stroke: t.c2, 'stroke-width': '.4' }));
  // pied, puis colis (notre métier) en socle : ruban adhésif et étiquette
  svg.append(el('rect', { x: '29', y: '40', width: '6', height: '8', fill: g, stroke: t.c2, 'stroke-width': '1' }),
    el('path', { d: 'M23 46h18l2 4H21z', fill: g, stroke: t.c2, 'stroke-width': '1', 'stroke-linejoin': 'round' }),
    el('rect', { x: '16', y: '50', width: '32', height: '12', rx: '1.5', fill: g, stroke: t.c2, 'stroke-width': '1.4' }),
    el('rect', { x: '29', y: '50', width: '6', height: '12', fill: '#ffffff', 'fill-opacity': '.55' }),
    el('path', { d: 'M19 54h7M19 57h5', stroke: '#ffffff', 'stroke-opacity': '.8', 'stroke-width': '1.4', 'stroke-linecap': 'round' }),
    el('path', { d: 'M40 55.5l2.5 2.5-2.5 2.5', fill: 'none', stroke: '#ffffff', 'stroke-opacity': '.9', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (t.gem) svg.append(el('path', { d: 'M32 -1.5l4 4-4 5.5-4-5.5z', transform: 'translate(0 1.5)', fill: '#ffffff', stroke: t.c2, 'stroke-width': '.9', 'stroke-linejoin': 'round' }));
  if (t.spark) svg.append(el('path', { d: 'M5 4v6M2 7h6M58 2v5M55.5 4.5h5', stroke: t.c1, 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
  return svg;
}

/* ---------- Apparence : clair, sombre, ou celui du téléphone (choix gardé sur cet appareil) ---------- */
const THEME_KEY = 'wl_theme';
let themeMem = null;
export const getTheme = () => { if (themeMem) return themeMem; try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };
export function applyTheme() {
  const t = getTheme();
  const dark = t === 'dark' || (t === 'auto' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export function setTheme(t) { themeMem = t === 'auto' ? null : t; try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* stockage indisponible : le choix vaut pour cette visite */ } applyTheme(); }
applyTheme();
try { globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch { /* ancien navigateur */ }

/** Liste de zones classée : par commune (avec ses quartiers), puis villes de l'intérieur (gare voiture). Renvoie les éléments <option>/<optgroup> d'un <select>. */
export function zoneOptions(zones, { fee = true } = {}) {
  const label = (z, name = z.commune) => `${name}${fee ? ` · ${fmtGNF(z.fee)}` : ''}`;
  const opt = (z, name) => h('option', { value: z.commune, 'data-kind': z.kind, 'data-pickup': z.pickup_point || '' }, label(z, name));
  const out = [];
  for (const c of zones.filter((z) => z.kind === 'commune')) {
    const kids = zones.filter((z) => z.parent === c.commune);
    out.push(h('optgroup', { label: c.commune }, opt(c, `${c.commune} (autre quartier)`), kids.map((k) => opt(k))));
  }
  const loose = zones.filter((z) => z.kind === 'quartier' && !zones.some((c) => c.commune === z.parent));
  if (loose.length) out.push(h('optgroup', { label: 'Autres quartiers' }, loose.map((z) => opt(z))));
  const villes = zones.filter((z) => z.kind === 'ville');
  if (villes.length) out.push(h('optgroup', { label: 'Villes de l\'intérieur (livraison à la gare voiture)' }, villes.map((z) => opt(z))));
  for (const z of zones.filter((z) => z.kind === 'autre')) out.push(opt(z));
  return out;
}
/** Petit message sous le choix de zone : pour une ville de l'intérieur, rappelle que le colis part à la gare voiture. */
export function zoneHint(select) {
  const hint = h('div', { class: 'hint hidden' });
  const upd = () => { const o = select.selectedOptions[0]; const ville = o?.dataset.kind === 'ville'; hint.classList.toggle('hidden', !ville); hint.textContent = ville ? `Livraison à la gare voiture${o.dataset.pickup ? ` : ${o.dataset.pickup}` : ' de la ville'}. Indiquez dans l'adresse le nom de la gare ou de la compagnie, et un numéro joignable sur place.` : ''; };
  select.addEventListener('change', upd); upd();
  return hint;
}

/** Imprime un morceau de page (facture, bon…) : une feuille cachée à l'écran, seule visible à l'impression ; aucun style en ligne (politique de sécurité). */
export function printNode(node, { invoice = false } = {}) {
  const sheet = h('div', { class: `print-sheet${invoice ? ' print-inv' : ''}` }, node);
  const done = () => { document.body.classList.remove('printing'); sheet.remove(); window.removeEventListener('afterprint', done); };
  document.body.append(sheet); document.body.classList.add('printing');
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

export const CHANNEL_LABEL = { facebook: 'Facebook', whatsapp: 'WhatsApp', tiktok: 'TikTok', instagram: 'Instagram', site: 'Site web', phone: 'Appel direct', other: 'Autre', unknown: 'Non précisé' };
