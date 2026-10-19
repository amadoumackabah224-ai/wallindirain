// Profil : nom, photo, mot de passe, numéro de versement, accès à mes droits sur mes données.
import { h, ask, fmtPhone, fmtDate, liveView, action, avatar, compressImage, errToast, toast, kv, ROLE_LABEL, legalLinks } from '../ui.js';
import { get, post } from '../api.js';

const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };
const PAYOUT_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

export function profileView({ onChanged }) {
  let ver = Date.now();
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
    const changePayout = action(async () => {
      const v = await ask({ title: p.payout ? 'Changer mon numéro de versement' : 'Enregistrer mon numéro de versement',
        text: p.payout ? `Numéro actuel : ${OPERATOR[p.payout.method]} · ${fmtPhone(p.payout.phone)}. L\'ancien numéro recevra un message d\'alerte.` : 'Votre argent sera envoyé sur ce numéro.',
        submit: 'Enregistrer', fields: [
          { name: 'method', label: 'Opérateur', type: 'select', value: p.payout?.method || 'orange_money', options: Object.entries(OPERATOR) },
          { name: 'phone', label: 'Nouveau numéro Mobile Money', type: 'tel', inputmode: 'numeric', placeholder: '6XX XX XX XX' },
          { name: 'password', label: 'Votre mot de passe (pour confirmer)', type: 'password' }] });
      if (v) await post('/me/payout/change', { method: v.method, phone: v.phone, password: v.password });
    }, { ok: 'Numéro de versement enregistré', refresh: changed });

    return h('div', {}, h('h1', {}, 'Mon profil'),
      h('div', { class: 'card profile-head' }, avatar({ id: p.id, name: p.name, has_avatar: p.has_avatar }, 72, ver),
        h('div', { class: 'grow' }, h('h2', {}, p.name), h('div', { class: 'muted' }, ROLE_LABEL[p.role], p.team ? ` · ${p.team}` : ''),
          h('div', { class: 'gap mt' }, pick,
            h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: () => pick.click() }, p.has_avatar ? 'Changer la photo' : 'Ajouter une photo'),
            p.has_avatar && h('button', { class: 'btn btn-sm btn-ghost', onclick: removePhoto }, 'Supprimer la photo')),
          h('p', { class: 'small muted' }, 'La photo est facultative. Seuls vous et l\'administration la voyez.'))),
      h('div', { class: 'card' }, h('h2', {}, 'Mes informations'),
        kv([['Nom', p.name], ['Téléphone de connexion', fmtPhone(p.phone)], ['Membre depuis', fmtDate(p.created_at)]]),
        h('p', { class: 'small muted' }, 'Le numéro de connexion ne peut pas être changé ici : contactez l\'équipe (bouton Aide) si vous avez changé de numéro.'),
        h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: rename }, 'Modifier mon nom'))),
      PAYOUT_ROLES.includes(p.role) && h('div', { class: 'card' }, h('h2', {}, 'Numéro de versement'),
        p.payout ? h('p', {}, `${OPERATOR[p.payout.method]} · `, h('b', {}, fmtPhone(p.payout.phone))) : h('p', { class: 'muted' }, 'Aucun numéro enregistré.'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: changePayout }, p.payout ? 'Changer mon numéro' : 'Enregistrer mon numéro')),
      h('div', { class: 'card' }, h('h2', {}, 'Sécurité'), h('p', { class: 'muted small' }, 'Changer votre mot de passe déconnecte vos autres appareils.'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: changePw }, 'Changer mon mot de passe')),
      h('div', { class: 'card' }, h('h2', {}, 'Mes données'), h('p', { class: 'small' }, 'Vous pouvez demander l\'accès à vos données, leur correction ou la suppression de votre compte.'),
        h('a', { class: 'btn btn-sm btn-ghost', href: '#/demande-donnees' }, 'Exercer mes droits'), legalLinks()));
  });
}
