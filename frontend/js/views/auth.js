// Écrans publics : connexion, inscription, mot de passe oublié, page de commande du client.
import { h, ask, toast, errToast, fmtGNF, fmtPhone, spinner, action, kv, amount } from '../ui.js';
import { get, post } from '../api.js';

const logo = () => h('img', { class: 'auth-logo', src: '/assets/logo-gold.png', alt: 'Wallindirain' });
const shell = (...c) => h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, logo(), ...c));
const field = (label, input, hint) => h('label', { class: 'f' }, h('span', {}, label), input, hint && h('div', { class: 'hint' }, hint));

export function loginView({ onLogin, contact }) {
  const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'username', placeholder: '6XX XX XX XX', required: true, maxlength: 16 });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const err = h('div', { class: 'notice bad hidden', role: 'alert' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.classList.add('hidden');
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try { const r = await post('/auth/login', { phone: phone.value, password: pw.value }); onLogin(r.user); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    finally { btn.disabled = false; }
  } },
    h('h1', {}, 'Connexion'), err,
    field('Numéro de téléphone', phone), field('Mot de passe', pw),
    h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Se connecter'),
    h('p', { class: 'center small mt' }, h('a', { href: '#/forgot' }, 'Mot de passe oublié ?')));
  return shell(h('div', { class: 'card' }, form),
    h('p', { class: 'auth-foot' }, 'Nouveau vendeur ou fournisseur ? ', h('a', { href: '#/register' }, 'Créer un compte')),
    h('p', { class: 'auth-foot' }, `Besoin d'aide : ${fmtPhone(contact)}`));
}

export function registerView() {
  const role = h('select', {}, h('option', { value: 'seller' }, 'Vendeur : je vends des produits en ligne'), h('option', { value: 'supplier' }, 'Fournisseur : je propose des produits'));
  const name = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX' });
  const doc = h('input', { type: 'text', required: true, maxlength: 60, placeholder: 'Ex. CNI ou passeport : numéro' });
  const pw = h('input', { type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password' });
  const out = h('div');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await post('/auth/register', { role: role.value, name: name.value, phone: phone.value, password: pw.value, identity_doc: doc.value });
      out.replaceChildren(h('div', { class: 'notice ok' }, r.message), h('a', { class: 'btn btn-gold btn-block', href: '#/login' }, 'Aller à la connexion'));
      form.classList.add('hidden');
    } catch (ex) { errToast(ex); } finally { btn.disabled = false; }
  } },
    h('h1', {}, 'Créer un compte'), field('Je suis', role), field('Nom complet', name), field('Numéro de téléphone', phone, 'Les messages de confirmation et codes seront envoyés à ce numéro.'),
    field('Pièce d\'identité', doc, 'Obligatoire. Elle sera vérifiée par Wallindirain avant votre premier retrait d\'argent.'),
    field('Mot de passe', pw, '8 caractères minimum, avec des lettres et des chiffres.'),
    h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Créer mon compte'));
  return shell(h('div', { class: 'card' }, form, out), h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, '← Retour à la connexion')));
}

export function forgotView() {
  const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX' });
  const box = h('div');
  const step1 = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await post('/auth/forgot', { phone: phone.value }); toast('Si ce numéro est inscrit, un code vient d\'être envoyé.', 'ok'); showStep2(); } catch (ex) { errToast(ex); }
  } }, h('h1', {}, 'Mot de passe oublié'), field('Votre numéro de téléphone', phone), h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Recevoir un code'));
  function showStep2() {
    const code = h('input', { class: 'code-input', inputmode: 'numeric', maxlength: 6, required: true, autocomplete: 'one-time-code' });
    const pw = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    box.replaceChildren(h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { await post('/auth/reset', { phone: phone.value, code: code.value, password: pw.value }); toast('Mot de passe changé. Connectez-vous.', 'ok'); location.hash = '#/login'; } catch (ex) { errToast(ex); }
    } }, field('Code reçu par message (valable 15 minutes)', code), field('Nouveau mot de passe', pw, '8 caractères minimum, lettres et chiffres.'), h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Changer le mot de passe')));
    step1.classList.add('hidden');
  }
  return shell(h('div', { class: 'card' }, step1, box), h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, '← Retour à la connexion')));
}

