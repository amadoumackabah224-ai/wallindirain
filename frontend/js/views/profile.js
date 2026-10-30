// Profil : nom, photo, mot de passe, numéro de versement, accès à mes droits sur mes données.
import { h, ask, fmtPhone, payoutText, fmtDate, liveView, action, avatar, compressImage, errToast, toast, kv, ROLE_LABEL, showLegal, getTheme, setTheme } from '../ui.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { kycCard } from './kyc.js';
import { referralCard } from './stats.js';
import { installCard } from '../pwa.js';

const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };
const PAYOUT_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

export function profileView({ onChanged }) {
  let ver = Date.now();
  const opened = new Set(); // rubriques ouvertes
  return liveView(() => get('/me/profile'), (p, refresh) => {
    const changed = async () => { ver = Date.now(); await refresh(); onChanged?.(); };
    const pick = h('input', { type: 'file', accept: 'image/*', class: 'hidden', 'aria-label': 'Choisir une photo de profil', tabindex: '-1', onchange: async (e) => {
      try {
        const img = await compressImage(e.target.files[0], 256);
        await post('/me/avatar', { image: img });
        toast('Photo enregistrée', 'ok'); await changed();
      } catch (ex) { errToast(ex); }
    } });
    const rename = action(async () => {
      const v = await ask({ title: 'Modifier mon nom', submit: 'Enregistrer', fields: [{ name: 'name', label: 'Nom complet', value: p.name, maxlength: 100 }] });
      if (v) await post('/me/profile', { name: v.name });
    }, { ok: 'Nom modifié', refresh: changed });
    const removePhoto = action(async () => { await post('/me/avatar/delete'); }, { ok: 'Photo supprimée', refresh: changed });
    const changePw = action(async () => {
      const v = await ask({ title: 'Changer mon mot de passe', submit: 'Changer', fields: [
        { name: 'current', label: 'Ancien mot de passe', type: 'password' },
        { name: 'next', label: 'Nouveau mot de passe', type: 'password', hint: '8 caractères minimum, avec des lettres et des chiffres.' }] });
      if (v) await post('/me/password', v);
    }, { ok: 'Mot de passe changé. Vos autres appareils sont déconnectés.' });
    const foreign = (p.phone || '').startsWith('+');
    const changePayout = action(async () => {
      const v = await ask({ title: p.payout ? 'Changer mon numéro de versement' : 'Enregistrer mon numéro de versement',
        text: p.payout ? `Coordonnées actuelles : ${payoutText(p.payout.method, p.payout.phone)}. Un message d\'alerte sera envoyé.` : 'Votre argent sera envoyé sur ce numéro.',
        submit: 'Enregistrer', fields: [
          { name: 'method', label: 'Opérateur', type: 'select', value: p.payout?.method || 'orange_money', options: Object.entries(foreign ? { ...OPERATOR, other: 'Autre (j\'écris mes coordonnées)' } : OPERATOR) },
          { name: 'phone', label: foreign ? 'Nouveau numéro Mobile Money, ou mes coordonnées (opérateur, pays, numéro ou IBAN)' : 'Nouveau numéro Mobile Money', type: foreign ? 'text' : 'tel', inputmode: foreign ? 'text' : 'numeric', placeholder: foreign ? 'Ex. Wave Sénégal 77 123 45 67' : '6XX XX XX XX' },
          { name: 'password', label: 'Votre mot de passe (pour confirmer)', type: 'password' }] });
      if (v) await post('/me/payout/change', { method: v.method, phone: v.phone, password: v.password });
    }, { ok: 'Numéro de versement enregistré', refresh: changed });

    const setEmail = action(async () => {
      const v = await ask({ title: p.email ? 'Changer mon adresse e-mail' : 'Ajouter mon adresse e-mail',
        text: 'Un code de confirmation sera envoyé à cette adresse. Tant qu\'elle n\'est pas confirmée, elle ne sert ni à se connecter ni à récupérer le mot de passe.',
        submit: 'Envoyer le code', fields: [
          { name: 'email', label: 'Adresse e-mail', type: 'email', placeholder: 'nom@exemple.com', maxlength: 254 },
          { name: 'password', label: 'Votre mot de passe (pour confirmer)', type: 'password' }] });
      if (v) { await post('/me/email', { email: v.email, password: v.password }); await confirmEmail(); }
    }, { ok: 'Code envoyé : regardez votre boîte e-mail', refresh: changed });
    async function confirmEmail() {
      const v = await ask({ title: 'Confirmer mon adresse e-mail', text: 'Saisissez le code à 6 chiffres reçu par e-mail (valable 30 minutes). Pensez aux courriers indésirables.',
        submit: 'Confirmer', fields: [{ name: 'code', label: 'Code reçu', inputmode: 'numeric', maxlength: 6 }] });
      if (v) await post('/me/email/verify', { code: v.code });
    }
    const verifyEmail = action(confirmEmail, { ok: 'Adresse e-mail confirmée', refresh: changed });
    const resendEmail = action(async () => { await post('/me/email/resend'); }, { ok: 'Nouveau code envoyé', refresh: changed });

    // chaque rubrique est une ligne qu'on ouvre d'un geste ; l'état ouvert/fermé est gardé quand la page se rafraîchit
    const row = (key, ico, title, sub, ...body) => h('details', { class: 'set', open: opened.has(key), ontoggle: (e) => { e.target.open ? opened.add(key) : opened.delete(key); } },
      h('summary', { class: 'set-row' }, h('span', { class: 'set-ico' }, icon(ico, 20)),
        h('span', { class: 'grow' }, h('b', {}, title), sub ? h('span', { class: 'set-sub' }, sub) : null), icon('chevronDown', 18)),
      h('div', { class: 'set-body' }, ...body));

    return h('div', {}, h('h1', {}, 'Mon profil'),
      h('div', { class: 'card profile-head' }, avatar({ id: p.id, name: p.name, has_avatar: p.has_avatar }, 72, ver),
        h('div', { class: 'grow' }, h('h2', {}, p.name), h('div', { class: 'muted' }, ROLE_LABEL[p.role], p.team ? ` · ${p.team}` : ''), h('div', { class: 'muted small' }, fmtPhone(p.phone)),
          h('div', { class: 'gap mt' }, pick,
            h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: () => pick.click() }, p.has_avatar ? 'Changer la photo' : 'Ajouter une photo'),
            p.has_avatar && h('button', { class: 'btn btn-sm btn-ghost', onclick: removePhoto }, 'Supprimer la photo')),
          h('p', { class: 'small muted' }, 'La photo est facultative. Seuls vous et l\'administration la voyez.'))),
      PAYOUT_ROLES.includes(p.role) && kycCard(p.id),
      h('div', { class: 'set-list' },
        row('infos', 'user', 'Mes informations', `${p.name} · membre depuis ${fmtDate(p.created_at)}`,
          kv([['Nom', p.name], ['Téléphone de connexion', fmtPhone(p.phone)], ['Membre depuis', fmtDate(p.created_at)]]),
          h('p', { class: 'small muted' }, 'Le numéro de connexion ne peut pas être changé ici : contactez l\'équipe (bouton Aide) si vous avez changé de numéro.'),
          h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: rename }, 'Modifier mon nom'))),
        p.email_enabled && row('email', 'inbox', 'Adresse e-mail', p.email ? (p.email_verified ? 'Confirmée' : 'À confirmer') : 'Non renseignée',
          p.email ? h('p', {}, h('b', {}, p.email), ' ', h('span', { class: p.email_verified ? 'badge ok' : 'badge warn' }, p.email_verified ? 'Confirmée' : 'À confirmer'))
            : h('p', { class: 'muted' }, 'Aucune adresse e-mail enregistrée.'),
          h('p', { class: 'small muted' }, p.email_verified ? 'Vous pouvez vous connecter avec cette adresse, et vos codes (mot de passe oublié) arrivent dans votre boîte e-mail.'
            : 'Une fois confirmée, vous pourrez vous connecter avec elle et recevoir vos codes de mot de passe oublié dans votre boîte e-mail.'),
          h('div', { class: 'gap' },
            p.email && !p.email_verified && h('button', { class: 'btn btn-sm btn-gold', onclick: verifyEmail }, 'Saisir le code reçu'),
            p.email && !p.email_verified && h('button', { class: 'btn btn-sm btn-ghost', onclick: resendEmail }, 'Renvoyer le code'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: setEmail }, p.email ? 'Changer mon adresse' : 'Ajouter mon adresse'))),
        PAYOUT_ROLES.includes(p.role) && row('payout', 'phoneMoney', 'Numéro de versement', p.payout ? payoutText(p.payout.method, p.payout.phone) : 'Aucun numéro enregistré',
          p.payout ? h('p', {}, h('b', {}, payoutText(p.payout.method, p.payout.phone))) : h('p', { class: 'muted' }, 'Aucun numéro enregistré.'),
          h('p', { class: 'small muted' }, 'Ce numéro sert uniquement à vous verser votre argent.'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: changePayout }, p.payout ? 'Changer mon numéro' : 'Enregistrer mon numéro')),
        row('theme', getTheme() === 'dark' ? 'moon' : 'sun', 'Apparence', { auto: 'Selon mon téléphone', light: 'Clair', dark: 'Sombre' }[getTheme()], themePicker(() => refresh())),
        row('security', 'shield', 'Sécurité', 'Mot de passe',
          h('p', { class: 'muted small' }, 'Changer votre mot de passe déconnecte vos autres appareils.'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: changePw }, 'Changer mon mot de passe')),
        row('legal', 'scroll', 'Confidentialité et conditions', 'Mes documents · exercer mes droits',
          documentsBody(),
          h('p', { class: 'small' }, 'Vous pouvez demander l\'accès à vos données, leur correction ou la suppression de votre compte.'),
          h('a', { class: 'btn btn-sm btn-ghost', href: '#/demande-donnees' }, 'Exercer mes droits'))),
      installCard(),
      ['seller', 'supplier'].includes(p.role) && referralCard());
  });
}

