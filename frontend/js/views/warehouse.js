// Espace magasinier : aucune donnée financière, aucune donnée client (ni nom ni téléphone).
// Trois onglets : « À faire » (colis à remettre, arrivages à compter, retours à réceptionner), « Stock », « Historique ».
import { h, ask, fmtDate, liveView, action, kv, empty, FAIL_LABEL, CAUSE_LABEL, badge, pageHead, photoStrip, table, telLink, toast } from '../ui.js';
import { get, post } from '../api.js';

const LOSS_LABEL = { damaged: 'Abîmé', lost: 'Perdu', expired: 'Périmé', other: 'Autre motif' };
const photosOf = (ids = []) => ids.length ? h('div', { class: 'photo-strip' }, ids.map((id) => h('a', { href: `/api/return-photos/${id}`, target: '_blank', rel: 'noopener' },
  h('img', { class: 'photo-thumb', src: `/api/return-photos/${id}`, alt: 'Photo du retour', loading: 'lazy', width: 72, height: 72 })))) : null;
const section = (title, count, ...children) => h('section', { class: 'mb' }, h('h2', { class: 'mt' }, title, count ? ' ' : null, count ? badge(String(count), 'info') : null), ...children);
const parcel = (img, ...rest) => h('div', { class: 'card' }, img?.length ? photoStrip(img.slice(0, 1), { size: 64 }) : null, ...rest);

// ---------- À faire ----------
function todoView() {
  return liveView(() => get('/warehouse/arrivals'), ({ arrivals, handovers, returns }, refresh) => {
    const pending = handovers.filter((x) => !x.handed_at);
    const handOver = (o) => action(async () => { await post(`/warehouse/handovers/${o.id}`); }, { ok: 'Remise enregistrée', refresh });
    const countArrival = (a) => action(async () => {
      const v = await ask({ title: `Compter : ${a.product_name}`, text: `Le fournisseur annonce ${a.announced_qty} unité(s). Comptez ce que vous avez réellement reçu : seul ce nombre deviendra vendable.`, submit: 'Continuer',
        fields: [{ name: 'counted', label: 'Quantité réellement reçue', type: 'number', inputmode: 'numeric', value: a.announced_qty }] });
      if (!v) return;
      const counted = Number(v.counted);
      if (!Number.isInteger(counted) || counted < 0) { toast('Quantité invalide', 'bad'); return; }
      let note = null;
      if (counted !== a.announced_qty) {
        const w = await ask({ title: 'Écart avec la quantité annoncée', text: `Annoncé : ${a.announced_qty} · Compté : ${counted}. Expliquez l'écart (le fournisseur et l'administration en seront informés).`, submit: `Valider ${counted} unité(s)`,
          fields: [{ name: 'note', label: 'Explication', type: 'textarea', maxlength: 300, placeholder: 'Ex. 2 cartons manquants, 3 produits abîmés…' }] });
        if (!w) return;
        note = (w.note || '').trim();
        if (note.length < 3) { toast('Écrivez une explication de quelques mots', 'bad'); return; }
      }
      await post(`/warehouse/arrivals/${a.id}/count`, { counted, ...(note ? { note } : {}) });
    }, { ok: 'Stock mis à jour', refresh });
    const receiveReturn = (r) => action(async () => {
      const v = await ask({ title: `Réception du retour ${r.ref}`, text: 'Examinez le colis puis indiquez la cause. Elle décide qui supporte les frais. Une note et des photos (facultatives) protègent tout le monde en cas de désaccord.', submit: 'Enregistrer le retour',
        fields: [{ name: 'cause', label: 'Cause du retour', type: 'select', options: Object.entries(CAUSE_LABEL) },
          { name: 'note', label: 'Note (facultatif)', type: 'textarea', maxlength: 300, placeholder: 'État du colis, emballage…' },
          ...[1, 2, 3].map((i) => ({ name: `p${i}`, label: `Photo ${i} (facultatif)`, type: 'image', required: false, hint: i === 1 ? 'Photographiez le colis, l\'emballage et le défaut éventuel.' : 'Une photo de plus si utile.' }))] });
      if (!v) return;
      const note = (v.note || '').trim();
      if (note && note.length < 3) { toast('Note trop courte (3 caractères minimum)', 'bad'); return; }
      for (const k of ['p1', 'p2', 'p3']) if (v[k]) await post(`/warehouse/returns/${r.id}/photos`, { image: v[k] });   // d'abord les photos : si l'une échoue, rien n'est enregistré
      await post(`/warehouse/returns/${r.id}`, { cause: v.cause, ...(note ? { note } : {}) });
    }, { ok: 'Retour enregistré', refresh });

    return h('div', {},
      pageHead('À faire', pending.length + arrivals.length + returns.length ? `${pending.length} colis à remettre · ${arrivals.length} arrivage(s) à compter · ${returns.length} retour(s) à réceptionner` : 'Tout est à jour'),
      section('Colis à remettre aux livreurs', pending.length,
        handovers.length ? handovers.map((o) => parcel(o.image_ids,
          h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), o.handed_at ? badge('Remis', 'ok') : badge('À préparer', 'warn')),
          kv([['Produit', `${o.product_name} × ${o.qty}`, 'key'], ['Livreur', h('span', {}, o.courier_name, ' · ', telLink(o.courier_phone))], ['Zone', o.commune], ['Affecté', fmtDate(o.assigned_at)], o.handed_at && ['Remis', fmtDate(o.handed_at)]]),
          !o.handed_at && h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: handOver(o) }, 'Colis remis au livreur')))) : empty('truck', 'Aucun colis à remettre')),
      section('Arrivages à compter', arrivals.length,
        arrivals.length ? arrivals.map((a) => parcel(a.image_ids, h('h3', {}, a.product_name),
          kv([['Fournisseur', a.supplier_name], ['Annoncé', `${a.announced_qty} unité(s)`, 'key'], ['Date', fmtDate(a.created_at)]]),
          h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: countArrival(a) }, 'Compter l\'arrivage')))) : empty('package', 'Aucun arrivage en attente')),
      section('Retours à réceptionner', returns.length,
        returns.length ? returns.map((r) => h('div', { class: 'card' },
          h('div', { class: 'order-head' }, h('span', { class: 'ref' }, r.ref), r.failure_reason && badge(FAIL_LABEL[r.failure_reason], 'warn')),
          kv([['Produit', `${r.product_name} × ${r.qty}`, 'key'], r.note && ['Note', r.note]]), photosOf(r.photo_ids),
          h('div', { class: 'mt' }, h('button', { class: 'btn btn-gold', onclick: receiveReturn(r) }, 'Réceptionner')))) : empty('inbox', 'Aucun retour attendu')));
  }, { poll: 20000 });
}