/** Page ouverte par le client final depuis le lien partagé par un vendeur. */
export function clientOrderView(code) {
  const root = h('div', { class: 'public' }, spinner());
  (async () => {
    let data;
    try { data = await get(`/public/link/${encodeURIComponent(code)}`); }
    catch (e) { root.replaceChildren(h('div', { class: 'hero' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' })), h('div', { class: 'card' }, h('h1', {}, 'Lien indisponible'), h('p', {}, e.message))); return; }
    const p = data.product;
    const qty = h('input', { type: 'number', min: 1, max: Math.min(p.available, 20) || 1, value: 1, required: true });
    const name = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' });
    const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX', autocomplete: 'tel' });
    const commune = h('select', { required: true }, h('option', { value: '' }, 'Choisir ma commune'), data.communes.map((c) => h('option', { value: c.commune }, `${c.commune} (livraison ${fmtGNF(c.fee)})`)));
    const address = h('textarea', { required: true, maxlength: 300, placeholder: 'Quartier, rue, repère connu (pharmacie, mosquée, marché…)' });
    const total = h('span', {}, fmtGNF(p.unit_price));
    qty.addEventListener('input', () => { total.textContent = fmtGNF(p.unit_price * (parseInt(qty.value, 10) || 1)); });
    const done = h('div', { class: 'hidden' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await post(`/public/link/${encodeURIComponent(code)}/order`, { qty: parseInt(qty.value, 10), name: name.value, phone: phone.value, commune: commune.value, address: address.value });
        form.classList.add('hidden');
        done.classList.remove('hidden');
        done.replaceChildren(h('div', { class: 'notice ok' }, h('b', {}, 'Commande enregistrée !')),
          h('h2', {}, `Référence ${r.ref}`),
          h('p', {}, 'Un conseiller Wallindirain va vous appeler très bientôt pour confirmer votre commande. Gardez votre téléphone allumé.'),
          h('p', {}, 'Après confirmation, vous recevrez un ', h('b', {}, 'code à 4 chiffres'), '. Ne le donnez au livreur qu\'une fois le colis en main : vous payez à la livraison.'),
          kv([['Total à payer à la livraison', amount(r.sale_total)]]));
      } catch (ex) { errToast(ex); btn.disabled = false; }
    } },
      h('h2', {}, 'Vos informations'),
      field('Quantité', qty), field('Votre nom', name), field('Votre téléphone', phone, 'Le conseiller vous appellera à ce numéro.'), field('Commune', commune), field('Adresse de livraison', address),
      h('div', { class: 'total-line' }, h('span', {}, 'Total à payer à la livraison'), total),
      h('button', { class: 'btn btn-gold btn-block mt', type: 'submit' }, 'Commander, payer à la livraison'));
    root.replaceChildren(
      h('div', { class: 'hero' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' })),
      h('div', { class: 'card' }, h('h1', {}, p.name), p.description && h('p', {}, p.description), h('div', { class: 'price-big' }, fmtGNF(p.unit_price)),
        p.available > 0 ? h('div', { class: 'badge ok' }, 'Disponible') : h('div', { class: 'badge bad' }, 'Rupture de stock'), h('p', { class: 'small muted' }, 'Paiement uniquement à la réception de votre colis.')),
      p.available > 0 ? h('div', { class: 'card' }, form, done) : h('div', { class: 'notice warn' }, 'Ce produit est momentanément indisponible.'),
      h('p', { class: 'center small muted' }, `Une question ? Appelez le ${fmtPhone(data.contact_phone)}`));
  })();
  return root;
}
