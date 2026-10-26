// Tableau de bord du vendeur : l'essentiel d'un coup d'œil. Aucun calcul métier n'est refait ici : les montants viennent
// tels quels de l'API (portefeuille, commandes, statistiques) ; seules des additions d'affichage sont faites.
import { h, fmtGNF, fmtDate, liveView, statusBadge, empty, pageHead } from '../ui.js';
import { get } from '../api.js';
import { icon } from '../icons.js';
import { columnChart, segmentBar } from '../charts.js';
import { startCard } from './seller.js';

const PERIODS = [[7, '7 jours'], [30, '30 jours'], [90, '3 mois']];
const LIMIT = 200;
const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };

const skeleton = () => h('div', { class: 'skeleton', 'aria-busy': 'true', role: 'status', 'aria-label': 'Chargement' },
  h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk-row' }, [1, 2, 3, 4].map(() => h('div', { class: 'sk sk-tile' }))), h('div', { class: 'sk sk-block' }));

/** Montant en grand : nombre + devise plus petite. */
const bigMoney = (n) => { const t = fmtGNF(n); const i = t.lastIndexOf(' '); return h('span', { class: 'money-num' }, t.slice(0, i), h('small', {}, t.slice(i + 1))); };
const dayLabel = (d) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const capped = (n, total) => (total >= LIMIT && n > 0 ? `${n}+` : String(n));

function metric({ ico, tone, label, value, hint, onclick }) {
  return h('button', { class: `metric ${tone}`, type: 'button', onclick },
    h('span', { class: 'metric-ico' }, icon(ico, 20)), h('span', { class: 'metric-v' }, value), h('span', { class: 'metric-l' }, label), h('span', { class: 'metric-h' }, hint));
}
function mchip(tone, label, value, hint) {
  return h('div', { class: `mchip ${tone}` }, h('span', { class: 'mchip-l' }, h('i', { class: 'dot' }), label), h('b', { class: 'mchip-v' }, fmtGNF(value)), hint && h('span', { class: 'mchip-h' }, hint));
}
function alertRow(tone, ico, text, btnLabel, onclick) {
  return h('div', { class: `alert-row ${tone}`, role: 'note' }, icon(ico, 20), h('span', { class: 'grow' }, text), btnLabel && h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick }, btnLabel));
}

function alerts(w, goTo) {
  const out = [];
  if (!w.identity_verified) {
    if (w.kyc_status?.status === 'submitted') out.push(alertRow('warn', 'clock', 'Vos pièces d\'identité sont en cours d\'examen : les retraits seront possibles dès la validation.'));
    else if (w.kyc_status?.status === 'rejected') out.push(alertRow('bad', 'alert', `Votre pièce a été refusée : ${w.kyc_status.reject_reason || 'motif non précisé'}.`, 'Renvoyer mes photos', () => goTo('profile')));
    else out.push(alertRow('warn', 'shield', 'Faites vérifier votre identité pour pouvoir retirer votre argent.', 'Vérifier', () => goTo('profile')));
  }
  if (!(w.payout && w.payout.phone)) out.push(alertRow('warn', 'phoneMoney', 'Aucun numéro de versement (Orange Money ou MTN MoMo) n\'est enregistré.', 'Enregistrer', () => goTo('wallet')));
  if (w.subscription && w.subscription.monthly > 0 && w.subscription.required && !w.subscription.active) out.push(alertRow('bad', 'alert', 'Abonnement expiré : vous ne pouvez plus créer de commandes. Contactez Wallindirain pour le renouveler.'));
  return out.length ? h('div', { class: 'alerts' }, out) : null;
}

