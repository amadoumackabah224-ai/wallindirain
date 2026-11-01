// Outils du vendeur : carnet de clients, vrai bénéfice (avec dépenses), export des ventes, retours détaillés, alerte de stock bas.
import { h, fmtGNF, fmtDate, fmtPhone, liveView, table, empty, kv, badge, statusBadge, ask, confirmBox, action, errToast, toast, telBtn, waLink, printNode,
  CAUSE_LABEL, FAIL_LABEL, CHANNEL_LABEL, ORDER_STATUS } from '../ui.js';
import { get, post } from '../api.js';

const PERIODS = [[7, '7 jours'], [30, '30 jours'], [90, '3 mois'], [365, '1 an']];
const CATEGORY = { ads: 'Publicité', goods: 'Marchandise', transport: 'Transport', other: 'Autre' };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tile = (label, value, hint) => h('div', { class: 'card stat' }, h('div', { class: 'small muted' }, label), h('div', { class: 'stat-n' }, value), hint && h('div', { class: 'small muted' }, hint));

/** Puces de période : recharge `render(days)` à chaque choix. */
function periodView(title, build, { periods = PERIODS, extra } = {}) {
  let days = 30;
  const host = h('div');
  const chips = h('div', { class: 'chips' }, periods.map(([d, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === days), onclick: (e) => {
    days = d; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); refresh(); } }, l)));
  const refresh = () => host.replaceChildren(build(() => days, refresh));
  refresh();
  return h('div', {}, h('h1', {}, title), chips, extra && extra(() => days), host);
}

// ---------- Carnet de clients ----------
export function sellerCustomers() {
  const search = h('input', { type: 'search', placeholder: 'Chercher un nom ou un numéro…', maxlength: 60, 'aria-label': 'Chercher un client' });
  const list = h('div');
  const load = async () => {
    list.replaceChildren(h('div', { class: 'spinner', role: 'status' }));
    try {
      const r = await get(`/seller/customers?q=${encodeURIComponent(search.value.trim())}`);
      list.replaceChildren(h('div', { class: 'small muted' }, `${r.customers.length} client(s) · ${r.repeat_buyers} qui ont déjà acheté au moins 2 fois`),
        r.customers.length ? r.customers.map(customerCard) : empty('users', 'Aucun client pour le moment. Ils apparaissent ici dès votre première commande.'));
    } catch (e) { list.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  };
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 350); });
  load();
  return h('div', {}, h('h1', {}, 'Mes clients'),
    h('p', { class: 'muted' }, 'Tous les clients qui ont commandé chez vous : leurs achats, leurs refus, et vos notes privées. Les clients qui refusent souvent sont signalés.'),
    h('label', { class: 'f' }, search), list);
}

function customerCard(c) {
  const detail = h('div', { class: 'hidden' });
  let opened = false;
  const toggle = async () => {
    detail.classList.toggle('hidden');
    if (opened || detail.classList.contains('hidden')) return;
    opened = true;
    try {
      const r = await get(`/seller/customers/${c.phone}`);
      const editNote = action(async () => {
        const v = await ask({ title: `Note sur ${c.name}`, text: 'Visible par vous seulement. Laissez vide pour effacer.', fields: [{ name: 'note', label: 'Note', type: 'textarea', maxlength: 500, rows: 4, value: r.note || '' }] });
        if (!v) return;
        await post(`/seller/customers/${c.phone}/note`, { note: v.note });
      }, { ok: 'Note enregistrée', refresh: () => { opened = false; detail.replaceChildren(); detail.classList.add('hidden'); toggle(); } });
      detail.replaceChildren(
        r.note ? h('div', { class: 'notice' }, h('b', {}, 'Ma note : '), r.note) : h('div', { class: 'small muted' }, 'Aucune note.'),
        h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: editNote }, r.note ? 'Modifier la note' : 'Ajouter une note'),
          telBtn(c.phone), waLink(c.phone, `Bonjour ${c.name}, c'est votre vendeur. `)),
        table(['Commande', 'Produit', 'Statut', 'Date'], r.orders.map((o) => [o.ref, `${o.product_name || '—'} × ${o.qty}`,
          h('span', {}, statusBadge(o.status), o.return_cause ? h('div', { class: 'small muted' }, CAUSE_LABEL[o.return_cause] || '') : o.failure_reason ? h('div', { class: 'small muted' }, FAIL_LABEL[o.failure_reason] || o.failure_reason) : null),
          fmtDate(o.created_at)])));
    } catch (e) { opened = false; errToast(e); }
  };
  return h('div', { class: 'card' },
    h('div', { class: 'order-head' }, h('h3', {}, c.name), h('span', { class: 'gap' },
      c.risk_incidents ? badge('Client à risque', 'bad') : null, c.delivered >= 2 ? badge('Fidèle', 'ok') : null, c.note ? badge('Note', 'info') : null)),
    kv([['Téléphone', fmtPhone(c.phone)], ['Quartier', c.commune], ['Commandes', `${c.orders} (livrées ${c.delivered}, échecs ${c.failed}${c.in_progress ? `, en cours ${c.in_progress}` : ''})`],
      ['Total livré', fmtGNF(c.spent)], ['Dernière commande', fmtDate(c.last_order_at)]]),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: toggle }, 'Voir le détail'), detail);
}

