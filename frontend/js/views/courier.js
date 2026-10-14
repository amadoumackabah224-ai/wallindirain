// Espace livreur : récupérer, livrer avec le code du client, signaler un échec.
import { h, ask, fmtGNF, fmtPhone, liveView, statusBadge, amount, action, kv, empty, toast, telLink, FAIL_LABEL } from '../ui.js';
import { get, post } from '../api.js';

export function courierOrders() {
  return liveView(() => get('/courier/orders'), ({ orders, cash_to_hand_over, max_attempts }, refresh) => h('div', {},
    h('h1', {}, 'Mes livraisons'),
    h('div', { class: 'kpi mb' }, h('div', { class: 'v' }, fmtGNF(cash_to_hand_over)), h('div', { class: 'l' }, 'Argent encaissé à remettre à l\'administration (tout manque vous est débité)')),
    orders.length ? orders.map((o) => {
      const step = (path, ok) => action(() => post(`/courier/orders/${o.id}/${path}`), { ok, refresh });
      const deliver = action(async () => {
        const v = await ask({ title: `Livrer ${o.ref}`, text: `Encaissez ${fmtGNF(o.amount_to_collect)}, puis demandez au client son code à 4 chiffres. Vous ne pouvez pas livrer sans ce code (${max_attempts} essais).`, submit: 'Valider la livraison',
          fields: [{ name: 'code', label: 'Code du client', inputmode: 'numeric', maxlength: 4, code: true }] });
        if (v) await post(`/courier/orders/${o.id}/deliver`, { code: v.code });
      }, { ok: 'Livraison validée. Merci !', refresh });
      const fail = action(async () => {
        const v = await ask({ title: `Échec de livraison ${o.ref}`, submit: 'Signaler l\'échec', danger: true, fields: [{ name: 'reason', label: 'Motif', type: 'select', options: Object.entries(FAIL_LABEL) }] });
        if (v) await post(`/courier/orders/${o.id}/fail`, { reason: v.reason });
      }, { ok: 'Échec signalé : le chef call center va réaffecter', refresh });
      return h('div', { class: 'card order' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status)),
        kv([['Client', o.customer_name], ['Téléphone', telLink(o.customer_phone)], ['Adresse', `${o.commune}, ${o.address}`], o.note && ['Note', o.note], ['Colis', `${o.product_name} × ${o.qty}`], ['À encaisser', amount(o.amount_to_collect)]]),
        h('div', { class: 'gap mt' },
          o.status === 'assigned' && h('button', { class: 'btn btn-gold', onclick: step('pickup', 'Colis récupéré') }, 'J\'ai récupéré le colis'),
          o.status === 'picked_up' && h('button', { class: 'btn btn-gold', onclick: step('depart', 'Bonne route !') }, 'Je pars livrer'),
          o.status === 'on_the_way' && h('button', { class: 'btn btn-ok', onclick: deliver }, '✔ Livrer avec le code'),
          h('button', { class: 'btn btn-ghost', onclick: fail }, 'Échec')),
        o.code_attempts > 0 && h('div', { class: 'notice warn mt' }, `${o.code_attempts} essai(s) de code déjà utilisé(s) sur ${max_attempts}.`));
    }) : empty('🏍️', 'Aucune livraison affectée pour le moment')), { poll: 15000 });
}
