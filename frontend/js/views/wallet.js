// Portefeuille et retraits : commun au vendeur, fournisseur, agent, chef et livreur.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, table, badge, amount, action, WALLET_KIND, empty, toast, proofButton } from '../ui.js';
import { get, post } from '../api.js';

const WD_STATUS = { pending_code: ['Code à saisir', 'warn'], requested: ['En attente de paiement', 'warn'], paid: ['Payé', 'ok'], rejected: ['Refusé', 'bad'], expired: ['Expiré', 'grey'] };
const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };

export function walletView() {
  return liveView(() => get('/wallet'), (w, refresh) => {
    const hasPayout = !!(w.payout && w.payout.phone);
    // comptes sans numéro de versement : à enregistrer une seule fois (mot de passe demandé)
    const setPayout = action(async () => {
      const v = await ask({ title: 'Numéro de versement', text: 'Votre argent sera toujours envoyé sur ce numéro. Vous ne pourrez plus le changer vous-même : seule l\'administration le peut.', submit: 'Enregistrer', fields: [
        { name: 'method', label: 'Opérateur', type: 'select', options: Object.entries(OPERATOR) },
        { name: 'phone', label: 'Numéro Mobile Money', type: 'tel', inputmode: 'numeric', placeholder: '6XX XX XX XX' },
        { name: 'password', label: 'Votre mot de passe (pour confirmer)', type: 'password' }] });
      if (v) await post('/me/payout', v);
    }, { ok: 'Numéro de versement enregistré', refresh });
    const addDoc = action(async () => {
      const v = await ask({ title: 'Pièce d\'identité', text: 'Saisissez le numéro de votre carte d\'identité ou passeport. Il est vérifié par l\'administration avant votre premier retrait ; aucune photo n\'est demandée.', submit: 'Envoyer', fields: [{ name: 'identity_doc', label: 'Numéro de la pièce', maxlength: 60, placeholder: 'Ex. CNI ou passeport : numéro' }] });
      if (v) await post('/me/identity', v);
    }, { ok: 'Pièce enregistrée, en attente de vérification', refresh });
    const withdraw = action(async () => {
      if (!w.identity_verified) { toast('Votre pièce d\'identité doit d\'abord être vérifiée par Wallindirain.', 'bad'); return; }
      if (!hasPayout) { toast('Enregistrez d\'abord votre numéro de versement.', 'bad'); return; }
      const v = await ask({ title: 'Retirer de l\'argent', text: `Disponible : ${fmtGNF(w.available)}. Minimum ${fmtGNF(w.min_withdrawal)}. L\'argent sera envoyé sur ${OPERATOR[w.payout.method]} ${fmtPhone(w.payout.phone)}.`, submit: 'Recevoir le code', fields: [
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' }] });
      if (!v) return;
      const r = await post('/withdrawals', { amount: Number(v.amount) });
      const c = await ask({ title: 'Code de confirmation', text: r.message, submit: 'Confirmer le retrait', fields: [{ name: 'code', label: 'Code à 6 chiffres', inputmode: 'numeric', maxlength: 6, code: true }] });
      if (!c) { toast('Retrait non confirmé : rien n\'a été débité.'); return; }
      await post(`/withdrawals/${r.id}/confirm`, { code: c.code });
      toast('Retrait demandé. Wallindirain va effectuer le paiement.', 'ok'); await refresh();
    });
    return h('div', {}, h('h1', {}, 'Portefeuille'),
      h('div', { class: 'balance mb' }, h('div', { class: 'sub' }, 'Disponible pour retrait'), h('div', { class: 'big' }, fmtGNF(w.available)),
        w.pending > 0 && h('div', { class: 'sub' }, `+ ${fmtGNF(w.pending)} bientôt disponibles (délai de sécurité après livraison)`),
        h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: withdraw }, 'Retirer de l\'argent'))),
      !w.identity_verified && (w.identity_submitted
        ? h('div', { class: 'notice warn' }, 'Pièce d\'identité en cours de vérification : les retraits sont possibles dès qu\'elle est validée.')
        : (['seller', 'supplier'].includes(w.role) ? h('div', { class: 'notice warn' }, 'Pour retirer de l\'argent, ajoutez le numéro de votre pièce d\'identité (aucune photo demandée). ', h('button', { class: 'btn btn-sm btn-gold', onclick: addDoc }, 'Ajouter ma pièce')) : h('div', { class: 'notice warn' }, 'Votre identité doit être vérifiée par l\'administration avant un retrait.'))),
      hasPayout
        ? h('div', { class: 'notice' }, `Numéro de versement : ${OPERATOR[w.payout.method]} · ${fmtPhone(w.payout.phone)}. `, h('a', { href: '#/app/profile' }, 'Le modifier dans Profil'))
        : h('div', { class: 'notice warn' }, 'Aucun numéro de versement enregistré. ', h('button', { class: 'btn btn-sm btn-gold', onclick: setPayout }, 'Enregistrer mon numéro')),
      h('div', { class: 'card' }, h('h2', {}, 'Mes retraits'), table(['Date', 'Montant', 'Via', 'Statut', 'Référence', ''], w.withdrawals.map((x) => [
        fmtDate(x.created_at), amount(x.amount), `${OPERATOR[x.method]} · ${fmtPhone(x.account_number)}`, badge(...WD_STATUS[x.status]), x.payment_ref || '', proofButton(x.proof_id, 'Preuve du transfert')]),
        { empty: empty('💸', 'Aucun retrait pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mouvements'), table(['Date', 'Opération', 'Montant', 'Disponible'], w.entries.map((e) => [
        fmtDate(e.created_at), h('div', {}, WALLET_KIND[e.kind] || e.kind, e.description && h('div', { class: 'small muted' }, e.description)), amount(e.amount, true),
        e.locked ? badge(`le ${fmtDate(e.available_at)}`, 'warn') : badge('Oui', 'ok')]), { empty: empty('📒', 'Aucun mouvement') })));
  });
}
