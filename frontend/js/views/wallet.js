// Portefeuille et retraits : commun au vendeur, fournisseur, agent, chef et livreur.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, table, badge, amount, action, WALLET_KIND, empty, toast, proofButton } from '../ui.js';
import { get, post } from '../api.js';
import { startIdentityFlow } from './kyc.js';
import { receiptButton } from './invoices.js';

const WD_STATUS = { pending_code: ['Expiré', 'grey'], requested: ['En attente de validation', 'warn'], paid: ['Payé', 'ok'], rejected: ['Refusé', 'bad'], expired: ['Expiré', 'grey'] };
const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };

export function walletView() {
  return liveView(() => get('/wallet'), (w, refresh) => {
    const hasPayout = !!(w.payout && w.payout.phone);
    const free = w.available - (w.reserved || 0);
    // comptes sans numéro de versement : à enregistrer une seule fois (mot de passe demandé)
    const setPayout = action(async () => {
      const v = await ask({ title: 'Numéro de versement', text: 'Votre argent sera toujours envoyé sur ce numéro. Vous ne pourrez plus le changer vous-même : seule l\'administration le peut.', submit: 'Enregistrer', fields: [
        { name: 'method', label: 'Opérateur', type: 'select', options: Object.entries(OPERATOR) },
        { name: 'phone', label: 'Numéro Mobile Money', type: 'tel', inputmode: 'numeric', placeholder: '6XX XX XX XX' },
        { name: 'password', label: 'Votre mot de passe (pour confirmer)', type: 'password' }] });
      if (v) await post('/me/payout', v);
    }, { ok: 'Numéro de versement enregistré', refresh });
    const withdraw = action(async () => {
      if (!w.identity_verified) {
        // la vérification d'identité n'est demandée qu'ici, au moment où elle devient utile
        if (w.kyc_status?.status === 'submitted') { toast('Votre pièce d\'identité est en cours d\'examen : le retrait sera possible dès la validation.', 'ok'); return; }
        const sent = await startIdentityFlow({ intro: 'Pour votre premier retrait, nous devons vérifier votre identité. Vous ne le ferez qu\'une seule fois.' });
        if (sent) await refresh();
        return;
      }
      if (!hasPayout) { toast('Enregistrez d\'abord votre numéro de versement.', 'bad'); return; }
      const v = await ask({ title: 'Demander un retrait', text: `Disponible : ${fmtGNF(free)}. Minimum ${fmtGNF(w.min_withdrawal)}. Après validation par l\'administration, l\'argent sera envoyé sur ${OPERATOR[w.payout.method]} ${fmtPhone(w.payout.phone)} avec une capture du transfert, et le montant sera débité à ce moment-là.`, submit: 'Envoyer la demande', fields: [
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' }] });
      if (!v) return;
      await post('/withdrawals', { amount: Number(v.amount) });
      toast('Demande envoyée : l\'administration va la vérifier puis vous payer.', 'ok'); await refresh();
    });
    return h('div', {}, h('h1', {}, 'Portefeuille'),
      h('div', { class: 'balance mb' }, h('div', { class: 'sub' }, 'Disponible pour retrait'), h('div', { class: 'big' }, fmtGNF(free)),
        w.reserved > 0 && h('div', { class: 'sub' }, `${fmtGNF(w.reserved)} réservés pour vos demandes de retrait en attente (débités quand l'argent est envoyé)`),
        w.pending > 0 && h('div', { class: 'sub' }, `+ ${fmtGNF(w.pending)} bientôt disponibles (délai de sécurité après livraison)`),
        h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: withdraw }, 'Demander un retrait'))),
      w.subscription && w.subscription.monthly > 0 && h('div', { class: w.subscription.active ? 'notice' : 'notice bad' }, w.subscription.required
        ? (w.subscription.active ? `Abonnement : ${fmtGNF(w.subscription.monthly)} par mois. ${w.subscription.paid_until && new Date(w.subscription.paid_until) > new Date() ? `Payé jusqu'au ${new Date(w.subscription.paid_until).toLocaleDateString('fr-FR')}.` : `Période d'essai jusqu'au ${new Date(w.subscription.trial_until).toLocaleDateString('fr-FR')}.`}` : `Abonnement expiré : ${fmtGNF(w.subscription.monthly)} par mois. Contactez Wallindirain pour le renouveler, sinon vous ne pouvez plus créer de commandes.`)
        : `Abonnement mensuel disponible : ${fmtGNF(w.subscription.monthly)}.`),
      !w.identity_verified && (w.kyc_status?.status === 'submitted'
        ? h('div', { class: 'notice warn' }, 'Vos photos de pièce d\'identité sont en cours d\'examen : les retraits sont possibles dès qu\'elles sont validées.')
        : w.kyc_status?.status === 'rejected'
          ? h('div', { class: 'notice bad' }, `Votre pièce a été refusée : ${w.kyc_status.reject_reason || 'motif non précisé'}. `, h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: action(async () => { if (await startIdentityFlow({})) await refresh(); }) }, 'Renvoyer mes photos'))
          : null),
      hasPayout
        ? h('div', { class: 'notice' }, `Numéro de versement : ${OPERATOR[w.payout.method]} · ${fmtPhone(w.payout.phone)}. `, h('a', { href: '#/app/profile' }, 'Le modifier dans Profil'))
        : h('div', { class: 'notice warn' }, 'Aucun numéro de versement enregistré. ', h('button', { class: 'btn btn-sm btn-gold', onclick: setPayout }, 'Enregistrer mon numéro')),
      h('div', { class: 'card' }, h('h2', {}, 'Mes retraits'), table(['Date', 'Montant', 'Via', 'Statut', 'Référence', ''], w.withdrawals.map((x) => [
        fmtDate(x.created_at), amount(x.amount), `${OPERATOR[x.method]} · ${fmtPhone(x.account_number)}`, badge(...WD_STATUS[x.status]), x.payment_ref || '', h('div', { class: 'gap' }, proofButton(x.proof_id, 'Preuve du transfert'), x.status === 'paid' && receiptButton(x.id))]),
        { empty: empty('💸', 'Aucun retrait pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mouvements'), table(['Date', 'Opération', 'Montant', 'Disponible'], w.entries.map((e) => [
        fmtDate(e.created_at), h('div', {}, WALLET_KIND[e.kind] || e.kind, e.description && h('div', { class: 'small muted' }, e.description)), amount(e.amount, true),
        e.locked ? badge(`le ${fmtDate(e.available_at)}`, 'warn') : badge('Oui', 'ok')]), { empty: empty('📒', 'Aucun mouvement') })));
  });
}
