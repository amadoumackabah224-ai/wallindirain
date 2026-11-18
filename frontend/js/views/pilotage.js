// Pilotage (migration 075) : « Aujourd'hui » par rôle, alertes, rapports, dettes et créances, performances, historique produit, dossiers.
// Tout est en lecture ; les droits sont revérifiés par le serveur.
import { h, fmtGNF as rawGNF, secret, eyeToggle, fmtDate, liveView, action, table, badge, empty, guide, pageHead, kv, alertRow, statusBadge, toast, showProof } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { openInvoice } from './invoices.js';

const fmtGNF = (n) => secret(rawGNF(n));   // les montants suivent l'œil (masquer / afficher)
const eyeRow = (...kids) => h('div', { class: 'row-top' }, h('div', { class: 'grow' }, kids), eyeToggle());
const dayFr = (d) => d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const iso = (d) => d.toISOString().slice(0, 10);

/** Fenêtre simple (fermeture : croix, clic à côté, Échap). */
function sheet(title, body) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title), body, h('button', { class: 'btn btn-ghost btn-block mt', type: 'button', onclick: close }, 'Fermer')));
  document.body.append(overlay); document.addEventListener('keydown', onKey);
}
const open = async (title, load, render) => {
  try { sheet(title, render(await load())); } catch (e) { toast(e.message, 'bad'); }
};

// ---------- Aujourd'hui ----------
const TONE_ICO = { bad: 'alert', warn: 'clock', ok: 'checkCircle', '': 'inbox' };
export function todayView(ctx) {
  return liveView(() => get('/today'), ({ items }) => h('div', {},
    pageHead('Aujourd\'hui', new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })),
    items.length === 0
      ? guide('checkCircle', 'Votre journée', 'Rien d\'urgent pour le moment', 'Les actions à faire aujourd\'hui s\'afficheront ici, avec un bouton pour les ouvrir. Cette page se met à jour toute seule.')
      : h('div', { class: 'today-list' }, items.map((it) => h('button', { class: `today-card ${it.tone}`, type: 'button', onclick: () => ctx.goTo(it.tab) },
          icon(TONE_ICO[it.tone] || 'inbox', 22), h('span', { class: 'today-n' }, it.key === 'cash' ? fmtGNF(it.n) : String(it.n)), h('span', { class: 'grow today-l' }, it.key === 'cash' ? it.label.replace(' (GNF)', '') : it.label), icon('chevronRight', 18))))), { poll: 60000 });
}

// ---------- Alertes (administrateur) ----------
export function adminAlerts() {
  return liveView(() => get('/admin/anomalies'), ({ anomalies }) => h('div', {},
    pageHead('Alertes', 'Anomalies comptables et retards. Les administrateurs sont aussi prévenus par la cloche.'),
    anomalies.length === 0
      ? guide('shield', 'Surveillance des comptes', 'Aucune anomalie', 'Les comptes sont cohérents. Les écarts et les retards seront signalés ici, et vous serez prévenu par la cloche.')
      : h('div', { class: 'alert-list' }, anomalies.map((a) => alertRow(a.severity === 'bad' ? 'bad' : '', a.severity === 'bad' ? 'alert' : 'clock', `${a.label}${a.detail ? ` — ${a.detail}` : ''}`)))), { poll: 60000 });
}

