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

export const fmtGNF = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} GNF`;
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
export const FAIL_LABEL = { customer_absent: 'Client absent', customer_refusal: 'Client a refusé', address_not_found: 'Adresse introuvable', other: 'Autre' };
export const CAUSE_LABEL = { customer_refusal: 'Refus du client', defective: 'Défectueux à l\'origine', damaged_transport: 'Abîmé pendant le transport' };
export const WALLET_KIND = {
  deposit: 'Dépôt', stock_purchase: 'Achat de stock', seller_gain: 'Gain de vente', supplier_payment: 'Paiement produit', team_pay: 'Rémunération',
  return_fees: 'Frais de retour', return_fee_supplier: 'Frais de retour (produit défectueux)', prepaid_refund: 'Remboursement de stock', transport_loss: 'Compensation transport',
  cash_shortage: 'Manque de caisse', withdrawal: 'Retrait', withdrawal_refund: 'Retrait refusé (remboursé)'
};

/** Photo de profil, ou initiales si la personne n'en a pas. `ver` force le rechargement après un changement. */
export function avatar(user, size = 40, ver = '') {
  const initials = (user.name || user.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (!user.has_avatar) return h('span', { class: 'avatar avatar-i', 'aria-hidden': 'true', 'data-size': size }, initials);
  return h('img', { class: 'avatar', src: `/api/users/${user.id}/avatar${ver ? `?v=${ver}` : ''}`, alt: `Photo de ${user.name || user.full_name}`, width: size, height: size });
}

/** Liens légaux, affichés en bas des écrans publics et dans l'application. */
export const legalLinks = () => h('ul', { class: 'legal-links' },
  [['/legal/confidentialite', 'Confidentialité'], ['/legal/conditions', 'Conditions'], ['/legal/cookies', 'Cookies'], ['/legal/retours-remboursements', 'Retours'], ['/legal/mentions-legales', 'Mentions légales']]
    .map(([href, t]) => h('li', {}, h('a', { href, target: '_blank', rel: 'noopener' }, t))), h('li', {}, h('a', { href: '#/demande-donnees' }, 'Mes données')));

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
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'ok'); if (refresh) await refresh(); return r; }
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
