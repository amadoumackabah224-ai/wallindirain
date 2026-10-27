// Vérification d'identité (KYC) : la personne envoie les photos de sa pièce ; l'administrateur les examine puis valide ou refuse.
// Les images ne sont visibles que du propriétaire et des administrateurs ; chaque consultation est enregistrée dans le journal de l'administration (jamais montrée aux autres utilisateurs).
import { h, ask, liveView, action, badge, errToast, toast } from '../ui.js';
import { get, post } from '../api.js';

const TYPES = [['cni', 'Carte d\'identité'], ['passeport', 'Passeport'], ['autre', 'Autre pièce officielle']];
export const KYC_BADGE = { none: ['Non envoyée', 'warn'], draft: ['Incomplète', 'warn'], submitted: ['En cours d\'examen', 'info'], verified: ['Vérifiée', 'ok'], rejected: ['Refusée', 'bad'] };
const SIDE = { front: 'recto', back: 'verso', selfie: 'selfie' };

/** Ouvre la fenêtre d'envoi de la pièce, puis envoie les photos. Renvoie vrai si la pièce a été envoyée. `intro` précise pourquoi on la demande. */
async function collectAndSend(k, intro) {
  const fields = [
    { name: 'doc_type', label: 'Type de pièce', type: 'select', value: k.doc_type, options: TYPES },
    { name: 'number', label: 'Numéro de la pièce', maxlength: 60, value: k.doc_number || '', hint: 'Tel qu\'il est écrit sur la pièce.' },
    { name: 'front', label: 'Photo du recto de la pièce (face avec votre photo)', type: 'image', hint: 'Photo nette, pièce entière, sans reflet, texte lisible.' },
    { name: 'back', label: 'Photo du verso (facultatif pour un passeport)', type: 'image', required: false, hint: 'Face arrière de la carte.' },
    { name: 'selfie', label: 'Selfie en tenant votre pièce à côté de votre visage', type: 'image', hint: 'Votre visage et la pièce doivent être bien visibles.' }];
  const v = await ask({ title: 'Vérifier mon identité', text: (intro ? intro + ' ' : '') + 'Ces photos servent uniquement à vérifier que vous êtes bien la personne qui reçoit l\'argent. Seule l\'administration y a accès ; chaque accès est enregistré dans le journal de l\'administration. Elles sont effacées si votre compte est supprimé.', submit: 'Envoyer pour vérification', fields });
  if (!v) return false;
  await post('/me/identity', { identity_doc: v.number });
  await post('/me/identity/image', { side: 'front', doc_type: v.doc_type, image: v.front });
  if (v.back) await post('/me/identity/image', { side: 'back', doc_type: v.doc_type, image: v.back });
  await post('/me/identity/image', { side: 'selfie', doc_type: v.doc_type, image: v.selfie });
  await post('/me/identity/submit');
  return true;
}

/** Démarre la vérification au moment où elle devient utile (premier retrait). Renvoie vrai si la pièce a été envoyée. */
export async function startIdentityFlow({ intro } = {}) {
  try {
    const k = await get('/me/identity');
    if (k.status === 'submitted' || k.status === 'verified') return false;
    const sent = await collectAndSend(k, intro);
    if (sent) toast('Pièce envoyée : l\'administration va la vérifier. Vous serez prévenu dès la décision.', 'ok');
    return sent;
  } catch (e) { errToast(e); return false; }
}

/** Carte « Vérification d'identité » du profil. Elle s'efface une fois la pièce envoyée ; elle ne revient que si la pièce est refusée. */
export function kycCard(userId, { onChange } = {}) {
  return liveView(() => get('/me/identity'), (k, refresh) => {
    const done = async () => { await refresh(); onChange?.(); };
    const send = action(async () => { await collectAndSend(k); }, { ok: 'Pièce envoyée : l\'administration va la vérifier', refresh: done });
    // Identité vérifiée : plus rien à faire, la section disparaît.
    if (k.status === 'verified') return h('div', {});
    // Pièce envoyée : une simple ligne d'état (plus de formulaire), qui disparaît à la décision.
    if (k.status === 'submitted') return h('div', { class: 'alert-row' }, h('span', { class: 'grow' }, 'Votre pièce d\'identité est en cours d\'examen. Vous serez prévenu dès la décision.'));
    // Jamais envoyée : on ne harcèle pas ; elle sera demandée au premier retrait. Un petit lien reste pour ceux qui veulent le faire à l'avance.
    if (k.status === 'none' || k.status === 'draft') {
      return h('div', { class: 'card' }, h('h2', {}, 'Vérification d\'identité'),
        h('p', { class: 'small muted' }, 'Elle vous sera demandée une seule fois, au moment de votre premier retrait d\'argent. Vous pouvez aussi la faire dès maintenant.'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: send }, 'Vérifier mon identité maintenant'));
    }
    // Refusée : le motif et un bouton pour recommencer.
    return h('div', { class: 'card' }, h('h2', {}, 'Vérification d\'identité'),
      h('div', { class: 'notice bad' }, `Pièce refusée : ${k.reject_reason || 'motif non précisé'}. Envoyez de nouvelles photos.`),
      h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: send }, 'Renvoyer mes photos')));
  });
}

/** Fenêtre d'examen pour l'administrateur : les images, puis Valider ou Refuser. Ouvrir les images est enregistré. */
export function reviewIdentity(u, onDone) {
  const opener = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); opener?.isConnected && opener.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const fig = (side) => h('figure', { class: 'kyc-big' }, h('img', { src: `/api/identity/${u.id}/${side}?t=${Date.now()}`, alt: `${SIDE[side]} de la pièce de ${u.full_name}` }), h('figcaption', { class: 'small' }, SIDE[side]));
  const verify = action(async () => { await post(`/admin/users/${u.id}/verify`, { verified: true }); close(); }, { ok: 'Identité vérifiée', refresh: onDone });
  const reject = async () => {
    const v = await ask({ title: 'Refuser la pièce', text: 'Expliquez simplement pourquoi : la personne verra ce motif et pourra renvoyer de meilleures photos.', submit: 'Refuser', danger: true, fields: [{ name: 'reason', label: 'Motif', maxlength: 300, placeholder: 'Ex. photo floue, selfie sans la pièce…' }] });
    if (!v) return;
    try { await post(`/admin/users/${u.id}/reject-identity`, { reason: v.reason }); toast('Pièce refusée', 'ok'); close(); await onDone?.(); } catch (e) { errToast(e); }
  };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kyc-title' },
      h('h2', { id: 'kyc-title' }, `Pièce d'identité de ${u.full_name}`),
      h('p', { class: 'small muted' }, `Numéro déclaré : ${u.identity_doc || 'aucun'} · Statut : ${(KYC_BADGE[u.kyc_status || 'none'] || KYC_BADGE.none)[0]}. Comparez le visage du selfie avec la photo de la pièce et le nom avec celui du compte. L'ouverture de ces images est enregistrée.`),
      h('div', { class: 'kyc-grid' }, fig('front'), u.kyc_back && fig('back'), fig('selfie')),
      h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-ok grow', onclick: verify }, 'Valider l\'identité'),
        h('button', { class: 'btn btn-bad', onclick: reject }, 'Refuser'), h('button', { class: 'btn btn-ghost', onclick: close }, 'Fermer'))));
  document.body.append(overlay); document.addEventListener('keydown', onKey);
  overlay.querySelector('button')?.focus();
}
