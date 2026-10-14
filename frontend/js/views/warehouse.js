// Espace magasinier : aucune donnée financière.
import { h, ask, fmtDate, liveView, action, kv, empty, table, FAIL_LABEL, CAUSE_LABEL, badge } from '../ui.js';
import { get, post } from '../api.js';

export function warehouseView() {
  return liveView(() => get('/warehouse/arrivals'), ({ arrivals, returns }, refresh) => h('div', {},
    h('h1', {}, 'Arrivages à compter'),
    arrivals.length ? arrivals.map((a) => {
      const count = action(async () => {
        const v = await ask({ title: `Compter : ${a.product_name}`, text: `Le fournisseur annonce ${a.announced_qty} unité(s). Comptez ce que vous avez réellement reçu : seul ce nombre deviendra vendable.`, submit: 'Valider le comptage', fields: [{ name: 'counted', label: 'Quantité réellement reçue', type: 'number', inputmode: 'numeric' }] });
        if (v) await post(`/warehouse/arrivals/${a.id}/count`, { counted: Number(v.counted) });
      }, { ok: 'Stock mis à jour', refresh });
      return h('div', { class: 'card' }, h('h2', {}, a.product_name), kv([['Annoncé', a.announced_qty], ['Date', fmtDate(a.created_at)]]), h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: count }, 'Compter cet arrivage')));
    }) : empty('📦', 'Aucun arrivage en attente'),
    h('h1', { class: 'mt' }, 'Retours à réceptionner'),
    returns.length ? returns.map((r) => {
      const receive = action(async () => {
        const v = await ask({ title: `Réception du retour ${r.ref}`, text: 'Examinez le colis puis indiquez la cause. Elle décide qui supporte les frais.', submit: 'Enregistrer le retour',
          fields: [{ name: 'cause', label: 'Cause du retour', type: 'select', options: Object.entries(CAUSE_LABEL) }] });
        if (v) await post(`/warehouse/returns/${r.id}`, { cause: v.cause });
      }, { ok: 'Retour enregistré', refresh });
      return h('div', { class: 'card' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, r.ref), r.failure_reason && badge(FAIL_LABEL[r.failure_reason], 'warn')), kv([['Produit', `${r.product_name} × ${r.qty}`]]),
        h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: receive }, 'Réceptionner')));
    }) : empty('↩️', 'Aucun retour attendu')), { poll: 20000 });
}
