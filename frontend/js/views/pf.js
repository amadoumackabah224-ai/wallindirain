// « Mes finances » : outil de gestion financière personnelle pour tous les rôles (migration 048).
// Écran plein écran, sombre, avec sa propre barre du bas : Tableau de bord · Plan financier · Contacts · Statistiques · Plus.
// Ce sont des notes personnelles : le compte « Wallindirain » affiché est le vrai portefeuille, en lecture seule.
import { h, fmtGNF, liveView, badge, ask, confirmBox, action, toast, errToast, empty, fmtPhone } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { gaugeSvg, areaChart } from './pf-charts.js';

export const INCOME_LABEL = { sales: 'Ventes', salary: 'Salaire', gift: 'Cadeau', other_in: 'Autre revenu' };
export const EXPENSE_LABEL = { food: 'Alimentation', transport: 'Transport', housing: 'Logement', telecom: 'Téléphone et internet', health: 'Santé', family: 'Famille', business: 'Activité', shopping: 'Achats', savings: 'Épargne', other_out: 'Autre dépense' };
const CAT_LABEL = { ...INCOME_LABEL, ...EXPENSE_LABEL, transfer: 'Virement' };
const KIND_LABEL = { cash: 'Espèces', mobile_money: 'Mobile money', bank: 'Banque', savings: 'Épargne', other: 'Autre' };
const KIND_ICON = { cash: 'banknote', mobile_money: 'phoneMoney', bank: 'bank', savings: 'wallet', other: 'wallet' };
const COLOR_LABEL = { blue: 'Bleu', green: 'Vert', orange: 'Orange', red: 'Rouge', purple: 'Violet', brown: 'Marron', teal: 'Turquoise', grey: 'Gris' };
const today = () => new Date().toISOString().slice(0, 10);
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtShort = (n) => { const a = Math.abs(n); const s = n < 0 ? '-' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(2).replace('.', ',')}M` : a >= 1e3 ? `${s}${Math.round(a / 1e3)}k` : `${s}${a}`; };
const money = (n, signed = false) => `${signed && n > 0 ? '+' : ''}${fmtGNF(n)}`;

const TABS = [['home', 'dashboard', 'Tableau de bord'], ['plan', 'clock', 'Plan financier'], ['contacts', 'users', 'Contacts'], ['stats', 'chart', 'Statistiques'], ['more', 'more', 'Plus']];

/** Point d'entrée : `#/pf/<écran>`. */
export function pfApp(user, screen = '') {
  const go = (s) => { location.hash = `#/pf/${s}`; };
  const SCREENS = { '': homeScreen, home: homeScreen, plan: planScreen, contacts: contactsScreen, stats: statsScreen, more: moreScreen, accounts: accountsScreen, tx: txScreen, pro: proScreen, settings: settingsScreen, gauges: gaugesScreen };
  const key = SCREENS[screen] ? screen : '';
  const tabOf = ({ '': 'home', home: 'home', plan: 'plan', contacts: 'contacts', stats: 'stats' })[key] || 'more';
  document.title = 'Mes finances · Wallindirain';
  const body = h('div', { class: 'pf-body' }, liveView(() => get('/pf/status'), (st, refresh) => {
    if (!st.enabled) return h('div', { class: 'pf-pad' }, empty('bank', 'Mes finances n\'est pas encore disponible. Vous serez prévenu dès son ouverture.'), backLink());
    return SCREENS[key]({ user, go, st, reload: refresh });
  }));
  const bar = h('nav', { class: 'pf-bar', 'aria-label': 'Mes finances' }, TABS.map(([k, ico, label]) => h('button', { class: `pf-tab${k === tabOf ? ' on' : ''}`, type: 'button', 'aria-current': k === tabOf ? 'page' : null, onclick: () => go(k === 'home' ? '' : k) },
    icon(ico, 26), h('span', {}, label))));
  return h('div', { class: 'pf-root' }, body, bar);
}