/** Choix de l'apparence : trois boutons, appliqués tout de suite et gardés sur cet appareil. */
function themePicker(after) {
  const cur = getTheme();
  const opts = [['auto', 'Selon mon téléphone', 'settings'], ['light', 'Clair', 'sun'], ['dark', 'Sombre', 'moon']];
  return h('div', {}, h('div', { class: 'tp', role: 'group', 'aria-label': 'Apparence de l\'application' },
    opts.map(([v, label, ico]) => h('button', { type: 'button', class: 'tp-btn', 'aria-pressed': String(cur === v), onclick: () => { setTheme(v); after(); } }, icon(ico, 18), h('span', {}, label)))),
  h('p', { class: 'small muted' }, 'Ce choix est gardé sur cet appareil. « Selon mon téléphone » suit le réglage clair ou sombre de votre téléphone.'));
}

/** « Mes documents » : uniquement les textes du rôle de la personne, avec la version qu'elle a acceptée. */
function documentsBody() {
  return liveView(() => get('/me/legal'), (m) => {
    const many = new Set(m.pages.map((p) => p.audience).filter((a) => a !== 'public')).size > 1;
    const AUD = { client: 'client', seller: 'vendeur', supplier: 'fournisseur', courier: 'livreur', team: 'équipe' };
    return h('div', {},
      h('p', { class: 'small muted' }, m.accepted_at ? `Version acceptée : ${m.accepted_version} (le ${fmtDate(m.accepted_at)}).` : (m.pending ? 'Vous n\'avez pas encore accepté les textes.' : 'Aucun accord demandé pour ce compte.')),
      h('div', { class: 'list' }, m.pages.map((p) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, many && p.audience !== 'public' ? `${p.title} (${AUD[p.audience]})` : p.title),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => showLegal(p.slug, p.audience === 'public' ? undefined : p.audience) }, 'Lire')))));
  });
}