// ---------- Rapports financiers (administrateur) ----------
const KIND = { daily: 'Journalier', weekly: 'Hebdomadaire', monthly: 'Mensuel' };
export function adminReports() {
  return liveView(() => get('/admin/reports'), ({ reports }, refresh) => {
    const make = (kind, label) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: action(async () => {
      const d = new Date(); if (kind === 'daily') d.setDate(d.getDate() - 1); else if (kind === 'weekly') d.setDate(d.getDate() - 7); else { d.setDate(1); d.setDate(0); }
      return post('/admin/reports', { kind, day: iso(d) });
    }, { ok: (r) => (r.created ? 'Rapport créé' : 'Ce rapport existe déjà'), refresh }) }, label);
    return h('div', {},
      eyeRow(pageHead('Rapports financiers', 'Archivés, non modifiables. Activez la génération automatique dans Réglages > Fonctions.')),
      h('div', { class: 'gap wrap' }, make('daily', 'Rapport d\'hier'), make('weekly', 'Semaine dernière'), make('monthly', 'Mois dernier')),
      table(['Type', 'Période', 'Livrées', 'Ventes livrées', 'Revenu plateforme', 'Charges', 'Origine'], reports.map((r) => {
        const d = r.data;
        return [KIND[r.kind], r.from === r.to ? dayFr(r.from) : `${dayFr(r.from)} → ${dayFr(r.to)}`, String(d.delivered.count), fmtGNF(d.delivered.sale_total), fmtGNF(d.platform_revenue), fmtGNF(d.platform_charges), badge(r.auto ? 'Automatique' : 'Manuel', r.auto ? 'info' : 'grey')];
      }), { empty: empty('book', 'Aucun rapport pour le moment.') }));
  });
}

// ---------- Dettes et créances (administrateur) ----------
const ROLES = { seller: 'Vendeurs', supplier: 'Fournisseurs', courier: 'Livreurs', agent: 'Agents', call_chief: 'Chefs d\'équipe', warehouse: 'Magasiniers', member: 'Membres', shipper: 'Expéditeurs' };
export function adminDebts() {
  return liveView(() => get('/admin/debts'), (d) => h('div', {},
    eyeRow(pageHead('Dettes et créances', 'Ce que Wallindirain doit, et ce qu\'elle attend.')),
    h('div', { class: 'card' }, h('h3', {}, 'À payer (soldes des portefeuilles)'),
      kv([['Total dû', fmtGNF(d.owed.total), 'key'], ['dont retraits déjà demandés', `${d.owed.withdrawals_waiting.count} · ${fmtGNF(d.owed.withdrawals_waiting.total)}`]]),
      table(['Catégorie', 'Personnes', 'Disponible', 'En attente'], d.owed.by_role.map((x) => [ROLES[x.role] || x.role, String(x.people), fmtGNF(x.available), fmtGNF(x.pending)]), { empty: empty('wallet', 'Aucun solde positif.') })),
    h('div', { class: 'card mt' }, h('h3', {}, 'À recevoir (argent encaissé par les livreurs)'),
      kv([['Total attendu', fmtGNF(d.receivable.total), 'key'], ['reversements à contrôler', `${d.receivable.remittances_pending.count} · ${fmtGNF(d.receivable.remittances_pending.total)}`]]),
      table(['Livreur', 'Colis', 'Montant', 'Depuis'], d.receivable.couriers.map((x) => [x.courier, String(x.orders), fmtGNF(x.amount), fmtDate(x.since)]), { empty: empty('checkCircle', 'Aucun argent en attente.') })),
    h('p', { class: 'hint' }, 'Solde du portefeuille de la plateforme : ', fmtGNF(d.platform_balance))));
}