function backLink() { return h('a', { class: 'pf-link', href: '#/app/' }, '‹ Retour à Wallindirain'); }
const head = (title, { back, right } = {}) => h('header', { class: 'pf-head' }, h('div', { class: 'pf-head-row' },
  back ? h('button', { class: 'pf-back', type: 'button', onclick: back[1] }, icon('chevronRight', 20), h('span', {}, back[0])) : h('a', { class: 'pf-back', href: '#/app/' }, icon('chevronRight', 20), h('span', {}, 'Wallindirain')), h('span', { class: 'grow' }), right),
  h('h1', { class: 'pf-title' }, title));
const card = (title, ...children) => h('section', { class: 'pf-card' }, title && h('div', { class: 'pf-card-head' }, h('h2', {}, title)), ...children);
const proBadge = () => h('span', { class: 'pf-pro' }, 'PRO');
const moreLink = (label, onclick) => h('button', { class: 'pf-more', type: 'button', onclick }, label);

// ---------- formulaires ----------
const accountOptions = (accounts, writableOnly = true) => accounts.filter((a) => !a.archived_at && (!writableOnly || a.writable)).map((a) => [a.id, a.name]);

async function askTx(kind, accounts, existing) {
  const list = accountOptions(accounts);
  if (!list.length) { toast(accounts.some((a) => !a.archived_at) ? 'Aucun compte utilisable dans la formule gratuite : passez à Pro.' : 'Créez d\'abord un compte.', 'bad'); return false; }
  const labels = kind === 'income' ? INCOME_LABEL : EXPENSE_LABEL;
  const v = await ask({ title: existing ? 'Modifier la transaction' : kind === 'income' ? 'Nouveau revenu' : 'Nouvelle dépense', submit: 'Enregistrer', fields: [
    { name: 'account_id', label: 'Compte', type: 'select', options: list, value: existing?.account_id || list[0][0] },
    { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: existing?.amount ?? '' },
    { name: 'category', label: 'Catégorie', type: 'select', options: Object.entries(labels), value: existing?.category || Object.keys(labels)[0] },
    { name: 'occurred_on', label: 'Date', type: 'date', value: existing?.occurred_on || today() },
    { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200, value: existing?.note || '' }] });
  if (!v) return false;
  const body = { account_id: v.account_id, amount: Number(v.amount), category: v.category, occurred_on: v.occurred_on, note: v.note || undefined };
  if (existing) await post(`/pf/transactions/${existing.id}/update`, body); else await post('/pf/transactions', { ...body, kind });
  return true;
}
async function askTransfer(accounts) {
  const list = accountOptions(accounts);
  if (list.length < 2) { toast('Il faut au moins deux comptes pour faire un virement.', 'bad'); return false; }
  const v = await ask({ title: 'Virement entre mes comptes', text: 'L\'argent passe d\'un de vos comptes à un autre. Cela ne change ni vos revenus ni vos dépenses.', submit: 'Virer', fields: [
    { name: 'from', label: 'Du compte', type: 'select', options: list, value: list[0][0] }, { name: 'to', label: 'Vers le compte', type: 'select', options: list, value: list[1][0] },
    { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' }, { name: 'occurred_on', label: 'Date', type: 'date', value: today() },
    { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200 }] });
  if (!v) return false;
  await post('/pf/transfers', { from: v.from, to: v.to, amount: Number(v.amount), occurred_on: v.occurred_on, note: v.note || undefined });
  return true;
}
async function askAccount(existing) {
  const v = await ask({ title: existing ? 'Modifier le compte' : 'Nouveau compte', text: existing ? '' : 'Un compte est une de vos « poches » : espèces, Orange Money, banque, épargne…', submit: 'Enregistrer', fields: [
    { name: 'name', label: 'Nom (ex. Orange Money, Espèces)', value: existing?.name || '', maxlength: 40 },
    { name: 'kind', label: 'Type', type: 'select', options: Object.entries(KIND_LABEL), value: existing?.kind || 'mobile_money' },
    { name: 'color', label: 'Couleur', type: 'select', options: Object.entries(COLOR_LABEL), value: existing?.color || 'blue' },
    { name: 'opening_balance', label: 'Solde de départ (GNF)', type: 'number', inputmode: 'numeric', value: existing?.opening_balance ?? 0, required: false, hint: 'Ce que contient ce compte aujourd\'hui.' }] });
  if (!v) return false;
  await post('/pf/accounts', { id: existing?.id, name: v.name, kind: v.kind, color: v.color, opening_balance: Number(v.opening_balance || 0) });
  return true;
}
/** Menu « + » : dépense, revenu, virement, compte. */
function addMenu(accounts, done) {
  const run = (fn) => async () => { try { if (await fn()) { done(); } } catch (e) { errToast(e); } };
  const items = [['Nouvelle dépense', 'arrowUpRight', () => askTx('expense', accounts)], ['Nouveau revenu', 'plus', () => askTx('income', accounts)], ['Virement entre comptes', 'arrowRight', () => askTransfer(accounts)], ['Nouveau compte', 'bank', () => askAccount()]];
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, h('div', { class: 'modal sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ajouter' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'more-list' }, items.map(([label, ico, fn]) => h('button', { class: 'more-row', type: 'button', onclick: () => { close(); run(fn)(); } }, icon(ico, 22), h('span', { class: 'grow' }, label), icon('chevronRight', 18)))),
    h('button', { class: 'btn btn-ghost btn-block mt', type: 'button', onclick: close }, 'Fermer')));
  document.body.append(overlay);
}
const fab = (accounts, done) => h('button', { class: 'pf-fab', type: 'button', 'aria-label': 'Ajouter', onclick: () => addMenu(accounts, done) }, icon('plus', 28));