// ---------- Vrai bénéfice + export ----------
function csvCell(x) { const t = x == null ? '' : String(x); return /[";\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }
function downloadCsv(name, head, rows) {
  const body = [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');   // « ; » : s'ouvre directement dans Excel en français
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function exportSales(days) {
  const r = await get(`/seller/export?days=${days}`);
  const stamp = todayIso();
  downloadCsv(`ventes-${stamp}.csv`, ['Référence', 'Date', 'Livrée le', 'Produit', 'Quantité', 'Client', 'Téléphone', 'Quartier', 'Statut', 'Montant vendu (GNF)', 'Frais de livraison (GNF)', 'Frais d\'appel (GNF)', 'Gain attendu (GNF)', 'Gain crédité (GNF)', 'Canal', 'Motif d\'échec', 'Cause du retour'],
    r.orders.map((o) => [o.ref, o.created_at?.slice(0, 10), o.delivered_at?.slice(0, 10), o.product_name, o.qty, o.customer_name, o.customer_phone, o.commune, (ORDER_STATUS[o.status] || [o.status])[0],
      o.sale_total, o.delivery_fee, o.call_fee, o.expected_gain, o.real_gain ?? '', CHANNEL_LABEL[o.channel] || '', FAIL_LABEL[o.failure_reason] || o.failure_reason || '', CAUSE_LABEL[o.return_cause] || '']));
  if (r.expenses.length) downloadCsv(`depenses-${stamp}.csv`, ['Date', 'Catégorie', 'Canal', 'Montant (GNF)', 'Note'], r.expenses.map((e) => [e.spent_on, CATEGORY[e.category] || e.category, CHANNEL_LABEL[e.channel] || '', e.amount, e.note || '']));
  toast(r.truncated ? 'Export limité aux 5 000 dernières commandes' : `${r.orders.length} commande(s) exportée(s)`, r.truncated ? 'bad' : 'ok');
}

export function sellerProfit() {
  const addExpense = (refresh) => action(async () => {
    const v = await ask({ title: 'Ajouter une dépense', text: 'Notez ce que vous dépensez pour vendre : publicité, marchandise, transport…', submit: 'Enregistrer',
      fields: [{ name: 'date', label: 'Date', type: 'date', value: todayIso() },
        { name: 'category', label: 'Type de dépense', type: 'select', options: Object.entries(CATEGORY), value: 'ads' },
        { name: 'channel', label: 'Canal de la publicité (seulement pour la publicité)', type: 'select', options: [['', 'Aucun'], ...Object.entries(CHANNEL_LABEL).filter(([k]) => k !== 'unknown')], value: '' },
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' },
        { name: 'note', label: 'Note (facultatif)', type: 'text', maxlength: 200, required: false }] });
    if (!v) return;
    await post('/seller/expenses', { date: v.date, category: v.category, channel: v.category === 'ads' ? v.channel || null : null, amount: Number(v.amount), note: v.note || null });
  }, { ok: 'Dépense enregistrée', refresh });
  return periodView('Mon vrai bénéfice', (getDays, refresh) => liveView(() => get(`/seller/profit?days=${getDays()}`), (r) => {
    const sheet = () => h('div', {}, h('h2', {}, `Bénéfice sur ${r.days} jours`), kv([['Gains crédités', fmtGNF(r.gains)], ['Dépenses', fmtGNF(r.expenses)], ['Bénéfice net', fmtGNF(r.net)]]),
      table(['Dépense', 'Total'], r.by_category.map((c) => [CATEGORY[c.category] || c.category, fmtGNF(c.total)])));
    return h('div', {},
      h('div', { class: 'grid g3' }, tile('Gains crédités', fmtGNF(r.gains), `${r.delivered} livraison(s)`), tile('Mes dépenses', fmtGNF(r.expenses)),
        tile('Bénéfice net', fmtGNF(r.net), r.net < 0 ? 'Vous dépensez plus que vous ne gagnez' : 'Gains moins dépenses'),
        tile('Pub par livraison', r.ads_per_delivery == null ? '–' : fmtGNF(r.ads_per_delivery), 'Ce que vous coûte chaque colis livré')),
      h('div', { class: 'notice' }, 'Les gains sont ceux crédités sur votre portefeuille après livraison. Ajoutez vos dépenses pour voir ce qu\'il vous reste vraiment. Le prix d\'achat de vos propres produits n\'est compté que si vous l\'ajoutez en « Marchandise ».'),
      h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: addExpense(refresh) }, 'Ajouter une dépense'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: action(() => exportSales(getDays() > 90 ? 365 : getDays() > 30 ? 90 : 30), {}) }, 'Exporter mes ventes (Excel)'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => printNode(sheet()) }, 'Imprimer / PDF')),
      r.ads_by_channel.length ? h('div', {}, h('h2', { class: 'mt' }, 'Publicité par canal'),
        table(['Canal', 'Dépensé', 'Livrées', 'Coût par livraison'], r.ads_by_channel.map((c) => [CHANNEL_LABEL[c.channel] || c.channel, fmtGNF(c.ads), c.delivered, c.delivered > 0 ? fmtGNF(Math.round(Number(c.ads) / c.delivered)) : '–']))) : null,
      h('h2', { class: 'mt' }, 'Mes dernières dépenses'),
      table(['Date', 'Type', 'Montant', ''], r.recent.map((e) => [e.spent_on, `${CATEGORY[e.category] || e.category}${e.channel ? ` · ${CHANNEL_LABEL[e.channel] || e.channel}` : ''}${e.note ? ` · ${e.note}` : ''}`,
        e.voided_at ? badge('Annulée', 'grey') : fmtGNF(e.amount),
        e.voided_at ? '' : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => { if (await confirmBox('Annuler cette dépense ?', 'Elle ne sera plus comptée dans votre bénéfice.', 'Annuler la dépense', true)) await post(`/seller/expenses/${e.id}/void`, {}); }, { ok: 'Dépense annulée', refresh }) }, 'Annuler')]),
        { empty: empty('wallet', 'Aucune dépense saisie.') }));
  }));
}

