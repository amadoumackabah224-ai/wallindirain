// Écrans publics : connexion, inscription, mot de passe oublié, page de commande du client.
import { h, toast, errToast, fmtGNF, fmtPhone, spinner, kv, amount, legalLinks, legalLink } from '../ui.js';
import { get, post } from '../api.js';

const logo = () => h('img', { class: 'auth-logo', src: '/assets/logo-gold.png', alt: 'Wallindirain' });
const shell = (...c) => h('main', { class: 'auth', id: 'contenu' }, h('div', { class: 'auth-card' }, logo(), ...c, h('div', { class: 'auth-foot' }, legalLinks())));
const consentBox = (input, text) => h('label', { class: 'f check' }, input, h('span', {}, text));
// L'option e-mail est masquée tant que l'envoi d'e-mails n'est pas activé sur le serveur (EMAIL_PROVIDER).
export const flags = { email: false };
const field = (label, input, hint) => h('label', { class: 'f' }, h('span', {}, label), input, hint && h('div', { class: 'hint' }, hint));

export function loginView({ onLogin, contact }) {
  const phone = h('input', { type: 'text', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: flags.email ? '6XX XX XX XX ou nom@exemple.com' : '6XX XX XX XX', required: true, maxlength: 254 });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const err = h('div', { class: 'notice bad hidden', role: 'alert' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.classList.add('hidden');
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try { const r = await post('/auth/login', { identifier: phone.value.trim(), password: pw.value }); onLogin(r.user); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    finally { btn.disabled = false; }
  } },
    h('h1', {}, 'Connexion'), err,
    field(flags.email ? 'Numéro de téléphone ou adresse e-mail' : 'Numéro de téléphone', phone), field('Mot de passe', pw),
    h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Se connecter'),
    h('p', { class: 'center small mt' }, h('a', { href: '#/forgot' }, 'Mot de passe oublié ?')));
  return shell(h('div', { class: 'card' }, form),
    h('p', { class: 'auth-foot' }, 'Nouveau vendeur ou fournisseur ? ', h('a', { href: '#/register' }, 'Créer un compte')),
    h('p', { class: 'auth-foot' }, `Besoin d'aide : ${fmtPhone(contact)}`));
}

export function registerView({ ref } = {}) {
  const role = h('select', {}, h('option', { value: 'seller' }, 'Vendeur : je vends des produits en ligne'), h('option', { value: 'supplier' }, 'Fournisseur : je propose des produits'));
  const name = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX' });
  const doc = h('input', { type: 'text', maxlength: 60, placeholder: 'Ex. CNI ou passeport : numéro' });
  const docField = h('div');
  const syncDoc = () => {
    const sup = role.value === 'supplier';
    doc.required = sup;
    refField.replaceChildren(sup ? '' : field('Code de parrainage', referral, 'Si un vendeur Wallindirain vous a invité, saisissez son code.'));
    docField.replaceChildren(field(sup ? 'Pièce d\'identité' : 'Pièce d\'identité (facultative pour l\'instant)', doc, sup ? 'Obligatoire pour un fournisseur : elle est vérifiée avant l\'activation du compte. Saisissez seulement le numéro, aucune photo n\'est demandée.' : 'Vous pourrez l\'ajouter plus tard, avant votre premier retrait d\'argent. Seul le numéro est demandé, aucune photo.'));
  };
  const accept = h('input', { type: 'checkbox', required: true });
  // les textes proposés sont ceux du rôle choisi (vendeur ou fournisseur)
  const consentText = h('span');
  const syncConsent = () => { const aud = role.value; const suf = aud === 'supplier' ? 'fournisseur' : 'vendeur'; consentText.replaceChildren('J\'ai 18 ans ou plus et j\'accepte les ', legalLink(`conditions-${suf}`, aud === 'supplier' ? 'conditions du fournisseur' : 'conditions du vendeur', aud), ' et la ', legalLink(`confidentialite-${suf}`, 'politique de confidentialité', aud), '.'); };
  role.addEventListener('change', () => { syncDoc(); syncConsent(); });
  const pw = h('input', { type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password' });
  const payMethod = h('select', {}, h('option', { value: 'orange_money' }, 'Orange Money'), h('option', { value: 'mtn_momo' }, 'MTN MoMo'));
  const email = h('input', { type: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: 254, placeholder: 'nom@exemple.com (facultatif)' });
  const referral = h('input', { type: 'text', maxlength: 12, autocapitalize: 'characters', spellcheck: 'false', value: ref || '', placeholder: 'Facultatif' });
  const refField = h('div');
  const payPhone = h('input', { type: 'tel', inputmode: 'numeric', maxlength: 16, placeholder: 'Laisser vide = mon numéro de téléphone' });
  const out = h('div');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await post('/auth/register', { role: role.value, name: name.value, phone: phone.value, password: pw.value, accept_terms: accept.checked, ...(role.value === 'seller' && referral.value.trim() ? { referral_code: referral.value.trim() } : {}), ...(flags.email && email.value.trim() ? { email: email.value.trim() } : {}), ...(doc.value.trim() ? { identity_doc: doc.value } : {}),
        payout_method: payMethod.value, ...(payPhone.value.trim() ? { payout_phone: payPhone.value } : {}) });
      out.replaceChildren(h('div', { class: 'notice ok' }, r.message), r.referral_applied === false && h('div', { class: 'notice warn' }, 'Le code de parrainage n\'a pas été reconnu : votre compte est créé sans parrain.'), h('a', { class: 'btn btn-gold btn-block', href: '#/login' }, 'Aller à la connexion'));
      form.classList.add('hidden');
    } catch (ex) { errToast(ex); } finally { btn.disabled = false; }
  } },
    h('h1', {}, 'Créer un compte'), field('Je suis', role), field('Nom complet', name), field('Numéro de téléphone', phone, flags.email ? 'Vous pourrez vous connecter avec ce numéro.' : 'Les messages de confirmation et codes seront envoyés à ce numéro.'),
    flags.email && field('Adresse e-mail (recommandé)', email, 'Un code de confirmation y sera envoyé. Une fois confirmée, vous pourrez vous connecter avec elle et recevoir vos codes (mot de passe oublié) directement dans votre boîte e-mail.'),
    docField, refField,
    field('Mon argent sera versé sur', payMethod),
    field('Numéro de versement', payPhone, 'Vos retraits seront envoyés à ce numéro. Vous pourrez le changer dans Profil (mot de passe demandé).'),
    field('Mot de passe', pw, '8 caractères minimum, avec des lettres et des chiffres.'),
    h('label', { class: 'f check' }, accept, consentText),
    h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Créer mon compte'));
  syncDoc(); syncConsent();
  return shell(h('div', { class: 'card' }, form, out), h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, '← Retour à la connexion')));
}