const accountRow = (a, onclick) => h('button', { class: `pf-row${a.archived_at ? ' dim' : ''}`, type: 'button', onclick },
  h('span', { class: `pf-ico pf-c-${a.color || 'blue'}` }, icon(KIND_ICON[a.kind] || 'wallet', 24)),
  h('span', { class: 'pf-row-main' }, h('b', {}, a.name), h('span', { class: 'pf-amt' }, money(a.balance)), h('small', {}, a.archived_at ? 'Archivé' : a.writable === false ? 'Lecture seule (formule gratuite)' : KIND_LABEL[a.kind])), icon('chevronRight', 18));
const wallindirainRow = (w) => h('a', { class: 'pf-row', href: '#/app/wallet' },
  h('span', { class: 'pf-ico pf-c-gold' }, icon('wallet', 24)),
  h('span', { class: 'pf-row-main' }, h('b', {}, 'Portefeuille Wallindirain'), h('span', { class: 'pf-amt' }, money(w.available)), h('small', {}, `Lecture seule${w.pending > 0 ? ` · ${money(w.pending)} en attente` : ''}`)), icon('chevronRight', 18));
const txRow = (t, onclick) => h('button', { class: 'pf-row', type: 'button', onclick },
  h('span', { class: `pf-ico pf-c-${t.color || 'blue'}` }, icon(t.kind === 'income' ? 'plus' : t.kind === 'expense' ? 'arrowUpRight' : 'arrowRight', 22)),
  h('span', { class: 'pf-row-main' }, h('b', {}, CAT_LABEL[t.category] || t.category), h('span', { class: `pf-amt ${t.kind === 'income' || t.kind === 'transfer_in' ? 'pos' : t.kind === 'expense' ? 'neg' : ''}` }, money(t.kind === 'expense' || t.kind === 'transfer_out' ? -t.amount : t.amount, true)), h('small', {}, `${t.account_name} · ${dayLabel(t.occurred_on)}${t.note ? ` · ${t.note}` : ''}`)));

async function editTx(t, accounts, done) {
  const isTransfer = t.kind === 'transfer_in' || t.kind === 'transfer_out';
  const v = await ask({ title: CAT_LABEL[t.category] || 'Transaction', text: `${money(t.amount)} · ${t.account_name} · ${dayLabel(t.occurred_on)}`, submit: isTransfer ? 'Fermer' : 'Modifier', fields: [] });
  if (!v) return;
  try {
    if (isTransfer) { if (await confirmBox('Annuler ce virement ?', 'Il sera annulé des deux comptes.', 'Annuler le virement', true)) { await post(`/pf/transactions/${t.id}/void`); toast('Virement annulé', 'ok'); done(); } return; }
    if (await askTx(t.kind, accounts, t)) { toast('Transaction modifiée', 'ok'); done(); }
  } catch (e) { errToast(e); }
}
const voidTx = (t, done) => action(async () => { if (await confirmBox('Supprimer cette transaction ?', 'Elle ne comptera plus dans vos soldes (conservée dans l\'historique interne).', 'Supprimer', true)) { await post(`/pf/transactions/${t.id}/void`); return true; } }, { ok: (r) => (r ? 'Transaction supprimée' : ''), refresh: done });

