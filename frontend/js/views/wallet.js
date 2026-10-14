// Portefeuille et retraits : commun au vendeur, fournisseur, agent, chef et livreur.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, table, badge, amount, action, WALLET_KIND, empty, toast } from '../ui.js';
import { get, post } from '../api.js';

const WD_STATUS = { pending_code: ['Code à saisir', 'warn'], requested: ['En attente de paiement', 'warn'], paid: ['Payé', 'ok'], rejected: ['Refusé', 'bad'], expired: ['Expiré', 'grey'] };

export function walletView() {
  return liveView(() => get('/wallet'), (w, refresh) => {
    const withdraw = action(async () => {
      if (!w.identity_verified) { toast('Votre pièce d\'identité doit d\'abord être vérifiée par Wallindirain.', 'bad'); return; }
      const v = await ask({ title: 'Retirer de l\'argent', text: `Disponible : ${fmtGNF(w.available)}. Minimum 50 000 GNF.`, submit: 'Recevoir le code', fields: [
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' },
        { name: 'method', label: 'Recevoir sur', type: 'select', options: [['orange_money', 'Orange Money'], ['mtn_momo', 'MTN MoMo']] },
        { name: 'account', label: 'Numéro Mobile Money', type: 'tel', inputmode: 'numeric', placeholder: '6XX XX XX XX' }] });
      if (!v) return;
      const r = await post('/withdrawals', { amount: Number(v.amount), method: v.method, account: v.account });
      const c = await ask({ title: 'Code de confirmation', text: r.message, submit: 'Confirmer le retrait', fields: [{ name: 'code', label: 'Code à 6 chiffres', inputmode: 'numeric', maxlength: 6, code: true }] });
      if (!c) { toast('Retrait non confirmé : rien n\'a été débité.'); return; }
      await post(`/withdrawals/${r.id}/confirm`, { code: c.code });
      toast('Retrait demandé. Wallindirain va effectuer le paiement.', 'ok'); await refresh();
    });
    return h('div', {},
      h('div', { class: 'balance mb' }, h('div', { class: 'sub' }, 'Disponible pour retrait'), h('div', { class: 'big' }, fmtGNF(w.available)),
        w.pending > 0 && h('div', { class: 'sub' }, `+ ${fmtGNF(w.pending)} bientôt disponibles (délai de sécurité après livraison)`),
        h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: withdraw }, 'Retirer de l\'argent'))),
      !w.identity_verified && h('div', { class: 'notice warn' }, 'Pièce d\'identité en cours de vérification : les retraits sont possibles dès qu\'elle est validée.'),
      h('div', { class: 'card' }, h('h2', {}, 'Mes retraits'), table(['Date', 'Montant', 'Via', 'Statut', 'Référence'], w.withdrawals.map((x) => [
        fmtDate(x.created_at), amount(x.amount), `${x.method === 'orange_money' ? 'Orange Money' : 'MTN MoMo'} · ${fmtPhone(x.account_number)}`, badge(...WD_STATUS[x.status]), x.payment_ref || '']),
        { empty: empty('💸', 'Aucun retrait pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mouvements'), table(['Date', 'Opération', 'Montant', 'Disponible'], w.entries.map((e) => [
        fmtDate(e.created_at), h('div', {}, WALLET_KIND[e.kind] || e.kind, e.description && h('div', { class: 'small muted' }, e.description)), amount(e.amount, true),
        e.locked ? badge(`le ${fmtDate(e.available_at)}`, 'warn') : badge('Oui', 'ok')]), { empty: empty('📒', 'Aucun mouvement') })));
  });
}
