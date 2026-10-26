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
export const fmtPhone = (p) => (p || '').replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');

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

export const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': 'Chargement' });
export const empty = (icon, text) => h('div', { class: 'empty' }, h('span', { class: 'ico' }, icon), text);

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
export const proofButton = (id, label = 'Voir la preuve') => id ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => showProof(id) }, '🧾 ' + label) : null;

/** Fenêtre de saisie. fields: [{name,label,type,options,hint,value,required,placeholder,inputmode,maxlength}] -> valeurs ou null */
export function ask({ title, text, fields = [], submit = 'Valider', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {}, images = {};
    const opener = document.activeElement;
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); opener?.isConnected && opener.focus?.(); resolve(v); };
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
    try { const r = await fn(); const msg = ok ? (typeof ok === 'function' ? ok(r) : ok) : ''; if (msg) toast(msg, 'ok'); if (refresh) await refresh(); return r; }
    catch (e) { errToast(e); }
    finally { if (btn?.isConnected) btn.disabled = false; }
  };
}

export function table(headers, rows, { empty: emptyNode } = {}) {
  if (!rows.length) return emptyNode || empty('∅', 'Rien à afficher');
  return h('div', { class: 'table-wrap', tabindex: '0' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x === '' ? h('span', { class: 'sr' }, 'Actions') : x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
}
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
export const amount = (n, signed = false) => h('span', { class: `amount mono ${signed ? (n < 0 ? 'neg' : 'pos') : ''}` }, (signed && n > 0 ? '+' : '') + fmtGNF(n));
export const telLink = (phone, label) => h('a', { href: `tel:+224${phone}`, class: 'nowrap' }, label || fmtPhone(phone));
export const waLink = (phone, text = '') => h('a', { href: `https://wa.me/224${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-sm btn-ghost' }, 'WhatsApp');

/** Charge des données, affiche le résultat, rafraîchit toutes les `poll` ms tant que la vue est affichée. */
export function liveView(load, render, { poll = 0 } = {}) {
  const root = h('div', {}, spinner());
  let timer = null;
  const refresh = async () => {
    try { const data = await load(); const node = render(data, refresh); root.replaceChildren(node); }
    catch (e) { if (!root.firstChild || root.querySelector('.spinner')) root.replaceChildren(h('div', { class: 'notice bad' }, e.message)); else errToast(e); }
  };
  refresh();
  if (poll) timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else if (!document.querySelector('.overlay')) refresh(); }, poll);
  return root;
}

// ---------- Trophées : coupe dessinée en SVG (aucun style en ligne : la politique de sécurité les interdit) ----------
export const TROPHY = {
  none: { icon: '', name: 'Pas encore de trophée', c1: '#cfd6e0', c2: '#9aa5b5' },
  bronze: { name: 'Bronze', c1: '#e0a064', c2: '#8c5a1f' },
  silver: { name: 'Argent', c1: '#f1f3f6', c2: '#8d96a3' },
  gold: { name: 'Or', c1: '#ffe27a', c2: '#b8860b' },
  platinum: { name: 'Platine', c1: '#f4f8fc', c2: '#8aa3bd', ring: true },
  diamond: { name: 'Diamant', c1: '#e6fbff', c2: '#35b6d6', gem: true },
  blue_diamond: { name: 'Diamant Bleu', c1: '#6db6ff', c2: '#0b3d91', gem: true, spark: true },
};
export const TROPHY_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'blue_diamond'];
let trophyId = 0;
export function trophy(tier = 'none', size = 56) {
  const t = TROPHY[tier] || TROPHY.none;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, ...kids) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };
  const id = `tg${++trophyId}`;
  const svg = el('svg', { viewBox: '0 0 64 64', width: size, height: size, role: 'img', 'aria-label': tier === 'none' ? 'Trophée à gagner' : `Trophée ${t.name}`, class: `trophy${tier === 'none' ? ' trophy-none' : ''}` },
    el('defs', {}, el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, el('stop', { offset: '0', 'stop-color': t.c1 }), el('stop', { offset: '1', 'stop-color': t.c2 }))),
    el('path', { d: 'M16 12H9c0 10 4 14 9 15M48 12h7c0 10-4 14-9 15', fill: 'none', stroke: t.c2, 'stroke-width': '3', 'stroke-linecap': 'round' }),
    el('path', { d: 'M16 6h32v18c0 10-7 18-16 18S16 34 16 24z', fill: `url(#${id})`, stroke: t.c2, 'stroke-width': '1.5' }),
    el('rect', { x: '29', y: '41', width: '6', height: '11', fill: `url(#${id})`, stroke: t.c2, 'stroke-width': '1' }),
    el('rect', { x: '20', y: '52', width: '24', height: '7', rx: '2', fill: `url(#${id})`, stroke: t.c2, 'stroke-width': '1.5' }));
  if (t.gem) svg.append(el('path', { d: 'M32 12l9 9-9 14-9-14z', fill: '#ffffff', 'fill-opacity': '.85', stroke: t.c2, 'stroke-width': '1' }), el('path', { d: 'M23 21h18M32 12v23', stroke: t.c2, 'stroke-width': '.8', fill: 'none' }));
  else if (tier !== 'none') svg.append(el('path', { d: 'M32 12l3.1 6.4 7 .9-5.1 4.9 1.3 7-6.3-3.4-6.3 3.4 1.3-7-5.1-4.9 7-.9z', fill: '#ffffff', 'fill-opacity': '.8' }));
  if (t.ring) svg.append(el('circle', { cx: '32', cy: '24', r: '14', fill: 'none', stroke: '#ffffff', 'stroke-opacity': '.7', 'stroke-width': '1.2' }));
  if (t.spark) svg.append(el('path', { d: 'M8 4v6M5 7h6M56 2v5M53.5 4.5h5', stroke: t.c1, 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
  return svg;
}
