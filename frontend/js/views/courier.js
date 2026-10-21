// Espace livreur : récupérer, livrer avec le code du client, signaler un échec.
import { h, ask, confirmBox, fmtGNF, fmtDate, liveView, statusBadge, amount, action, kv, empty, toast, telLink, badge, table, proofButton, FAIL_LABEL } from '../ui.js';
import { get, post } from '../api.js';

const PAY = { cash: 'Espèces', orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };
const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };

export function courierOrders() {
  return liveView(() => get('/courier/orders'), ({ orders, cash_to_hand_over, cash_pending_validation, max_attempts, require_code }, refresh) => h('div', {},
    h('h1', {}, 'Mes livraisons'),
    h('div', { class: 'kpi mb' }, h('div', { class: 'v' }, fmtGNF(cash_to_hand_over)), h('div', { class: 'l' }, 'Argent encaissé à remettre à l\'administration (tout manque vous est débité). Onglet « Caisse » pour reverser par transfert.'),
      cash_pending_validation > 0 && h('div', { class: 'small muted' }, `+ ${fmtGNF(cash_pending_validation)} déjà reversés par transfert, en attente de validation`)),
    orders.length ? orders.map((o) => {
      const step = (path, ok) => action(() => post(`/courier/orders/${o.id}/${path}`), { ok, refresh });
      const deliver = action(async () => {
        if (require_code) {
          const v = await ask({ title: `Livrer ${o.ref}`, text: `Encaissez ${fmtGNF(o.amount_to_collect)}, puis demandez au client son code à 4 chiffres. Vous ne pouvez pas livrer sans ce code (${max_attempts} essais).`, submit: 'Valider la livraison',
            fields: [{ name: 'code', label: 'Code du client', inputmode: 'numeric', maxlength: 4, code: true }] });
          if (v) await post(`/courier/orders/${o.id}/deliver`, { code: v.code });
        } else if (await confirmBox(`Livrer ${o.ref} ?`, `Confirmez seulement si le colis est remis au client et que vous avez encaissé ${fmtGNF(o.amount_to_collect)}.`, 'Oui, livré')) {
          await post(`/courier/orders/${o.id}/deliver`, {});
        }
      }, { ok: 'Livraison validée. Merci !', refresh });
      // Comment le client a payé : espèces, ou transfert (capture d'écran obligatoire)
      const payment = action(async () => {
        const v = await ask({ title: `Paiement du client · ${o.ref}`, text: 'Si le client paie par transfert Mobile Money, joignez la capture d\'écran du message de confirmation.', submit: 'Enregistrer', fields: [
          { name: 'method', label: 'Le client a payé en', type: 'select', options: Object.entries(PAY) },
          { name: 'reference', label: 'Référence de la transaction (si transfert)', required: false },
          { name: 'image', label: 'Capture d\'écran du transfert', type: 'image', required: false, hint: 'Obligatoire si le client paie par Orange Money ou MTN MoMo.' }] });
        if (!v) return;
        if (v.method !== 'cash' && !v.image) { toast('Ajoutez la capture d\'écran du transfert.', 'bad'); return; }
        const proof = v.method !== 'cash' ? (await post('/proofs', { kind: 'order_payment', image: v.image })).id : undefined;
        await post(`/courier/orders/${o.id}/payment`, { method: v.method, proof_id: proof, reference: v.reference || undefined });
      }, { ok: 'Mode de paiement enregistré', refresh });
      const fail = action(async () => {
        const v = await ask({ title: `Échec de livraison ${o.ref}`, submit: 'Signaler l\'échec', danger: true, fields: [{ name: 'reason', label: 'Motif', type: 'select', options: Object.entries(FAIL_LABEL) }] });
        if (v) await post(`/courier/orders/${o.id}/fail`, { reason: v.reason });
      }, { ok: 'Échec signalé : le chef call center va réaffecter', refresh });
      return h('div', { class: 'card order' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status)),
        kv([['Client', o.customer_name], ['Téléphone', telLink(o.customer_phone)], ['Adresse', `${o.commune}, ${o.address}`], o.note && ['Note', o.note], ['Colis', `${o.product_name} × ${o.qty}`], ['À encaisser', amount(o.amount_to_collect)], o.payment_method && ['Paiement déclaré', badge(PAY[o.payment_method], 'ok')]]),
        h('div', { class: 'gap mt' },
          o.status === 'assigned' && h('button', { class: 'btn btn-gold', onclick: step('pickup', 'Colis récupéré') }, 'J\'ai récupéré le colis'),
          o.status === 'picked_up' && h('button', { class: 'btn btn-gold', onclick: step('depart', 'Bonne route !') }, 'Je pars livrer'),
          o.status === 'on_the_way' && !o.payment_method && h('button', { class: 'btn btn-ghost', onclick: payment }, '💳 Paiement du client'),
          o.status === 'on_the_way' && h('button', { class: 'btn btn-ok', onclick: deliver }, require_code ? '✔ Livrer avec le code' : '✔ Colis livré'),
          h('button', { class: 'btn btn-ghost', onclick: fail }, 'Échec')),
        require_code && o.code_attempts > 0 && h('div', { class: 'notice warn mt' }, `${o.code_attempts} essai(s) de code déjà utilisé(s) sur ${max_attempts}.`));
    }) : empty('🏍️', 'Aucune livraison affectée pour le moment')), { poll: 15000 });
}