// ---------- Stock ----------
function stockView() {
  let filter = '';
  return liveView(() => get('/warehouse/stock'), ({ products, low_threshold }, refresh) => {
    const declare = action(async () => {
      const usable = products.filter((p) => p.free_qty > 0);
      if (!usable.length) { toast('Aucun produit avec du stock libre', 'bad'); return; }
      const v = await ask({ title: 'Casse ou perte en stock', text: 'Retire ces unités du stock vendable. Seules les unités libres (non réservées par une commande) peuvent être retirées. L\'administration et le fournisseur sont prévenus.', submit: 'Retirer du stock', danger: true,
        fields: [{ name: 'product_id', label: 'Produit', type: 'select', options: usable.map((p) => [p.id, `${p.name} (${p.free_qty} libre${p.free_qty > 1 ? 's' : ''})`]) },
          { name: 'qty', label: 'Quantité', type: 'number', inputmode: 'numeric', value: 1 },
          { name: 'reason', label: 'Motif', type: 'select', options: Object.entries(LOSS_LABEL) },
          { name: 'note', label: 'Explication', type: 'textarea', maxlength: 300, placeholder: 'Ce qui s\'est passé' }] });
      if (!v) return;
      const note = (v.note || '').trim(), qty = Number(v.qty);
      if (!Number.isInteger(qty) || qty < 1) { toast('Quantité invalide', 'bad'); return; }
      if (note.length < 3) { toast('Écrivez une explication de quelques mots', 'bad'); return; }
      await post('/warehouse/losses', { product_id: v.product_id, qty, reason: v.reason, note });
    }, { ok: 'Stock mis à jour', refresh });
    const out = products.filter((p) => p.free_qty <= 0).length, lowN = products.filter((p) => p.free_qty > 0 && low_threshold > 0 && p.free_qty <= low_threshold).length;
    const search = h('input', { type: 'search', placeholder: 'Chercher un produit ou un fournisseur', value: filter, 'aria-label': 'Chercher un produit' });
    const build = () => {
      const qq = filter.trim().toLowerCase();
      const items = products.filter((p) => !qq || p.name.toLowerCase().includes(qq) || p.supplier_name.toLowerCase().includes(qq));
      return items.length ? items.map((p) => h('div', { class: 'card' }, p.image_ids?.length ? photoStrip(p.image_ids.slice(0, 1), { size: 56 }) : null,
        h('div', { class: 'order-head' }, h('h3', {}, p.name), p.free_qty <= 0 ? badge('Rupture', 'bad') : low_threshold > 0 && p.free_qty <= low_threshold ? badge('Stock bas', 'warn') : badge('En stock', 'ok')),
        kv([['Fournisseur', p.supplier_name], ['Libre (vendable)', `${p.free_qty} unité(s)`, 'key'], ['Réservé (commandes)', p.reserved_qty], ['Total à l\'entrepôt', p.stock_qty], ['Dernier arrivage compté', p.last_arrival ? fmtDate(p.last_arrival) : '—']]))) : [empty('search', 'Aucun produit trouvé')];
    };
    const list = h('div', {}, ...build());
    search.oninput = (e) => { filter = e.target.value; list.replaceChildren(...build()); };
    return h('div', {},
      pageHead('Stock de l\'entrepôt', `${products.length} produit(s) · ${out} en rupture · ${lowN} stock bas`, h('button', { class: 'btn btn-ghost', onclick: declare }, 'Casse ou perte')),
      h('label', { class: 'f' }, search), list);
  }, { poll: 30000 });
}