function moneySection(w, orders, goTo) {
  const free = w.available - (w.reserved || 0);                                     // même formule que l'écran Portefeuille
  const live = orders.filter((o) => ['new', 'in_call', 'confirmed', 'assigned', 'picked_up', 'on_the_way'].includes(o.status));
  const expected = live.reduce((a, o) => a + Number(o.expected_gain || 0), 0);
  const paid = w.withdrawals.length < 50 ? w.withdrawals.filter((x) => x.status === 'paid').reduce((a, x) => a + Number(x.amount), 0) : 0;
  const op = w.payout && w.payout.phone ? `${OPERATOR[w.payout.method] || 'Mobile Money'}` : null;
  return h('section', { class: 'money', 'aria-label': 'Mon argent' },
    h('div', { class: 'money-hero' },
      h('span', { class: 'money-lab' }, h('i', { class: 'dot' }), 'Disponible pour retrait'),
      bigMoney(free),
      h('p', { class: 'money-sub' }, op ? `Sera envoyé sur votre compte ${op}.` : 'Enregistrez un numéro de versement pour retirer.'),
      h('div', { class: 'gap' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: () => goTo('wallet') }, icon('arrowUpRight', 18), 'Demander un retrait'), h('button', { class: 'btn btn-onnavy', type: 'button', onclick: () => goTo('wallet') }, 'Voir le détail'))),
    h('div', { class: 'mchips' },
      mchip('warn', 'En attente de déblocage', w.pending, 'Disponible après le délai de sécurité'),
      mchip('info', 'Gains attendus', expected, live.length ? `Estimation sur ${live.length} commande${live.length > 1 ? 's' : ''} en cours` : 'Aucune commande en cours'),
      w.reserved > 0 ? mchip('grey', 'Réservé pour retrait', w.reserved, 'Débité quand l\'argent est envoyé') : null,
      paid > 0 ? mchip('grey', 'Déjà retiré', paid, 'Retraits payés') : null));
}

function ordersSection(orders, s, goTo) {
  const n = (...st) => orders.filter((o) => st.includes(o.status)).length;
  const total = orders.length;
  const todo = n('failed', 'return_pending'), call = n('new', 'in_call'), way = n('confirmed', 'assigned', 'picked_up', 'on_the_way');
  const go = () => goTo('orders');
  return h('section', { class: 'metrics', 'aria-label': 'Mes commandes' },
    metric({ ico: 'alert', tone: todo ? 'bad' : 'grey', label: 'À traiter', value: capped(todo, total), hint: todo ? 'Échecs et retours à suivre' : 'Rien à relancer', onclick: go }),
    metric({ ico: 'phone', tone: 'gold', label: 'En attente d\'appel', value: capped(call, total), hint: 'Le call center va appeler', onclick: go }),
    metric({ ico: 'bike', tone: 'info', label: 'En livraison', value: capped(way, total), hint: 'Confirmées, affectées, en route', onclick: go }),
    metric({ ico: 'checkCircle', tone: 'ok', label: 'Livrées (30 jours)', value: s ? s.delivered : '–', hint: s && s.delivery_rate != null ? `Taux de livraison ${String(s.delivery_rate).replace('.', ',')} %` : 'Pas encore de résultat', onclick: go }));
}

function latestOrders(orders, goTo) {
  const rows = orders.slice(0, 5);
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Dernières commandes'), h('button', { class: 'link-btn', type: 'button', onclick: () => goTo('orders') }, 'Tout voir', icon('chevronRight', 16))),
    rows.length ? h('ul', { class: 'o-list' }, rows.map((o) => h('li', {}, h('button', { class: 'o-row', type: 'button', onclick: () => goTo('orders'), 'aria-label': `Commande ${o.ref}, ${o.product_name}` },
      h('span', { class: 'o-main' }, h('b', {}, o.ref), h('span', { class: 'o-sub' }, `${o.product_name} × ${o.qty} · ${o.customer_name}`)),
      h('span', { class: 'o-side' }, statusBadge(o.status), h('span', { class: 'o-gain' }, `${o.status === 'delivered' ? 'Gain ' : 'Gain attendu '}${fmtGNF(o.expected_gain)}`), h('span', { class: 'o-date' }, fmtDate(o.created_at))))))
    ) : empty('package', 'Aucune commande pour le moment', h('button', { class: 'btn btn-gold', type: 'button', onclick: () => goTo('new') }, icon('plus', 18), 'Saisir ma première commande')));
}