// ---------- Tableau de bord ----------
function homeScreen({ go, reload }) {
  let days = 30;
  return liveView(() => get(`/pf/home?days=${days}`), (d, refresh) => {
    const chip = (n, label) => h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(days === n), onclick: () => { if (n > 30 && d.tier !== 'pro') { go('pro'); return; } days = n; refresh(); } }, label, n > 30 && d.tier !== 'pro' ? ' 🔒' : '');
    const active = d.accounts.filter((a) => !a.archived_at);
    const total = d.income + d.expense;
    return h('div', {},
      head('Tableau de bord'),
      h('div', { class: 'pf-pad' },
        h('div', { class: 'pf-chips' }, chip(30, '30 jours'), chip(90, '90 jours'), chip(365, '1 an')),
        h('div', { class: 'pf-gauges' },
          h('div', { class: 'pf-g side' }, gaugeSvg(d.gauges.income, 96), h('span', { class: 'pf-g-l' }, 'Revenus'), h('b', {}, fmtShort(d.income))),
          h('div', { class: 'pf-g main' }, gaugeSvg(d.gauges.flow, 150), h('span', { class: 'pf-g-l' }, 'Flux de trésorerie'), h('b', {}, fmtShort(d.flow))),
          h('div', { class: 'pf-g side' }, gaugeSvg(d.gauges.balance, 96), h('span', { class: 'pf-g-l' }, 'Solde'), h('b', {}, fmtShort(d.balance)))),
        active.length === 0 && card(null, h('div', { class: 'pf-start' }, h('span', { class: 'pf-ico pf-c-blue' }, icon('bank', 26)), h('div', {}, h('b', {}, 'Comment commencer ?'), h('p', {}, 'Créez votre premier compte (espèces, Orange Money…) puis notez vos revenus et vos dépenses.'),
          h('button', { class: 'pf-btn', type: 'button', onclick: action(async () => { await askAccount(); }, { ok: 'Compte créé', refresh }) }, 'Créer un compte')))),
        d.priced && d.tier !== 'pro' && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Formule gratuite · budgets, historique complet et statistiques avec Pro'), icon('chevronRight', 18)),
        d.on_trial && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, `Essai Pro jusqu'au ${new Date(d.trial_until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`), icon('chevronRight', 18)),
        card('Évolution du solde', h('div', { class: 'pf-sub' }, 'AUJOURD\'HUI'), h('div', { class: 'pf-big' }, fmtGNF(d.balance)), areaChart(d.series.map((p) => p.balance), d.series.map((p) => p.day))),
        card('Comptes', active.slice(0, 3).map((a) => accountRow(a, () => go('accounts'))), wallindirainRow(d.wallindirain), moreLink('Afficher plus', () => go('accounts'))),
        card('Flux de trésorerie', h('div', { class: 'pf-sub' }, `${days === 365 ? 'DERNIÈRE ANNÉE' : `${days} DERNIERS JOURS`}`), h('div', { class: 'pf-big' }, fmtGNF(d.flow)),
          flowBar('Tous les revenus', d.income, total, 'pos'), flowBar('Toutes les dépenses', d.expense, total, 'neg'), moreLink('Afficher plus', () => go('stats'))),
        d.recent.length > 0 && card('Dernières transactions', d.recent.map((t) => txRow(t, () => go('tx'))), moreLink('Tout voir', () => go('tx')))),
      fab(d.accounts, () => { refresh(); }));
  });
}
function flowBar(label, value, total, tone) {
  const bar = h('span', { class: `pf-bar-fill ${tone}` }); bar.style.width = `${total > 0 ? Math.round((value * 100) / total) : 0}%`;
  return h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, label), h('span', {}, fmtGNF(value))), h('span', { class: 'pf-bar-track' }, bar));
}