const REMIT_STATUS = { pending: ['En attente de validation', 'warn'], confirmed: ['Validé', 'ok'], rejected: ['Refusé', 'bad'] };

// Caisse : l'argent encaissé à remettre, avec la possibilité de reverser par transfert en joignant la capture d'écran
export function courierCash() {
  return liveView(() => get('/courier/cash'), ({ entries, remittances }, refresh) => {
    const due = entries.filter((e) => !e.in_remittance);
    const remit = action(async () => {
      const v = await ask({ title: 'Reverser par transfert', text: 'Envoyez l\'argent par Orange Money ou MTN MoMo au numéro indiqué par Wallindirain, puis joignez la capture d\'écran. L\'administrateur vérifie et valide.', submit: 'Envoyer pour validation', fields: [
        ...due.map((e) => ({ name: `o_${e.order_id}`, label: `${e.ref} · ${fmtGNF(e.amount)}`, type: 'checkbox', value: true, required: false })),
        { name: 'method', label: 'Transfert envoyé par', type: 'select', options: Object.entries(OPERATOR) },
        { name: 'reference', label: 'Référence de la transaction', required: false },
        { name: 'image', label: 'Capture d\'écran du transfert', type: 'image' }] });
      if (!v) return;
      const chosen = due.filter((e) => v[`o_${e.order_id}`]).map((e) => e.order_id);
      if (!chosen.length) { toast('Cochez au moins une commande à reverser.', 'bad'); return; }
      const proof = (await post('/proofs', { kind: 'remittance', image: v.image })).id;
      await post('/courier/remit', { method: v.method, proof_id: proof, reference: v.reference || undefined, orders: chosen });
    }, { ok: 'Reversement envoyé : en attente de validation', refresh });
    const total = due.reduce((a, e) => a + e.amount, 0);
    return h('div', {}, h('h1', {}, 'Caisse'),
      h('div', { class: 'kpi mb' }, h('div', { class: 'v' }, fmtGNF(total)), h('div', { class: 'l' }, 'À remettre à l\'administration (en espèces ou par transfert)')),
      h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Encaissements à remettre'), due.length > 0 && h('button', { class: 'btn btn-sm btn-gold', onclick: remit }, '📲 Reverser par transfert')),
        table(['Commande', 'Montant', 'Livrée le', 'Situation'], entries.map((e) => [h('b', {}, e.ref), amount(e.amount), fmtDate(e.created_at), e.in_remittance ? badge('Reversement en attente', 'warn') : badge('À remettre', 'gold')]),
          { empty: empty('✅', 'Rien à remettre pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mes reversements par transfert'), table(['Date', 'Montant', 'Via', 'Statut', ''], remittances.map((r) => [fmtDate(r.created_at), amount(r.amount),
        `${OPERATOR[r.method]}${r.reference ? ` · ${r.reference}` : ''}`, h('div', {}, badge(...REMIT_STATUS[r.status]), r.status === 'confirmed' && r.received !== r.amount && h('div', { class: 'small muted' }, `Reçu : ${fmtGNF(r.received)}`), r.decision_note && h('div', { class: 'small muted' }, r.decision_note)), proofButton(r.proof_id)]),
        { empty: empty('📲', 'Aucun reversement par transfert') })));
  }, { poll: 30000 });
}