// ---------- Historique ----------
function historyView() {
  let part = 'arrivals';
  const host = h('div', {});
  let data = null;
  const draw = () => {
    const chip = (k, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(part === k), onclick: () => { part = k; draw(); } }, label);
    const body = part === 'arrivals' ? table(['Date', 'Produit', 'Fournisseur', 'Annoncé', 'Compté', 'Explication', 'Par'], data.arrivals.map((a) => [fmtDate(a.counted_at), a.product_name, a.supplier_name, a.announced_qty,
        a.counted_qty === a.announced_qty ? a.counted_qty : h('b', {}, `${a.counted_qty} (écart ${a.counted_qty - a.announced_qty > 0 ? '+' : ''}${a.counted_qty - a.announced_qty})`), a.count_note || '', a.by_name || '']), { empty: empty('clock', 'Aucun arrivage compté') })
      : part === 'returns' ? table(['Date', 'Commande', 'Produit', 'Cause', 'Note', 'Photos'], data.returns.map((r) => [fmtDate(r.closed_at), h('b', {}, r.ref), `${r.product_name} × ${r.qty}`, CAUSE_LABEL[r.return_cause] || '', r.note || '', photosOf(r.photo_ids) || '']), { empty: empty('inbox', 'Aucun retour réceptionné') })
      : part === 'handovers' ? table(['Date', 'Commande', 'Produit', 'Livreur', 'Par'], data.handovers.map((x) => [fmtDate(x.handed_at), h('b', {}, x.ref), `${x.product_name} × ${x.qty}`, x.courier_name, x.by_name || '']), { empty: empty('truck', 'Aucune remise enregistrée') })
      : table(['Date', 'Produit', 'Quantité', 'Motif', 'Explication', 'Par'], data.losses.map((l) => [fmtDate(l.created_at), l.product_name, l.qty, LOSS_LABEL[l.reason] || l.reason, l.note, l.by_name || '']), { empty: empty('check', 'Aucune casse ni perte déclarée') });
    host.replaceChildren(h('div', { class: 'chips mb' }, chip('arrivals', 'Arrivages'), chip('returns', 'Retours'), chip('handovers', 'Remises'), chip('losses', 'Casses et pertes')), h('div', { class: 'card' }, body));
  };
  return h('div', {}, pageHead('Historique', '60 derniers de chaque'),
    liveView(() => get('/warehouse/history'), (d) => { data = d; draw(); return host; }, { poll: 60000 }));
}

export function warehouseTab(key) { return key === 'stock' ? stockView() : key === 'history' ? historyView() : todoView(); }
export const warehouseView = todoView;