// ---------- Comptes ----------
function accountsScreen({ go }) {
  return liveView(() => get('/pf/accounts'), (o, refresh) => {
    const open = (a) => async () => {
      const v = await ask({ title: a.name, text: `${KIND_LABEL[a.kind]} · solde ${money(a.balance)}`, submit: 'Modifier', fields: [] });
      if (!v) return;
      try { if (await askAccount(a)) { toast('Compte modifié', 'ok'); refresh(); } } catch (e) { errToast(e); }
    };
    const archive = (a) => action(async () => { await post(`/pf/accounts/${a.id}/archive`, { archived: !a.archived_at }); }, { ok: a.archived_at ? 'Compte rétabli' : 'Compte archivé', refresh });
    return h('div', {}, head('Comptes', { back: ['Plus', () => go('more')] }),
      h('div', { class: 'pf-pad' },
        o.accounts.length === 0 ? empty('bank', 'Aucun compte pour le moment.') : h('section', { class: 'pf-card flush' }, o.accounts.map((a) => h('div', { class: 'pf-acc' }, accountRow(a, open(a)),
          h('button', { class: 'pf-mini', type: 'button', onclick: archive(a) }, a.archived_at ? 'Rétablir' : 'Archiver')))),
        h('p', { class: 'pf-note' }, 'Ces comptes sont vos notes personnelles. Ils ne contiennent pas d\'argent détenu par Wallindirain et n\'ont aucun effet sur votre portefeuille.')),
      fab(o.accounts, refresh));
  });
}

// ---------- Transactions ----------
function txScreen({ go }) {
  let kind = '', text = '';
  const host = h('div', {});
  const load = async () => {
    const [accs, res] = await Promise.all([get('/pf/accounts'), get(`/pf/transactions?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(text ? { q: text } : {}) })}`)]);
    const done = load;
    host.replaceChildren(h('div', { class: 'pf-pad' },
      h('div', { class: 'pf-chips' }, [['', 'Tout'], ['income', 'Revenus'], ['expense', 'Dépenses'], ['transfer', 'Virements']].map(([k, l]) => h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(kind === k), onclick: () => { kind = k; load(); } }, l))),
      h('input', { class: 'pf-search', type: 'search', placeholder: 'Rechercher une note…', value: text, 'aria-label': 'Rechercher', onchange: (e) => { text = e.target.value.trim(); load(); } }),
      res.transactions.length === 0 ? empty('receipt', 'Aucune transaction.') : h('section', { class: 'pf-card flush' }, res.transactions.map((t) => txRow(t, () => editTx(t, accs.accounts, done)))),
      res.history_limited && h('p', { class: 'pf-note' }, `Formule gratuite : les ${res.history_limited} derniers jours sont affichés. L'historique plus ancien est conservé.`)),
      fab(accs.accounts, done));
  };
  load().catch(errToast);
  return h('div', {}, head('Transactions', { back: ['Plus', () => go('more')] }), host);
}

// ---------- Statistiques ----------
function statsScreen({ go }) {
  let days = 30;
  return liveView(() => get(`/pf/home?days=${days}`), (d, refresh) => {
    const chip = (n, label) => h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(days === n), onclick: () => { if (n > 30 && d.tier !== 'pro') { go('pro'); return; } days = n; refresh(); } }, label, n > 30 && d.tier !== 'pro' ? ' 🔒' : '');
    const cats = (list, labels, tone) => list.length === 0 ? h('p', { class: 'pf-note' }, 'Rien sur cette période.') : list.map((c) => {
      const max = list[0].total; const f = h('span', { class: `pf-bar-fill ${tone}` }); f.style.width = `${Math.max(4, Math.round((c.total * 100) / max))}%`;
      return h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, labels[c.category] || c.category), h('span', {}, fmtGNF(c.total))), h('span', { class: 'pf-bar-track' }, f));
    });
    return h('div', {}, head('Statistiques'), h('div', { class: 'pf-pad' },
      h('div', { class: 'pf-chips' }, chip(30, '30 jours'), chip(90, '90 jours'), chip(365, '1 an')),
      card('Résumé', h('dl', { class: 'pf-kv' }, h('dt', {}, 'Revenus'), h('dd', { class: 'pos' }, fmtGNF(d.income)), h('dt', {}, 'Dépenses'), h('dd', { class: 'neg' }, fmtGNF(d.expense)), h('dt', {}, 'Flux net'), h('dd', {}, fmtGNF(d.flow)), h('dt', {}, 'Solde actuel'), h('dd', {}, fmtGNF(d.balance)))),
      card('Dépenses par catégorie', cats(d.expense_by_category, EXPENSE_LABEL, 'neg')),
      card('Revenus par catégorie', cats(d.income_by_category, INCOME_LABEL, 'pos')),
      card('Évolution du solde', areaChart(d.series.map((p) => p.balance), d.series.map((p) => p.day)))));
  });
}