// ---------- Performances commerciales (administrateur et vendeur) ----------
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}, ...kids) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); n.append(...kids); return n; };
/** Courbe en barres (SVG, sans style en ligne) : ventes livrées par jour ou par semaine, avec la valeur au toucher. */
function evolution(series, weekly, onPick) {
  const W = 320, H = 120, pad = 4, max = Math.max(1, ...series.map((x) => x.sales)), bw = Math.max(2, Math.min(18, (W - pad * 2) / Math.max(series.length, 1) - 2));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'perf-chart', role: 'img', 'aria-label': `Ventes livrées ${weekly ? 'par semaine' : 'par jour'}` });
  series.forEach((x, i) => {
    const bh = Math.max(x.sales ? 3 : 1, (x.sales / max) * (H - 14)), cx = pad + (i + 0.5) * ((W - pad * 2) / series.length);
    const r = svgEl('rect', { x: cx - bw / 2, y: H - bh, width: bw, height: bh, rx: 2, class: x.sales ? 'bar' : 'bar zero', tabindex: 0 });
    const pick = () => onPick(x); r.addEventListener('click', pick); r.addEventListener('focus', pick); svg.append(r);
  });
  return svg;
}
const SORTS = { sales: ['Ventes', (a, b) => b.sales - a.sales], qty: ['Quantité', (a, b) => b.qty - a.qty || b.sales - a.sales], rate: ['Taux de livraison', (a, b) => (b.orders ? b.delivered / b.orders : 0) - (a.orders ? a.delivered / a.orders : 0) || b.delivered - a.delivered] };
export function performanceView() {
  const body = h('div', {});
  const state = { days: 30, sort: 'sales', data: null };
  const draw = () => {
    const p = state.data; if (!p) return;
    const t = p.totals, rate = t.orders ? Math.round((100 * t.delivered) / t.orders) : 0;
    const pick = h('p', { class: 'hint' }, 'Touchez une barre pour voir le détail.');
    const prods = [...p.products].sort(SORTS[state.sort][1]);
    const sortBar = h('div', { class: 'wallet-tabs', role: 'group', 'aria-label': 'Classer les produits par' }, Object.entries(SORTS).map(([k, [l]]) =>
      h('button', { type: 'button', 'aria-pressed': String(k === state.sort), onclick: () => { state.sort = k; draw(); } }, l)));
    body.replaceChildren(...[
      kv([['Commandes', String(t.orders)], ['Livrées', `${t.delivered} (${rate} %)`, 'key'], ['Perdues (retour, refus, annulation)', String(t.lost)], ['En cours', String(t.in_progress)], ['Ventes livrées', fmtGNF(t.sales)],
        p.scope === 'admin' ? ['Revenu de la plateforme', fmtGNF(t.platform_revenue)] : ['Mes gains', fmtGNF(t.gains)]]),
      h('h3', {}, p.weekly ? 'Évolution par semaine' : 'Évolution par jour'),
      p.series.length ? h('div', { class: 'card' }, evolution(p.series, p.weekly, (x) => pick.replaceChildren(`${p.weekly ? 'Semaine du ' : ''}${dayFr(x.d)} : ${x.orders} commande(s), ${x.delivered} livrée(s), `, fmtGNF(x.sales))), pick) : empty('chart', 'Aucune commande sur la période.'),
      p.scope === 'admin' ? h('div', {}, h('h3', {}, 'Par vendeur'), table(['Vendeur', 'Commandes', 'Livrées', 'Perdues', 'Ventes'], p.sellers.map((x) => [x.name, String(x.orders), String(x.delivered), String(x.lost), fmtGNF(x.sales)]))) : null,
      h('h3', {}, 'Meilleurs produits'), sortBar,
      table(['Produit', 'Commandes', 'Livrées', 'Quantité', 'Taux', 'Ventes'], prods.map((x) => [x.name, String(x.orders), String(x.delivered), String(x.qty), `${x.orders ? Math.round((100 * x.delivered) / x.orders) : 0} %`, fmtGNF(x.sales)]),
        { empty: empty('package', 'Vos meilleurs produits apparaîtront ici après les premières commandes.') }),
      h('h3', {}, 'Par zone'), table(['Zone', 'Commandes', 'Livrées', 'Perdues'], p.zones.map((x) => [x.commune, String(x.orders), String(x.delivered), String(x.lost)]), { empty: empty('pin', 'Aucune commande sur la période.') })].filter(Boolean));
  };
  const load = async () => {
    const to = new Date(), from = new Date(); from.setDate(from.getDate() - state.days + 1);
    try { state.data = await get(`/performance?from=${iso(from)}&to=${iso(to)}`); draw(); } catch (e) { body.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  };
  const bar = h('div', { class: 'wallet-tabs', role: 'group', 'aria-label': 'Période' }, [[7, '7 j'], [30, '1 M'], [90, '3 M'], [364, '1 A']].map(([n, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(n === state.days), onclick: (e) => { state.days = n; [...bar.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); load(); } }, l)));
  load();
  return h('div', {}, eyeRow(pageHead('Performances', 'Livraisons réussies, pertes, ventes.')), bar, body);
}

// ---------- Historique d'un produit ----------
const EV_ICO = { created: 'plus', order: 'package', price: 'banknote', name: 'scroll', arrival: 'truck', count: 'checkCircle', loss: 'alert', return: 'arrowRight', paused: 'clock', retired: 'clock' };
export const productHistoryButton = (id, name) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open(`Historique : ${name}`, () => get(`/products/${id}/history`), (r) =>
  h('div', {}, kv([['Statut', r.product.status], ['Stock', `${r.product.stock_qty} (réservé ${r.product.reserved_qty})`]]),
    h('ul', { class: 'tl-p' }, r.events.map((e) => h('li', {}, icon(EV_ICO[e.kind] || 'clock', 16), h('span', { class: 'grow' }, e.text), h('time', {}, fmtDate(e.at)))))))
  }, [icon('clock', 16), ' Historique']);