export function forgotView() {
  const phone = h('input', { type: 'text', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 254, placeholder: flags.email ? '6XX XX XX XX ou nom@exemple.com' : '6XX XX XX XX' });
  const box = h('div');
  const step1 = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { const r = await post('/auth/forgot', { identifier: phone.value.trim() }); toast(r.message, 'ok'); showStep2(); } catch (ex) { errToast(ex); }
  } }, h('h1', {}, 'Mot de passe oublié'), field(flags.email ? 'Votre adresse e-mail confirmée ou votre numéro' : 'Votre numéro de téléphone', phone, flags.email ? 'Le code est envoyé dans votre boîte e-mail si votre adresse est confirmée (pensez à vérifier les courriers indésirables).' : 'Si le code n\'arrive pas, appelez le numéro de contact : l\'administration vous enverra un mot de passe temporaire.'), h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Recevoir un code'));
  function showStep2() {
    const code = h('input', { class: 'code-input', inputmode: 'numeric', maxlength: 6, required: true, autocomplete: 'one-time-code' });
    const pw = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    box.replaceChildren(h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { await post('/auth/reset', { identifier: phone.value.trim(), code: code.value, password: pw.value }); toast('Mot de passe changé. Connectez-vous.', 'ok'); location.hash = '#/login'; } catch (ex) { errToast(ex); }
    } }, field('Code reçu (valable 15 minutes)', code), field('Nouveau mot de passe', pw, '8 caractères minimum, lettres et chiffres.'), h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Changer le mot de passe')));
    step1.classList.add('hidden');
  }
  return shell(h('div', { class: 'card' }, step1, box), h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, '← Retour à la connexion')));
}

