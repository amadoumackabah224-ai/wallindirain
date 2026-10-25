// Call center : agents (file d'appel) et chef (affectation aux livreurs).
import { h, ask, fmtDate, fmtGNF, fmtPhone, liveView, statusBadge, amount, action, kv, empty, badge, telLink, waLink, confirmBox, FAIL_LABEL, since, pickupLate } from '../ui.js';
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
  return liveView(() => Promise.all([get('/chief/orders'), get('/chief/offers'), get('/chief/tours')]).then(([o, offers, t]) => ({ ...o, offers, tours: t.tours })), ({ orders, couriers, offers, tours, pickup_alert_hours }, refresh) => {
    const groups = [['À affecter', ['confirmed']], ['Échecs de livraison', ['failed']], ['En livraison', ['assigned', 'picked_up', 'on_the_way']], ['Retours attendus en entrepôt', ['return_pending']]];
    const eligible = orders.filter((o) => ['confirmed', 'failed'].includes(o.status) && !tours.some((t) => t.status === 'active' && t.stops.some((st) => st.active && st.order_id === o.id)));
    const createTour = action(async () => {
      const v = await ask({ title: 'Créer une tournée', text: 'Cochez au moins 2 commandes, dans l\'ordre où le livreur doit passer. Chaque commande garde son propre suivi et son propre encaissement ; la paie du livreur reste celle de chaque commande.', submit: 'Créer la tournée', fields: [
        { name: 'courier', label: 'Livreur', type: 'select', options: couriers.map((c) => [c.id, `${c.full_name} (${c.open_orders} en cours)${c.availability === 'unavailable' ? ' · indisponible' : ''}${c.zones.length ? ` · ${c.zones.join(', ')}` : ''}`]) },
        { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200 },
        ...eligible.map((o, i) => ({ name: `o${i}`, label: `${o.ref} · ${o.commune}`, type: 'checkbox', value: false, required: false }))] });
      if (v) await post('/chief/tours', { courier_id: v.courier, note: v.note || undefined, order_ids: eligible.filter((o, i) => v[`o${i}`]).map((o) => o.id) });
    }, { ok: 'Tournée créée', refresh });
    const TOUR_LABEL = { active: ['En cours', 'warn'], closed: ['Terminée', 'ok'], cancelled: ['Annulée', 'grey'] };
    const tourCard = (t) => {
      const setCost = action(async () => {
        const v = await ask({ title: 'Coût réel de la tournée', text: 'Carburant, temps du livreur, etc. Information seulement : elle sert à mesurer la rentabilité, rien n\'est écrit dans les comptes.', submit: 'Enregistrer', fields: [{ name: 'cost', label: 'Coût réel (GNF)', type: 'number', value: t.actual_cost ?? '', required: false }] });
        if (v) await post(`/chief/tours/${t.id}/cost`, { cost: v.cost === '' ? null : Number(v.cost) });
      }, { ok: 'Coût enregistré', refresh });
      const cancelTour = action(async () => { if (await confirmBox('Annuler la tournée ?', 'Les commandes restent affectées au livreur, une par une.', 'Annuler la tournée')) await post(`/chief/tours/${t.id}/cancel`); }, { ok: 'Tournée annulée', refresh });
      const basis = t.actual_cost ?? t.courier_pay_system;
      return h('div', { class: 'card' }, h('div', { class: 'order-head' }, h('b', {}, t.courier_name), badge(...TOUR_LABEL[t.status]), t.note && h('span', { class: 'small muted' }, t.note)),
        h('ol', { class: 'small' }, t.stops.map((st) => h('li', {}, `${st.ref} · ${st.commune} · `, statusBadge(st.status)))),
        h('div', { class: 'small muted' }, `${t.delivered}/${t.orders} livrées · frais de livraison encaissés ${fmtGNF(t.delivery_fees)} · paie prévue ${fmtGNF(t.courier_pay_system)}${t.actual_cost != null ? ` · coût réel saisi ${fmtGNF(t.actual_cost)}` : ''} · marge de livraison ${fmtGNF(t.delivery_fees - basis)}${t.actual_cost != null ? ' (sur coût réel)' : ' (sur paie prévue)'}`),
        h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: setCost }, 'Coût réel'), t.status === 'active' && h('button', { class: 'btn btn-sm btn-ghost', onclick: cancelTour }, 'Annuler la tournée')));
    };
    return h('div', {}, h('h1', {}, 'Affectation des livreurs'),
      h('div', { class: 'gap mb' }, eligible.length >= 2 && h('button', { class: 'btn btn-gold', onclick: createTour }, '+ Créer une tournée')),
      tours.length > 0 && h('div', {}, h('h2', {}, `Tournées (${tours.length})`), tours.map(tourCard)),
      groups.map(([title, sts]) => {
        const list = orders.filter((o) => sts.includes(o.status));
        return h('div', {}, h('h2', { class: 'mt' }, `${title} (${list.length})`), list.length ? list.map((o) => {
          const assign = action(async () => {
            const v = await ask({ title: `Affecter ${o.ref}`, text: `${o.commune} · ${o.address}`, submit: 'Affecter', fields: [{ name: 'courier', label: 'Livreur', type: 'select', value: o.courier_id, options: couriers.map((c) => [c.id, `${c.full_name} (${c.open_orders} en cours)${c.availability === 'unavailable' ? ' · indisponible' : ''}${c.zones.length ? ` · ${c.zones.join(', ')}` : ''}`]) }] });
            if (v) await post(`/chief/orders/${o.id}/assign`, { courier_id: v.courier });
          }, { ok: 'Commande affectée', refresh });
          const open = offers.open.find((m) => m.order_id === o.id);
          const made = offers.counts[o.id] || 0;
          const offer = action(async () => {
            const v = await ask({ title: `Proposer ${o.ref}`, text: `${o.commune}. Le livreur voit sa rémunération avant d'accepter et dispose de quelques minutes pour répondre. Proposition ${made + 1} sur ${offers.max_offers} maximum.`, submit: 'Proposer', fields: [{ name: 'courier', label: 'Livreur', type: 'select', options: couriers.filter((c) => c.availability === 'available').map((c) => [c.id, `${c.full_name} (${c.open_orders} en cours)${c.zones.length ? ` · ${c.zones.join(', ')}` : ''}`]) }] });
            if (v) await post(`/chief/orders/${o.id}/offer`, { courier_id: v.courier });
          }, { ok: 'Proposition envoyée', refresh });
          const cancelOffer = action(async () => { await post(`/chief/offers/${open.id}/cancel`); }, { ok: 'Proposition retirée', refresh });
          const toWh = action(async () => { if (await confirmBox('Retour en entrepôt ?', 'Le magasinier réceptionnera le colis et indiquera la cause.')) await post(`/chief/orders/${o.id}/return`); }, { ok: 'Retour demandé', refresh });
          const cancel = action(async () => { const v = await ask({ title: `Annuler ${o.ref}`, submit: 'Annuler la commande', danger: true, fields: [{ name: 'reason', label: 'Motif' }] }); if (v) await post(`/chief/orders/${o.id}/cancel`, { reason: v.reason }); }, { ok: 'Commande annulée', refresh });
          return h('div', { class: 'card order' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status), o.courier_name && badge(o.courier_name, 'grey'), open && badge(`Proposée à ${open.courier_name}`, 'warn'), pickupLate(o, pickup_alert_hours) && badge(`Non récupéré depuis ${since(o.assigned_since)}`, 'bad'), o.failure_reason && badge(FAIL_LABEL[o.failure_reason], 'bad')),
            kv([['Client', `${o.customer_name} · ${fmtPhone(o.customer_phone)}`], ['Livraison', `${o.commune}, ${o.address}`], ['Produit', `${o.product_name} × ${o.qty}`], ['Total', amount(o.sale_total)]]),
            h('div', { class: 'gap mt' }, ['confirmed', 'failed'].includes(o.status) && (open ? h('button', { class: 'btn btn-sm btn-ghost', onclick: cancelOffer }, 'Retirer la proposition') : made < offers.max_offers && h('button', { class: 'btn btn-sm btn-ghost', onclick: offer }, 'Proposer à un livreur')),
              ['confirmed', 'failed', 'assigned'].includes(o.status) && h('button', { class: 'btn btn-sm btn-gold', onclick: assign }, o.status === 'confirmed' ? 'Affecter à un livreur' : 'Réaffecter'),
              o.status === 'failed' && h('button', { class: 'btn btn-sm btn-ghost', onclick: toWh }, 'Retour en entrepôt'), ['confirmed', 'failed', 'assigned'].includes(o.status) && h('button', { class: 'btn btn-sm btn-ghost', onclick: cancel }, 'Annuler')));
        }) : h('p', { class: 'muted small' }, 'Aucune.'));
      }));
  }, { poll: 15000 });
}