// ---------- Plan financier et Contacts (reliés aux outils existants ; refonte dans les étapes suivantes) ----------
function planScreen({ user, go }) {
  const seller = user.role === 'seller';
  return h('div', {}, head('Plan financier'), h('div', { class: 'pf-pad' },
    card('Budgets, objectifs et prévisions', h('p', { class: 'pf-note' }, seller ? 'Votre prévision d\'argent à venir, vos dépenses récurrentes, votre budget et votre objectif du mois se trouvent déjà dans votre portefeuille.' : 'Cet espace accueillera bientôt vos budgets, objectifs et dépenses récurrentes.'),
      seller && h('a', { class: 'pf-btn', href: '#/app/wallet' }, 'Ouvrir mon tableau argent')),
    h('button', { class: 'pf-link', type: 'button', onclick: () => go('') }, '‹ Tableau de bord')));
}
function contactsScreen({ user, go }) {
  const seller = user.role === 'seller';
  return h('div', {}, head('Contacts'), h('div', { class: 'pf-pad' },
    card('Mes contacts', h('p', { class: 'pf-note' }, seller ? 'Vos clients, leurs étiquettes, vos notes et vos relances sont dans votre espace vendeur. Une fiche contact complète arrive bientôt.' : 'Le carnet de contacts arrive bientôt.'),
      seller && h('div', { class: 'pf-btns' }, h('a', { class: 'pf-btn', href: '#/app/customers' }, 'Mes clients'), h('a', { class: 'pf-btn', href: '#/app/relances' }, 'Relances'))),
    h('button', { class: 'pf-link', type: 'button', onclick: () => go('') }, '‹ Tableau de bord')));
}

