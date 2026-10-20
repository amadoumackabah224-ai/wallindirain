// Call center : agents (file d'appel) et chef (affectation aux livreurs).
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, statusBadge, amount, action, kv, empty, toast, badge, telLink, waLink, confirmBox, FAIL_LABEL } from '../ui.js';
import { get, post } from '../api.js';

const RESULT = { confirmed: ['Confirmée', 'ok'], unreachable: ['Injoignable', 'warn'], refused: ['Refusée', 'bad'] };

function orderInfo(o) {
  return h('div', {},
    o.risk_flag && h('div', { class: 'notice bad' }, h('b', {}, '⚠ Client à risque. '), `${o.risk_incidents || 1} incident(s) précédent(s)${o.risk_reason ? ` : ${o.risk_reason}` : ''}. Confirmez bien l'adresse et l'engagement du client.`),
    o.escalated && h('div', { class: 'notice warn' }, `Escaladée au chef : ${o.call_attempts} appels sans réponse.`),
    kv([['Client', o.customer_name], ['Téléphone', h('span', { class: 'gap' }, telLink(o.customer_phone), waLink(o.customer_phone, `Bonjour ${o.customer_name}, ici Wallindirain au sujet de votre commande ${o.ref}.`))],
      ['Produit', `${o.product_name} × ${o.qty}`], ['Total à payer', amount(o.sale_total)], ['Livraison', `${o.commune}, ${o.address}`], o.note && ['Note', o.note], o.call_attempts > 0 && ['Appels sans réponse', o.call_attempts]]));
}

export function callQueue({ onTaken }) {
  return liveView(() => get('/calls/queue'), ({ orders }, refresh) => h('div', {}, h('h1', {}, 'File d\'appel'),
    orders.length ? orders.map((o) => {
      const take = action(async () => { await post(`/calls/${o.id}/take`); onTaken?.(); }, { ok: 'Commande prise : appelez le client', refresh });
      return h('div', { class: `card order ${o.risk_flag ? 'risk' : ''} ${o.escalated ? 'escalated' : ''}` },
        h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), o.risk_flag && badge('Client à risque', 'bad'), o.escalated && badge('Escaladée', 'warn'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, fmtDate(o.created_at))),
        kv([['Produit', `${o.product_name} × ${o.qty}`], ['Quartier / ville', o.commune], ['Total', amount(o.sale_total)]]),
        h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: take }, 'Prendre cette commande')));
    }) : empty('✅', 'Aucune commande à appeler. Bravo !')), { poll: 10000 });
}

export function myCalls() {
  return liveView(() => get('/calls/mine'), ({ orders }, refresh) => h('div', {}, h('h1', {}, 'Mes appels en cours'),
    orders.length ? orders.map((o) => {
      const log = (result, title) => action(async () => {
        const v = await ask({ title, text: `${o.ref} · ${o.customer_name}`, submit: 'Enregistrer l\'appel', danger: result === 'refused',
          fields: [{ name: 'note', label: result === 'confirmed' ? 'Note (adresse confirmée, détails…)' : 'Note', type: 'textarea', required: result === 'refused' }] });
        if (v) return post(`/calls/${o.id}/log`, { result, note: v.note });
      }, { ok: result === 'confirmed' ? 'Commande confirmée : le client a été prévenu par message' : 'Appel enregistré', refresh });
      return h('div', { class: `card order ${o.risk_flag ? 'risk' : ''}` }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status)), orderInfo(o),
        o.calls?.length > 0 && h('div', { class: 'mt small muted' }, 'Appels précédents : ', o.calls.map((c) => `${c.agent_name} (${RESULT[c.result][0]})`).join(', ')),
        h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-ok', onclick: log('confirmed', 'Client confirme sa commande') }, '✔ Client confirme'),
          h('button', { class: 'btn btn-ghost', onclick: log('unreachable', 'Client injoignable') }, 'Injoignable'), h('button', { class: 'btn btn-bad', onclick: log('refused', 'Client refuse') }, '✖ Client refuse')),
        h('p', { class: 'hint' }, 'Votre nom et votre call center sont enregistrés sur chaque appel.'));
    }) : empty('📞', 'Aucun appel en cours. Prenez une commande dans la file d\'appel.')), { poll: 20000 });
}

export function chiefAssign() {
  return liveView(() => get('/chief/orders'), ({ orders, couriers }, refresh) => {
    const groups = [['À affecter', ['confirmed']], ['Échecs de livraison', ['failed']], ['En livraison', ['assigned', 'picked_up', 'on_the_way']], ['Retours attendus en entrepôt', ['return_pending']]];
    return h('div', {}, h('h1', {}, 'Affectation des livreurs'),
      groups.map(([title, sts]) => {
        const list = orders.filter((o) => sts.includes(o.status));
        return h('div', {}, h('h2', { class: 'mt' }, `${title} (${list.length})`), list.length ? list.map((o) => {
          const assign = action(async () => {
            const v = await ask({ title: `Affecter ${o.ref}`, text: `${o.commune} · ${o.address}`, submit: 'Affecter', fields: [{ name: 'courier', label: 'Livreur', type: 'select', value: o.courier_id, options: couriers.map((c) => [c.id, `${c.full_name} (${c.open_orders} en cours)`]) }] });
            if (v) await post(`/chief/orders/${o.id}/assign`, { courier_id: v.courier });
          }, { ok: 'Commande affectée', refresh });
          const toWh = action(async () => { if (await confirmBox('Retour en entrepôt ?', 'Le magasinier réceptionnera le colis et indiquera la cause.')) await post(`/chief/orders/${o.id}/return`); }, { ok: 'Retour demandé', refresh });
          const cancel = action(async () => { const v = await ask({ title: `Annuler ${o.ref}`, submit: 'Annuler la commande', danger: true, fields: [{ name: 'reason', label: 'Motif' }] }); if (v) await post(`/chief/orders/${o.id}/cancel`, { reason: v.reason }); }, { ok: 'Commande annulée', refresh });
          return h('div', { class: 'card order' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status), o.courier_name && badge(o.courier_name, 'grey'), o.failure_reason && badge(FAIL_LABEL[o.failure_reason], 'bad')),
            kv([['Client', `${o.customer_name} · ${fmtPhone(o.customer_phone)}`], ['Livraison', `${o.commune}, ${o.address}`], ['Produit', `${o.product_name} × ${o.qty}`], ['Total', amount(o.sale_total)]]),
            h('div', { class: 'gap mt' }, ['confirmed', 'failed', 'assigned'].includes(o.status) && h('button', { class: 'btn btn-sm btn-gold', onclick: assign }, o.status === 'confirmed' ? 'Affecter à un livreur' : 'Réaffecter'),
              o.status === 'failed' && h('button', { class: 'btn btn-sm btn-ghost', onclick: toWh }, 'Retour en entrepôt'), ['confirmed', 'failed', 'assigned'].includes(o.status) && h('button', { class: 'btn btn-sm btn-ghost', onclick: cancel }, 'Annuler')));
        }) : h('p', { class: 'muted small' }, 'Aucune.'));
      }));
  }, { poll: 15000 });
}