// ---------- Retours détaillés ----------
export function sellerReturns() {
  return periodView('Mes retours et échecs', (getDays) => liveView(() => get(`/seller/returns?days=${getDays()}`), (r) => {
    const label = (k, map) => map[k] || (k === 'unknown' ? 'Non précisé' : k);
    const rank = (rows, map = {}) => rows.length ? table(['', 'Nombre'], rows.map((x) => [label(x.key, map), x.n])) : h('p', { class: 'small muted' }, 'Rien à signaler.');
    return h('div', {},
      h('div', { class: 'grid g3' }, tile('Échecs et retours', String(r.failed), `sur ${r.total_orders} commande(s)`), tile('Taux d\'échec', r.failure_rate == null ? '–' : `${String(r.failure_rate).replace('.', ',')} %`),
        tile('Remis en stock', String(r.restocked)), tile('Retours en route', String(r.awaiting), 'Le colis revient vers l\'entrepôt')),
      h('div', { class: 'notice' }, 'Refus du client : le produit retourne en stock et vous ne payez rien. Produit défectueux ou abîmé : il n\'est pas remis en stock.'),
      h('div', { class: 'dash-cols' }, h('div', {}, h('h2', {}, 'Motifs d\'échec'), rank(r.by_reason, FAIL_LABEL), h('h2', { class: 'mt' }, 'Causes des retours'), rank(r.by_cause, CAUSE_LABEL)),
        h('div', {}, h('h2', {}, 'Quartiers les plus touchés'), rank(r.by_commune), h('h2', { class: 'mt' }, 'Produits les plus touchés'), rank(r.by_product))),
      h('h2', { class: 'mt' }, 'Détail'),
      table(['Commande', 'Client', 'Motif', 'Produit'], r.rows.map((o) => [o.ref, h('span', {}, o.customer_name, h('div', { class: 'small muted' }, `${fmtPhone(o.customer_phone)} · ${o.commune}`)),
        h('span', {}, statusBadge(o.status), h('div', { class: 'small muted' }, o.return_cause ? CAUSE_LABEL[o.return_cause] : FAIL_LABEL[o.failure_reason] || o.failure_reason || '—')),
        h('span', {}, `${o.product_name || '—'} × ${o.qty}`, h('div', { class: 'small' }, o.restocked ? badge('Remis en stock', 'ok') : o.status === 'returned' ? badge('Pas remis en stock', 'warn') : null))]),
        { empty: empty('check', 'Aucun échec sur cette période.') }));
  }));
}

// ---------- Alerte de stock bas ----------
/** Petit encart « stock bas » (rien si tout va bien). `goTo` ouvre l'onglet Mon stock. */
export function lowStockNotice(goTo) {
  const box = h('div');
  get('/seller/low-stock').then((r) => {
    if (!r.count) return;
    const items = [...r.deposits.map((d) => `${d.name} : ${d.available}`), ...r.prepaid.map((p) => `${p.name} : ${p.available}`)];
    box.replaceChildren(h('div', { class: 'notice warn' }, h('b', {}, `Stock bas (${r.threshold} ou moins) : `), items.slice(0, 6).join(' · '), items.length > 6 ? ` … et ${items.length - 6} autre(s)` : '',
      goTo ? h('div', {}, h('button', { class: 'btn btn-sm btn-gold mt', type: 'button', onclick: () => goTo('deposits') }, 'Voir mon stock')) : null));
  }).catch(() => {});
  return box;
}