function quickActions(goTo) {
  const qa = (ico, label, hint, to) => h('button', { class: 'qa', type: 'button', onclick: () => goTo(to) }, h('span', { class: 'qa-ico' }, icon(ico, 22)), h('span', { class: 'qa-t' }, label), h('span', { class: 'qa-h' }, hint));
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Actions rapides')),
    h('div', { class: 'qa-grid' }, qa('plus', 'Nouvelle commande', 'Saisir une vente', 'new'), qa('link', 'Mes liens de vente', 'Catalogue et prix', 'catalog'), qa('wallet', 'Mon portefeuille', 'Retraits et mouvements', 'wallet'), qa('chart', 'Mes chiffres', 'Résultats et trophées', 'stats')));
}

/** Complète l'affichage avec les semaines sans gain (valeur 0) pour que le graphique garde un repère de temps lisible : simple mise en forme. */
function lastWeeks(weeks, n) {
  const byDay = new Map(weeks.map((x) => [String(x.week).slice(0, 10), x]));
  const now = new Date(); const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));   // lundi de la semaine en cours
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(end.getTime() - i * 7 * 86400000).toISOString().slice(0, 10); out.push(byDay.get(d) || { week: d, gain: 0 }); }
  return out;
}

/** Gains par semaine et répartition des commandes, avec choix de la période. */
function performance(orders) {
  let days = 30;
  const host = h('div');
  const chips = h('div', { class: 'chips' }, PERIODS.map(([d, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === days), onclick: (e) => {
    days = d; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); load(); } }, l)));
  const load = () => host.replaceChildren(liveView(() => get(`/seller/stats?days=${days}`), (s) => {
    const weekLabel = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    const seg = [['Livrées', s.delivered, 'ok'], ['En cours', s.in_progress, 'info'], ['Échecs et retours', s.failed, 'bad'], ['Annulées', s.cancelled, 'grey']].map(([label, value, tone]) => ({ label, value, tone }));
    return h('div', {},
      h('div', { class: 'perf-kpis' }, h('div', {}, h('span', { class: 'k-l' }, 'Commandes'), h('b', {}, s.total)), h('div', {}, h('span', { class: 'k-l' }, 'Chiffre d\'affaires livré'), h('b', {}, fmtGNF(s.sales)))),
      h('h3', { class: 'sub-h' }, 'Gains par semaine'),
      s.weeks.length ? columnChart(lastWeeks(s.weeks, 8).map((x) => ({ label: weekLabel(x.week), value: Number(x.gain) })), fmtGNF) : h('p', { class: 'muted small' }, 'Aucun gain encore : ils apparaissent après les livraisons.'),
      s.total ? [h('h3', { class: 'sub-h' }, 'Répartition des commandes'), segmentBar(seg, s.total)] : null);
  }));
  load();
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Performance'), chips), host);
}

/** Écran d'accueil du vendeur. */
export function sellerDashboard({ goTo, user }) {
  const first = (user?.name || '').trim().split(/\s+/)[0] || '';
  return h('div', { class: 'dash' },
    pageHead(first ? `Bonjour ${first}` : 'Bonjour', dayLabel(new Date()), h('button', { class: 'btn btn-gold hide-sm', type: 'button', onclick: () => goTo('new') }, icon('plus', 18), 'Nouvelle commande')),
    liveView(() => Promise.all([get('/wallet'), get(`/seller/orders?limit=${LIMIT}`), get('/seller/stats?days=30')]), ([w, { orders }, s]) => h('div', {},
      alerts(w, goTo),
      moneySection(w, orders, goTo),
      ordersSection(orders, s, goTo),
      h('div', { class: 'dash-cols' }, h('div', {}, latestOrders(orders, goTo)), h('div', {}, quickActions(goTo), startSlot(goTo)))), { poll: 30000, placeholder: skeleton() }),
    performance());
}

/** « Pour bien démarrer » : visible seulement tant que toutes les étapes ne sont pas faites. */
function startSlot(goTo) { const box = h('div', { class: 'start-slot' }, startCard(goTo)); return box; }