// ---------- Dossier d'une commande / d'un retrait ----------
const invList = (list) => list.length ? h('div', { class: 'gap wrap' }, list.map((i) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openInvoice(i.id).catch((e) => toast(e.message, 'bad')) }, [icon('receipt', 16), ` ${i.number}`]))) : h('p', { class: 'hint' }, 'Aucune facture émise.');
export const orderDossierButton = (id) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open('Dossier de la commande', () => get(`/orders/${id}/dossier`), (r) =>
  h('div', {}, kv([['Commande', r.order.ref], ['Produit', `${r.order.product} × ${r.order.qty}`], ['Total', fmtGNF(r.order.sale_total), 'key'], ['Zone', r.order.commune], ['Statut', statusBadge(r.order.status)],
      r.payment && ['Paiement client', r.payment.method === 'cash' ? 'Espèces' : `${r.payment.method}${r.payment.reference ? ` (${r.payment.reference})` : ''}`],
      r.cash && ['Caisse du livreur', `${fmtGNF(r.cash.amount)} · ${r.cash.remitted ? 'reversé' : r.cash.counted ? 'compté' : 'à reverser'}`]]),
    r.payment?.proof_id && h('div', { class: 'mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => showProof(r.payment.proof_id) }, [icon('receipt', 16), ' Capture du paiement'])),
    h('h3', {}, 'Factures'), invList(r.invoices),
    h('h3', {}, 'Événements'), h('ul', { class: 'tl-p' }, r.history.map((e) => h('li', {}, icon('clock', 16), h('span', { class: 'grow' }, `${e.from ? `${e.from} → ` : ''}${e.to}${e.note ? ` : ${e.note}` : ''}`), h('time', {}, fmtDate(e.at)))))))
  }, [icon('book', 16), ' Dossier']);
export const withdrawalDossierButton = (id) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open('Dossier du retrait', () => get(`/withdrawals/${id}/dossier`), (r) =>
  h('div', {}, kv([r.withdrawal.owner && ['Titulaire', r.withdrawal.owner], ['Montant', fmtGNF(r.withdrawal.amount), 'key'], ['Mode', { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' }[r.withdrawal.method] || 'Autre'], ['Statut', r.withdrawal.status],
      ['Demandé', fmtDate(r.withdrawal.created_at)], r.withdrawal.decided_at && ['Traité', fmtDate(r.withdrawal.decided_at)], r.withdrawal.payment_ref && ['Référence', r.withdrawal.payment_ref]]),
    r.proofs.length > 0 && h('div', { class: 'mt' }, r.proofs.map((p) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => showProof(p.id) }, [icon('receipt', 16), ' Preuve du paiement']))),
    h('h3', {}, 'Reçu'), invList(r.invoices)))
  }, [icon('book', 16), ' Dossier']);