// ---------- Plus, Paramètres, Pro ----------
function moreScreen({ go, st }) {
  const tile = (ico, label, sub, onclick, href) => h(href ? 'a' : 'button', { class: 'pf-tile', type: href ? null : 'button', href, onclick }, h('span', { class: 'pf-tile-ico' }, icon(ico, 30)), h('span', {}, label), sub && h('small', {}, sub));
  return h('div', {}, head('Plus'), h('div', { class: 'pf-pad' }, h('div', { class: 'pf-tiles' },
    tile('bank', 'Comptes', null, () => go('accounts')), tile('receipt', 'Transactions', null, () => go('tx')),
    tile('star', 'Formule', st.tier === 'pro' ? 'Pro' : 'Gratuite', () => go('pro')), tile('settings', 'Paramètres', null, () => go('settings')),
    tile('wallet', 'Portefeuille', 'Wallindirain', null, '#/app/wallet')),
    backLink()));
}
function settingsScreen({ go }) {
  const row = (ico, label, onclick, href) => h(href ? 'a' : 'button', { class: 'pf-set', type: href ? null : 'button', href, onclick }, icon(ico, 22), h('span', { class: 'grow' }, label), icon('chevronRight', 18));
  return h('div', {}, head('Paramètres', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' }, h('section', { class: 'pf-card flush' },
    row('sliders', 'Général', () => go('pro')), row('dashboard', 'Tableau de bord', () => go('')), row('chart', 'Paramètres des jauges', () => go('gauges')), row('bank', 'Comptes', () => go('accounts')),
    row('shield', 'Sécurité', null, '#/app/profile')),
    h('p', { class: 'pf-note' }, 'Vos données financières personnelles ne sont visibles que par vous. Vous pouvez archiver un compte à tout moment ; rien n\'est partagé avec les autres utilisateurs.')));
}
function gaugesScreen({ go }) {
  return liveView(() => get('/pf/home?days=30'), (d, refresh) => {
    const set = action(async () => {
      const v = await ask({ title: 'Objectifs des jauges', text: 'Ils placent l\'aiguille : plus vous approchez de l\'objectif, plus elle va vers le vert. Laissez vide pour un calcul automatique.', submit: 'Enregistrer', fields: [
        { name: 'income_target', label: 'Revenus visés sur la période (GNF)', type: 'number', inputmode: 'numeric', value: d.targets.income ?? '', required: false },
        { name: 'balance_target', label: 'Solde visé (GNF)', type: 'number', inputmode: 'numeric', value: d.targets.balance ?? '', required: false }] });
      if (!v) return;
      await post('/pf/prefs', { income_target: v.income_target === '' ? null : Number(v.income_target), balance_target: v.balance_target === '' ? null : Number(v.balance_target) });
    }, { ok: 'Objectifs enregistrés', refresh });
    return h('div', {}, head('Paramètres des jauges', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' }, card(null,
      h('dl', { class: 'pf-kv' }, h('dt', {}, 'Objectif de revenus'), h('dd', {}, d.targets.income ? fmtGNF(d.targets.income) : 'Automatique'), h('dt', {}, 'Objectif de solde'), h('dd', {}, d.targets.balance ? fmtGNF(d.targets.balance) : 'Automatique')),
      h('button', { class: 'pf-btn', type: 'button', onclick: set }, 'Modifier'))));
  });
}
function proScreen({ go, st, reload }) {
  const sub = (plan) => action(async () => {
    const price = plan === 'monthly' ? st.prices.monthly : st.prices.yearly;
    if (!(await confirmBox('Passer à Pro ?', `${fmtGNF(price)} seront prélevés sur votre portefeuille Wallindirain pour ${plan === 'monthly' ? '1 mois' : '12 mois'}.`, 'Payer'))) return;
    await post('/pf/subscribe', { plan });
  }, { ok: 'Vous êtes passé à Pro', refresh: reload });
  const until = st.paid_until ? new Date(st.paid_until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  return h('div', {}, head('Formule', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' },
    card(null, h('div', { class: 'pf-big' }, st.tier === 'pro' ? 'Pro' : 'Gratuite'), h('p', { class: 'pf-note' }, !st.priced ? 'Toutes les fonctions sont ouvertes pour le moment.' : st.tier === 'pro' ? (until && Date.parse(st.paid_until) > Date.now() ? `Abonnement actif jusqu'au ${until}.` : `Essai Pro jusqu'au ${new Date(st.trial_until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}.`) : 'Vous gardez vos données. Passez à Pro pour retrouver toutes les fonctions.')),
    card('Gratuit', h('ul', { class: 'pf-list' }, h('li', {}, `${st.free_accounts} comptes personnels`), h('li', {}, 'Revenus, dépenses et virements'), h('li', {}, `Historique des ${st.free_history_days} derniers jours`), h('li', {}, 'Tableau de bord sur 30 jours'))),
    card('Pro', h('ul', { class: 'pf-list' }, h('li', {}, 'Comptes illimités'), h('li', {}, 'Historique complet'), h('li', {}, 'Statistiques sur 90 jours et 1 an'), h('li', {}, 'Budgets, objectifs et prévisions (bientôt)'), h('li', {}, 'Règles automatiques et export (bientôt)')),
      st.priced ? h('div', { class: 'pf-btns' }, st.prices.monthly > 0 && h('button', { class: 'pf-btn', type: 'button', onclick: sub('monthly') }, `${fmtGNF(st.prices.monthly)} / mois`), st.prices.yearly > 0 && h('button', { class: 'pf-btn alt', type: 'button', onclick: sub('yearly') }, `${fmtGNF(st.prices.yearly)} / an`))
        : h('p', { class: 'pf-note' }, 'Aucun prix n\'est fixé pour le moment.')),
    h('p', { class: 'pf-note' }, 'Le paiement est prélevé sur votre portefeuille Wallindirain. Un abonnement terminé ne supprime rien : vos données restent, avec les limites de la formule gratuite.')));
}

export { fmtPhone, badge };