/** Page ouverte par le client final depuis le lien partagé par un vendeur. */
export function clientOrderView(code) {
  const root = h('main', { class: 'public', id: 'contenu' }, spinner());
  (async () => {
    let data;
    try { data = await get(`/public/link/${encodeURIComponent(code)}`); }
    catch (e) { root.replaceChildren(h('div', { class: 'hero' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' })), h('div', { class: 'card' }, h('h1', {}, 'Lien indisponible'), h('p', {}, e.message))); return; }
    const p = data.product;
    const qty = h('input', { type: 'number', min: 1, max: Math.min(p.available, 20) || 1, value: 1, required: true });
    const name = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' });
    const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX', autocomplete: 'tel' });
    const commune = h('select', { required: true }, h('option', { value: '' }, 'Choisir mon quartier ou ma ville'), data.communes.map((c) => h('option', { value: c.commune }, `${c.commune} (livraison ${fmtGNF(c.fee)})`)));
    const address = h('textarea', { required: true, maxlength: 300, placeholder: 'Quartier, rue, repère connu (pharmacie, mosquée, marché…)' });
    const total = h('span', {}, fmtGNF(p.unit_price));
    qty.addEventListener('input', () => { total.textContent = fmtGNF(p.unit_price * (parseInt(qty.value, 10) || 1)); });
    const accepted = h('input', { type: 'checkbox', required: true });
    const done = h('div', { class: 'hidden' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await post(`/public/link/${encodeURIComponent(code)}/order`, { qty: parseInt(qty.value, 10), name: name.value, phone: phone.value, commune: commune.value, address: address.value, accepted: accepted.checked });
        form.classList.add('hidden');
        done.classList.remove('hidden');
        done.replaceChildren(h('div', { class: 'notice ok' }, h('b', {}, 'Commande enregistrée !')),
          h('h2', {}, `Référence ${r.ref}`),
          h('p', {}, 'Un conseiller Wallindirain va vous appeler très bientôt pour confirmer votre commande. Gardez votre téléphone allumé.'),
          h('p', {}, 'Après confirmation par notre équipe, un livreur vous contactera. Vous payez à la livraison, une fois le colis en main. Si un code de livraison vous est envoyé par message, ne le donnez au livreur qu\'à la réception du colis.'),
          kv([['Total à payer à la livraison', amount(r.sale_total)]]),
          r.track_token && h('a', { class: 'btn btn-ghost btn-block mt', href: `#/suivi/${r.track_token}` }, 'Suivre ma commande'),
          r.track_token && h('p', { class: 'small muted' }, 'Enregistrez cette page dans vos favoris pour suivre votre commande.'));
      } catch (ex) { errToast(ex); btn.disabled = false; }
    } },
      h('h2', {}, 'Vos informations'),
      field('Quantité', qty), field('Votre nom', name), field('Votre téléphone', phone, 'Le conseiller vous appellera à ce numéro.'), field('Quartier ou ville', commune), field('Adresse de livraison', address),
      h('p', { class: 'small muted' }, 'Nous gardons votre nom, votre téléphone et votre adresse uniquement pour confirmer par appel et livrer votre commande.'),
      consentBox(accepted, ['J\'accepte que mes informations soient utilisées pour cette commande, comme expliqué dans la ', legalLink('confidentialite-client', 'politique de confidentialité', 'client'), ', les ', legalLink('conditions-client', 'conditions d\'achat', 'client'), ' et les ', legalLink('retours-remboursements', 'règles de retour', 'client'), '.']),
      h('div', { class: 'total-line' }, h('span', {}, 'Total à payer à la livraison'), total),
      h('button', { class: 'btn btn-gold btn-block mt', type: 'submit' }, 'Commander, payer à la livraison'));
    root.replaceChildren(
      h('div', { class: 'hero' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' })),
      h('div', { class: 'card' }, h('h1', {}, p.name), p.description && h('p', {}, p.description), h('div', { class: 'price-big' }, fmtGNF(p.unit_price)),
        p.available > 0 ? h('div', { class: 'badge ok' }, 'Disponible') : h('div', { class: 'badge bad' }, 'Rupture de stock'), h('p', { class: 'small muted' }, 'Paiement uniquement à la réception de votre colis.')),
      p.available > 0 ? h('div', { class: 'card' }, form, done) : h('div', { class: 'notice warn' }, 'Ce produit est momentanément indisponible.'),
      h('p', { class: 'center small muted' }, `Une question ? Appelez le ${fmtPhone(data.contact_phone)}`), legalLinks('client'));
  })();
  return root;
}

/** Formulaire public : accès, correction, suppression ou opposition sur ses données personnelles. */
export function dataRequestView() {
  const kind = h('select', {}, [['access', 'Je veux savoir quelles données vous avez sur moi'], ['rectification', 'Je veux corriger une information'], ['erasure', 'Je veux supprimer mon compte et mes données'], ['opposition', 'Je m\'oppose à l\'utilisation de mes données']].map(([v, l]) => h('option', { value: v }, l)));
  const name = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX', autocomplete: 'tel' });
  const msg = h('textarea', { maxlength: 1000, rows: 3, placeholder: 'Précisions (facultatif)' });
  const out = h('div', { role: 'status' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try { const r = await post('/public/data-request', { kind: kind.value, name: name.value, phone: phone.value, message: msg.value }); form.classList.add('hidden'); out.replaceChildren(h('div', { class: 'notice ok' }, r.message), h('a', { class: 'btn btn-gold btn-block', href: '#/login' }, 'Retour')); }
    catch (ex) { errToast(ex); btn.disabled = false; }
  } }, h('h1', {}, 'Mes données personnelles'),
    h('p', { class: 'small' }, 'Faites votre demande ici, gratuitement. Pour vous protéger, un conseiller vous rappellera au numéro indiqué avant de répondre (sous 30 jours).'),
    field('Ma demande', kind), field('Mon nom', name), field('Le numéro de téléphone utilisé sur Wallindirain', phone), field('Précisions', msg),
    h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Envoyer ma demande'));
  return shell(h('div', { class: 'card' }, form, out), h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, '← Retour')));
}
