// « Mes finances » : outil de gestion financière personnelle pour tous les rôles (migration 048).
// Écran plein écran, sombre, avec sa propre barre du bas : Tableau de bord · Plan financier · Contacts · Statistiques · Plus.
// Ce sont des notes personnelles : le compte « Wallindirain » affiché est le vrai portefeuille, en lecture seule.
import { h, fmtGNF, eyeToggle, liveView, badge, ask, confirmBox, action, toast, errToast, empty, fmtPhone } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { gaugeSvg, areaChart } from './pf-charts.js';

export const INCOME_LABEL = { sales: 'Ventes', salary: 'Salaire', gift: 'Cadeau', other_in: 'Autre revenu' };
export const EXPENSE_LABEL = { food: 'Alimentation', transport: 'Transport', housing: 'Logement', telecom: 'Téléphone et internet', health: 'Santé', family: 'Famille', business: 'Activité', shopping: 'Achats', savings: 'Épargne', other_out: 'Autre dépense' };
const CAT_LABEL = { ...INCOME_LABEL, ...EXPENSE_LABEL, transfer: 'Virement' };
const KIND_LABEL = { wallindirain: 'Relié à Wallindirain', cash: 'Espèces', mobile_money: 'Mobile money', bank: 'Banque', savings: 'Épargne', other: 'Autre' };
const KIND_ICON = { wallindirain: 'wallet', cash: 'banknote', mobile_money: 'phoneMoney', bank: 'bank', savings: 'wallet', other: 'wallet' };
const COLOR_LABEL = { blue: 'Bleu', green: 'Vert', orange: 'Orange', red: 'Rouge', purple: 'Violet', brown: 'Marron', teal: 'Turquoise', grey: 'Gris' };
const today = () => new Date().toISOString().slice(0, 10);
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtShort = (n) => { const a = Math.abs(n); const s = n < 0 ? '-' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(2).replace('.', ',')}M` : a >= 1e3 ? `${s}${Math.round(a / 1e3)}k` : `${s}${a}`; };
const money = (n, signed = false) => `${signed && n > 0 ? '+' : ''}${fmtGNF(n)}`;

const TABS = [['home', 'dashboard', 'Tableau de bord'], ['plan', 'clock', 'Plan financier'], ['contacts', 'users', 'Contacts'], ['stats', 'chart', 'Statistiques'], ['more', 'more', 'Plus']];

/** Point d'entrée : `#/pf/<écran>`. */
export function pfApp(user, screen = '') {
  memberOnly = user.role === 'member';
  const go = (s) => { location.hash = `#/pf/${s}`; };
  const SCREENS = { '': homeScreen, home: homeScreen, plan: planScreen, recurring: recurringScreen, wallet: walletScreen, contacts: contactsScreen, stats: statsScreen, more: moreScreen, accounts: accountsScreen, tx: txScreen, pro: proScreen, settings: settingsScreen, gauges: gaugesScreen };
  const key = SCREENS[screen] ? screen : '';
  const tabOf = ({ '': 'home', home: 'home', plan: 'plan', recurring: 'plan', wallet: 'more', contacts: 'contacts', stats: 'stats' })[key] || 'more';
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
let memberOnly = false;   // compte membre : Mes finances est toute l'application, pas de retour vers Wallindirain
const head = (title, { back, right } = {}) => h('header', { class: 'pf-head' }, h('div', { class: 'pf-head-row' },
  back ? h('button', { class: 'pf-back', type: 'button', onclick: back[1] }, icon('chevronRight', 20), h('span', {}, back[0])) : (memberOnly ? null : h('a', { class: 'pf-back', href: '#/app/' }, icon('chevronRight', 20), h('span', {}, 'Wallindirain'))), h('span', { class: 'grow' }), right, eyeToggle()),
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
  h('span', { class: 'pf-row-main' }, h('b', {}, a.name), h('span', { class: 'pf-amt' }, money(a.balance)), h('small', {}, a.archived_at ? 'Archivé' : a.auto ? 'Automatique · lecture seule' : a.writable === false ? 'Lecture seule (formule gratuite)' : KIND_LABEL[a.kind])), icon('chevronRight', 18));
const wallindirainRow = (w) => h('a', { class: 'pf-row', href: '#/app/wallet' },
  h('span', { class: 'pf-ico pf-c-gold' }, icon('wallet', 24)),
  h('span', { class: 'pf-row-main' }, h('b', {}, 'Portefeuille Wallindirain'), h('span', { class: 'pf-amt' }, money(w.available)), h('small', {}, `Lecture seule${w.pending > 0 ? ` · ${money(w.pending)} en attente` : ''}`)), icon('chevronRight', 18));
const txRow = (t, onclick) => h('button', { class: 'pf-row', type: 'button', onclick },
  h('span', { class: `pf-ico pf-c-${t.color || 'blue'}` }, icon(t.kind === 'income' ? 'plus' : t.kind === 'expense' ? 'arrowUpRight' : 'arrowRight', 22)),
  h('span', { class: 'pf-row-main' }, h('b', {}, CAT_LABEL[t.category] || t.category), h('span', { class: `pf-amt ${t.kind === 'income' || t.kind === 'transfer_in' ? 'pos' : t.kind === 'expense' ? 'neg' : ''}` }, money(t.kind === 'expense' || t.kind === 'transfer_out' ? -t.amount : t.amount, true)), h('small', {}, `${t.account_name} · ${dayLabel(t.occurred_on)}${t.note ? ` · ${t.note}` : ''}`)));

async function editTx(t, accounts, done) {
  if (t.source === 'wallindirain') { toast('Ligne automatique : elle vient de votre portefeuille Wallindirain et ne se modifie pas ici.', 'ok'); return; }
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
function homeScreen({ go, reload, st }) {
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
        card('Comptes', active.slice(0, 3).map((a) => accountRow(a, () => go(a.auto ? 'wallet' : 'accounts'))), !active.some((a) => a.auto) && wallindirainRow(d.wallindirain), moreLink('Afficher plus', () => go('accounts'))),
        st.wallet?.eligible && !st.wallet.linked && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('wallet') }, icon('wallet', 22), h('span', {}, 'Reliez votre compte Wallindirain : gains, achats et retraits arrivent ici tout seuls.'), icon('chevronRight', 18)),
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
      if (a.auto) { go('wallet'); return; }
      const v = await ask({ title: a.name, text: `${KIND_LABEL[a.kind]} · solde ${money(a.balance)}`, submit: 'Modifier', fields: [] });
      if (!v) return;
      try { if (await askAccount(a)) { toast('Compte modifié', 'ok'); refresh(); } } catch (e) { errToast(e); }
    };
    const archive = (a) => action(async () => { await post(`/pf/accounts/${a.id}/archive`, { archived: !a.archived_at }); }, { ok: a.archived_at ? 'Compte rétabli' : 'Compte archivé', refresh });
    return h('div', {}, head('Comptes', { back: ['Plus', () => go('more')] }),
      h('div', { class: 'pf-pad' },
        o.accounts.length === 0 ? empty('bank', 'Aucun compte pour le moment.') : h('section', { class: 'pf-card flush' }, o.accounts.map((a) => h('div', { class: 'pf-acc' }, accountRow(a, open(a)),
          !a.auto && h('button', { class: 'pf-mini', type: 'button', onclick: archive(a) }, a.archived_at ? 'Rétablir' : 'Archiver')))),
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

// ---------- Plan financier (budgets, objectif du mois, récurrents, prévision) ----------
const FREQ_LABEL = { daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois' };
const lock = (go) => h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Le plan financier fait partie de la formule Pro. Vos données restent visibles.'), icon('chevronRight', 18));
const needPro = (d, go) => { if (d.tier === 'pro') return false; go('pro'); return true; };

async function askRecurring(existing) {
  const v = await ask({ title: existing ? 'Modifier le récurrent' : 'Nouveau récurrent', text: 'Un revenu ou une dépense qui revient. Il sert à la prévision : rien n\'est enregistré automatiquement.', submit: 'Enregistrer', fields: [
    { name: 'label', label: 'Nom (ex. Loyer, Salaire)', value: existing?.label || '', maxlength: 40 },
    { name: 'kind', label: 'Type', type: 'select', options: [['expense', 'Dépense'], ['income', 'Revenu']], value: existing?.kind || 'expense' },
    { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: existing?.amount ?? '' },
    { name: 'frequency', label: 'Fréquence', type: 'select', options: Object.entries(FREQ_LABEL), value: existing?.frequency || 'monthly' },
    { name: 'anchor_on', label: 'Prochaine date (mensuel : jour 1 à 28)', type: 'date', value: existing?.anchor_on || today() }] });
  if (!v) return false;
  const cat = v.kind === 'income' ? 'other_in' : 'other_out';
  const category = existing && existing.kind === v.kind ? existing.category : cat;
  await post('/pf/recurring', { id: existing?.id, label: v.label, kind: v.kind, category, amount: Number(v.amount), frequency: v.frequency, anchor_on: v.anchor_on });
  return true;
}
async function askBudget(category, current) {
  const v = await ask({ title: `Budget · ${EXPENSE_LABEL[category]}`, text: 'Combien voulez-vous dépenser au plus chaque mois dans cette catégorie ? Laissez vide pour retirer le budget.', submit: 'Enregistrer', fields: [
    { name: 'amount', label: 'Budget mensuel (GNF)', type: 'number', inputmode: 'numeric', value: current ?? '', required: false }] });
  if (!v) return false;
  await post('/pf/budgets', { category, amount: v.amount === '' ? null : Number(v.amount) });
  return true;
}

function planScreen({ go }) {
  return liveView(() => get('/pf/plan'), (d, refresh) => {
    const pro = d.tier === 'pro';
    const pick = async () => {
      const used = new Set(d.budgets.map((b) => b.category));
      const left = Object.entries(EXPENSE_LABEL).filter(([k]) => !used.has(k));
      if (!left.length) return false;
      const v = await ask({ title: 'Nouveau budget', submit: 'Suivant', fields: [{ name: 'category', label: 'Catégorie', type: 'select', options: left, value: left[0][0] }] });
      return v ? askBudget(v.category) : false;
    };
    const goal = d.goal;
    const bar = (value, max, over) => { const f = h('span', { class: `pf-bar-fill ${over ? 'neg' : 'pos'}` }); f.style.width = `${max > 0 ? Math.min(100, Math.max(2, Math.round((value * 100) / max))) : 0}%`; return h('span', { class: 'pf-bar-track' }, f); };
    const goalSet = action(async () => {
      const v = await ask({ title: 'Objectif du mois', text: 'Combien voulez-vous mettre de côté ce mois-ci (revenus moins dépenses) ? Laissez vide pour le retirer.', submit: 'Enregistrer', fields: [
        { name: 'target', label: 'Objectif (GNF)', type: 'number', inputmode: 'numeric', value: goal?.target ?? '', required: false }] });
      if (!v) return;
      await post('/pf/goal', { target: v.target === '' ? null : Number(v.target) });
    }, { ok: 'Objectif enregistré', refresh });
    const f = d.forecast;
    return h('div', {}, head('Plan financier'), h('div', { class: 'pf-pad' },
      !pro && lock(go),
      card('Prévision à 30 jours',
        h('div', { class: 'pf-sub' }, 'SOLDE PRÉVU'), h('div', { class: 'pf-big' }, fmtGNF(f.projected)),
        h('dl', { class: 'pf-kv' }, h('dt', {}, 'Solde actuel'), h('dd', {}, fmtGNF(f.balance)), h('dt', {}, 'Revenus attendus'), h('dd', { class: 'pos' }, fmtGNF(f.income)), h('dt', {}, 'Dépenses prévues'), h('dd', { class: 'neg' }, fmtGNF(f.expense))),
        f.upcoming.length === 0 ? h('p', { class: 'pf-note' }, 'Ajoutez vos revenus et dépenses qui reviennent pour voir ce qui vous attend.')
          : f.upcoming.slice(0, 5).map((u) => h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, `${dayLabel(u.day)} · ${u.label}`), h('span', { class: u.kind === 'income' ? 'pos' : 'neg' }, money(u.kind === 'income' ? u.amount : -u.amount, true))))),
        moreLink('Gérer mes récurrents', () => go('recurring'))),
      card('Objectif du mois',
        goal ? [h('div', { class: 'pf-flow-row' }, h('b', {}, 'Mis de côté'), h('span', {}, `${fmtGNF(Math.max(0, goal.saved))} / ${fmtGNF(goal.target)}`)), bar(Math.max(0, goal.saved), goal.target, false)]
          : h('p', { class: 'pf-note' }, 'Fixez ce que vous voulez mettre de côté ce mois-ci.'),
        h('button', { class: 'pf-btn', type: 'button', onclick: () => (needPro(d, go) ? null : goalSet()) }, goal ? 'Modifier' : 'Fixer un objectif')),
      card('Budgets du mois',
        d.budgets.length === 0 ? h('p', { class: 'pf-note' }, 'Aucun budget. Limitez vos dépenses par catégorie : alimentation, transport, téléphone…')
          : d.budgets.map((b) => h('button', { class: 'pf-flow pf-plain', type: 'button', onclick: () => (needPro(d, go) ? null : action(async () => { await askBudget(b.category, b.amount); }, { ok: 'Budget enregistré', refresh })()) },
            h('div', { class: 'pf-flow-row' }, h('b', {}, EXPENSE_LABEL[b.category]), h('span', { class: b.spent > b.amount ? 'neg' : '' }, `${fmtGNF(b.spent)} / ${fmtGNF(b.amount)}`)), bar(b.spent, b.amount, b.spent > b.amount))),
        h('button', { class: 'pf-btn', type: 'button', onclick: () => (needPro(d, go) ? null : action(async () => { await pick(); }, { ok: 'Budget enregistré', refresh })()) }, 'Ajouter un budget')),
      h('button', { class: 'pf-link', type: 'button', onclick: () => go('') }, '‹ Tableau de bord')));
  });
}
function recurringScreen({ go }) {
  return liveView(() => get('/pf/plan'), (d, refresh) => {
    const open = (r) => async () => {
      const v = await ask({ title: r.label, text: `${r.kind === 'income' ? 'Revenu' : 'Dépense'} · ${fmtGNF(r.amount)} · ${FREQ_LABEL[r.frequency]}`, submit: 'Modifier', fields: [] });
      if (!v) return;
      if (d.tier !== 'pro') { go('pro'); return; }
      try { if (await askRecurring(r)) { toast('Récurrent modifié', 'ok'); refresh(); } } catch (e) { errToast(e); }
    };
    const stop = (r) => action(async () => { if (await confirmBox('Arrêter ce récurrent ?', 'Il ne comptera plus dans la prévision. Vos transactions déjà notées ne changent pas.', 'Arrêter', true)) { await post(`/pf/recurring/${r.id}/stop`); return true; } }, { ok: (x) => (x ? 'Récurrent arrêté' : ''), refresh });
    const add = action(async () => { if (needPro(d, go)) return; await askRecurring(); }, { ok: 'Récurrent ajouté', refresh });
    return h('div', {}, head('Récurrents', { back: ['Plan', () => go('plan')] }), h('div', { class: 'pf-pad' },
      d.tier !== 'pro' && lock(go),
      d.recurring.length === 0 ? empty('clock', 'Aucun revenu ni dépense récurrente.') : h('section', { class: 'pf-card flush' }, d.recurring.map((r) => h('div', { class: 'pf-acc' },
        h('button', { class: 'pf-row', type: 'button', onclick: open(r) }, h('span', { class: `pf-ico pf-c-${r.kind === 'income' ? 'green' : 'orange'}` }, icon(r.kind === 'income' ? 'plus' : 'arrowUpRight', 22)),
          h('span', { class: 'pf-row-main' }, h('b', {}, r.label), h('span', { class: `pf-amt ${r.kind === 'income' ? 'pos' : 'neg'}` }, money(r.kind === 'income' ? r.amount : -r.amount, true)), h('small', {}, `${FREQ_LABEL[r.frequency]} · depuis le ${dayLabel(r.anchor_on)}`))),
        h('button', { class: 'pf-mini', type: 'button', onclick: stop(r) }, 'Arrêter')))),
      h('button', { class: 'pf-btn', type: 'button', onclick: add }, 'Ajouter un récurrent'),
      h('p', { class: 'pf-note' }, 'Ces repères servent à la prévision et à votre budget. Rien n\'est débité ni noté tout seul : vous enregistrez la vraie transaction quand elle a lieu.')));
  });
}
// ---------- Contacts : carnet unique (clients, prospects), notes, étiquettes, import de fichier, appel / SMS / WhatsApp ----------
const STAGE_LABEL = { prospect: 'Prospect', client: 'Client', other: 'Autre' };
const LABEL_COLOR = { green: 'Vert', red: 'Rouge', gold: 'Or', blue: 'Bleu', grey: 'Gris' };
const waNumber = (p) => (p.length === 9 ? `224${p}` : p);
const firstName = (n) => String(n).trim().split(/\s+/)[0];
const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const labelChip = (l) => h('span', { class: `pf-lab pf-lab-${l.color}` }, l.name);

/** Lit un fichier de contacts (CSV, texte ou vCard) : renvoie [{name, phone, city}]. Rien n'est envoyé tant que la personne n'a pas confirmé. */
export function parseContacts(text) {
  const clean = String(text).replace(/^﻿/, '');
  const rows = [];
  if (/BEGIN:VCARD/i.test(clean)) {
    for (const card of clean.split(/BEGIN:VCARD/i).slice(1)) {
      const fn = /^FN[^:]*:(.+)$/im.exec(card)?.[1]?.trim(), tel = /^TEL[^:]*:(.+)$/im.exec(card)?.[1]?.trim();
      if (fn && tel) rows.push({ name: fn, phone: tel, city: '' });
    }
    return rows;
  }
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return rows;
  const delim = [';', '\t', ','].find((d) => lines[0].includes(d)) || ',';
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0]).map((c) => c.toLowerCase());
  const looksPhone = (c) => /^[+0-9][0-9 .\-()]{5,}$/.test(c);
  const hasHeader = !head.some(looksPhone);
  const find = (re) => head.findIndex((c) => re.test(c));
  let iName = hasHeader ? find(/nom|name|contact/) : 0, iPhone = hasHeader ? find(/t[ée]l|phone|num|mobile|portable/) : 1, iCity = hasHeader ? find(/ville|city|commune|quartier/) : 2;
  for (const l of lines.slice(hasHeader ? 1 : 0)) {
    const c = split(l);
    let phone = iPhone >= 0 ? c[iPhone] : '', name = iName >= 0 ? c[iName] : '';
    if (!looksPhone(phone || '')) { const k = c.findIndex(looksPhone); phone = k >= 0 ? c[k] : ''; if (!name || name === phone) name = c.find((x, n) => n !== k && x && !looksPhone(x)) || ''; }
    if (name && phone) rows.push({ name, phone, city: iCity >= 0 ? c[iCity] || '' : '' });
  }
  return rows;
}

async function askContact(existing, defaults = {}) {
  const v = await ask({ title: existing ? 'Modifier le contact' : 'Nouveau contact', submit: 'Enregistrer', fields: [
    { name: 'name', label: 'Nom', value: existing?.name || '', maxlength: 60 },
    { name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'tel', value: existing?.phone || '' },
    { name: 'city', label: 'Ville ou quartier (facultatif)', required: false, maxlength: 40, value: existing?.city || '' },
    { name: 'stage', label: 'Statut', type: 'select', options: Object.entries(STAGE_LABEL), value: existing?.stage || defaults.stage || 'prospect' }] });
  if (!v) return false;
  await post('/pf/contacts', { id: existing?.id, name: v.name, phone: v.phone, city: v.city || undefined, stage: v.stage });
  return true;
}

function pickLabels(labels, current, canCreate) {
  return new Promise((resolve) => {
    const chosen = new Set(current.map((l) => l.id));
    const close = (val) => { overlay.remove(); resolve(val); };
    const list = h('div', { class: 'more-list' });
    const draw = () => list.replaceChildren(...labels.map((l) => h('button', { class: 'more-row', type: 'button', 'aria-pressed': String(chosen.has(l.id)), onclick: () => { chosen.has(l.id) ? chosen.delete(l.id) : chosen.add(l.id); draw(); } },
      labelChip(l), h('span', { class: 'grow' }), chosen.has(l.id) ? icon('check', 20) : null)));
    draw();
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, h('div', { class: 'modal sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Étiquettes' },
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), labels.length ? list : h('p', { class: 'pf-note' }, 'Aucune étiquette pour le moment.'),
      canCreate && h('button', { class: 'btn btn-ghost btn-block mt', type: 'button', onclick: () => close('new') }, 'Nouvelle étiquette'),
      h('button', { class: 'btn btn-primary btn-block mt', type: 'button', onclick: () => close([...chosen]) }, 'Valider')));
    document.body.append(overlay);
  });
}
async function askLabel() {
  const v = await ask({ title: 'Nouvelle étiquette', submit: 'Créer', fields: [{ name: 'name', label: 'Nom (ex. Fidèle, À relancer)', maxlength: 30 }, { name: 'color', label: 'Couleur', type: 'select', options: Object.entries(LABEL_COLOR), value: 'blue' }] });
  if (!v) return false;
  await post('/pf/labels', { name: v.name, color: v.color });
  return true;
}

function contactsScreen({ go, st }) {
  let stage = '', text = '', label = '', openId = null;
  const host = h('div', {});
  const importFile = h('input', { type: 'file', accept: '.csv,.txt,.vcf,text/csv,text/plain,text/vcard', hidden: true });
  const load = async () => { try { await (openId ? showDetail() : showList()); } catch (e) { errToast(e); } };

  async function showList() {
    const params = new URLSearchParams({ ...(stage ? { stage } : {}), ...(text ? { q: text } : {}), ...(label ? { label } : {}) });
    const d = await get(`/pf/contacts?${params}`);
    const pro = d.tier === 'pro';
    const fromOrders = action(async () => { const r = await post('/pf/contacts-from-orders'); return r.added; }, { ok: (n) => (n > 0 ? `${n} client(s) ajouté(s)` : 'Aucun nouveau client'), refresh: load });
    const add = action(async () => { await askContact(null); }, { ok: 'Contact ajouté', refresh: load });
    importFile.onchange = async () => {
      const f = importFile.files[0]; importFile.value = '';
      if (!f) return;
      if (!pro) { go('pro'); return; }
      try {
        const rows = parseContacts(await f.text());
        if (!rows.length) { toast('Aucun contact lisible dans ce fichier (il faut au moins un nom et un numéro par ligne).', 'bad'); return; }
        if (rows.length > 500) { toast('500 contacts au plus par import : découpez le fichier.', 'bad'); return; }
        if (!(await confirmBox(`Importer ${rows.length} contact(s) ?`, 'Les numéros déjà dans votre carnet et les lignes invalides seront ignorés.', 'Importer'))) return;
        const r = await post('/pf/contacts-import', { rows });
        toast(`${r.added} ajouté(s), ${r.skipped} ignoré(s)`, 'ok'); load();
      } catch (e) { errToast(e); }
    };
    host.replaceChildren(h('div', {}, head('Contacts'), h('div', { class: 'pf-pad' },
      d.priced && !pro && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, `Formule gratuite : ${d.total} / ${d.free_contacts} contacts. Contacts illimités, étiquettes et import avec Pro.`), icon('chevronRight', 18)),
      h('input', { class: 'pf-search', type: 'search', placeholder: 'Rechercher un nom, un numéro…', value: text, 'aria-label': 'Rechercher', onchange: (e) => { text = e.target.value.trim(); load(); } }),
      h('div', { class: 'pf-chips' }, [['', 'Tous'], ['prospect', 'Prospects'], ['client', 'Clients'], ['other', 'Autres']].map(([k, l]) => h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(stage === k), onclick: () => { stage = k; load(); } }, l))),
      d.labels.length > 0 && h('div', { class: 'pf-chips' }, d.labels.map((l) => h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(label === l.id), onclick: () => { label = label === l.id ? '' : l.id; load(); } }, l.name))),
      d.contacts.length === 0 ? card(null, h('div', { class: 'pf-start' }, h('span', { class: 'pf-ico pf-c-blue' }, icon('users', 26)), h('div', {}, h('b', {}, text || stage || label ? 'Aucun contact trouvé' : 'Votre carnet est vide'),
        h('p', {}, 'Ajoutez vos clients et prospects : un seul endroit pour les appeler, leur écrire sur WhatsApp et garder vos notes.')))) :
        h('section', { class: 'pf-card flush' }, d.contacts.map((c) => h('button', { class: 'pf-row', type: 'button', onclick: () => { openId = c.id; load(); } },
          h('span', { class: `pf-ico pf-c-${c.stage === 'client' ? 'green' : c.stage === 'prospect' ? 'orange' : 'grey'}` }, icon('users', 22)),
          h('span', { class: 'pf-row-main' }, h('b', {}, c.name), h('small', {}, `${fmtPhone ? fmtPhone(c.phone) : c.phone}${c.city ? ` · ${c.city}` : ''}`), c.labels.length > 0 && h('span', { class: 'pf-labs' }, c.labels.map(labelChip))), icon('chevronRight', 18)))),
      h('div', { class: 'pf-btns' }, h('button', { class: 'pf-btn', type: 'button', onclick: add }, 'Nouveau contact'),
        d.seller && h('button', { class: 'pf-btn alt', type: 'button', onclick: fromOrders }, 'Ajouter mes clients'),
        h('button', { class: 'pf-btn alt', type: 'button', onclick: () => (pro ? importFile.click() : go('pro')) }, pro ? 'Importer un fichier' : 'Importer un fichier 🔒')),
      h('p', { class: 'pf-note' }, 'Fichier CSV ou vCard (.vcf) exporté depuis votre téléphone ou un tableur : une ligne par contact avec le nom et le numéro. WhatsApp s\'ouvre avec un message prêt à envoyer ; Wallindirain ne lit jamais vos conversations.'),
      d.seller && h('a', { class: 'pf-link', href: '#/app/relances' }, 'Relances de mes clients ›'))), importFile);
  }

  async function showDetail() {
    const [d, all] = await Promise.all([get(`/pf/contacts/${openId}`), get('/pf/contacts')]);
    const c = d.contact, pro = all.tier === 'pro';
    const back = () => { openId = null; load(); };
    const msg = encodeURIComponent(`Bonjour ${firstName(c.name)}, `);
    const act = (ico, label, href) => h('a', { class: 'pf-act', href, rel: 'noopener', target: href.startsWith('http') ? '_blank' : null }, icon(ico, 24), h('span', {}, label));
    const edit = action(async () => { await askContact(c); }, { ok: 'Contact modifié', refresh: load });
    const archive = action(async () => { if (await confirmBox(c.archived_at ? 'Rétablir ce contact ?' : 'Archiver ce contact ?', c.archived_at ? '' : 'Il disparaît de la liste ; ses notes sont conservées.', c.archived_at ? 'Rétablir' : 'Archiver')) { await post(`/pf/contacts/${c.id}/archive`, { archived: !c.archived_at }); return true; } },
      { ok: (r) => (r ? (c.archived_at ? 'Contact rétabli' : 'Contact archivé') : ''), refresh: () => back() });
    const note = action(async () => {
      const v = await ask({ title: 'Nouvelle note', submit: 'Ajouter', fields: [{ name: 'body', label: 'Note', maxlength: 500 }] });
      if (v) await post(`/pf/contacts/${c.id}/notes`, { body: v.body });
    }, { ok: 'Note ajoutée', refresh: load });
    const voidNote = (n) => action(async () => { if (await confirmBox('Retirer cette note ?', '', 'Retirer', true)) { await post(`/pf/contact-notes/${n.id}/void`); return true; } }, { ok: (r) => (r ? 'Note retirée' : ''), refresh: load });
    const labels = action(async () => {
      if (!pro) { go('pro'); return; }
      let all2 = all.labels, cur = d.labels;
      for (;;) {
        const r = await pickLabels(all2, cur, true);
        if (r === null) return;
        if (r === 'new') { if (await askLabel()) { all2 = (await get('/pf/contacts')).labels; } continue; }
        await post(`/pf/contacts/${c.id}/labels`, { labels: r }); return;
      }
    }, { ok: 'Étiquettes enregistrées', refresh: load });
    host.replaceChildren(h('div', {}, head(c.name, { back: ['Contacts', back] }), h('div', { class: 'pf-pad' },
      card(null, h('div', { class: 'pf-contact-top' }, h('b', {}, fmtPhone ? fmtPhone(c.phone) : c.phone), h('small', {}, `${STAGE_LABEL[c.stage]}${c.city ? ` · ${c.city}` : ''} · ajouté le ${fmtDate(c.created_at)}`)),
        h('div', { class: 'pf-acts' }, act('phone', 'Appeler', `tel:${c.phone}`), act('message', 'SMS', `sms:${c.phone}?body=${msg}`), act('arrowUpRight', 'WhatsApp', `https://wa.me/${waNumber(c.phone)}?text=${msg}`)),
        h('div', { class: 'pf-labs' }, d.labels.map(labelChip), h('button', { class: 'pf-mini inline', type: 'button', onclick: labels }, pro ? 'Étiquettes' : 'Étiquettes 🔒'))),
      d.orders && card('Commandes passées', d.orders.length === 0 ? h('p', { class: 'pf-note' }, 'Aucune commande avec ce numéro.') : d.orders.slice(0, 8).map((o) => h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, `${o.product_name} × ${o.qty}`), h('span', {}, fmtGNF(o.sale_total))), h('small', { class: 'pf-sub' }, `${fmtDate(o.created_at)} · ${ORDER_STATUS[o.status] || o.status}`)))),
      card('Notes', d.notes.length === 0 ? h('p', { class: 'pf-note' }, 'Aucune note.') : d.notes.map((n) => h('div', { class: 'pf-note-row' }, h('p', {}, n.body), h('small', {}, fmtDate(n.created_at)), h('button', { class: 'pf-mini inline', type: 'button', onclick: voidNote(n) }, 'Retirer'))),
        h('button', { class: 'pf-btn', type: 'button', onclick: note }, 'Ajouter une note')),
      h('div', { class: 'pf-btns' }, h('button', { class: 'pf-btn alt', type: 'button', onclick: edit }, 'Modifier'), h('button', { class: 'pf-btn alt', type: 'button', onclick: archive }, c.archived_at ? 'Rétablir' : 'Archiver')))));
  }

  load();
  return host;
}
const ORDER_STATUS = { new: 'Nouvelle', in_call: 'En appel', confirmed: 'Confirmée', assigned: 'Assignée', picked_up: 'Récupérée', on_the_way: 'En route', delivered: 'Livrée', cancelled: 'Annulée', failed: 'Échec', return_pending: 'Retour en cours', returned: 'Retournée', refused: 'Refusée' };

// ---------- Plus, Paramètres, Pro ----------
function moreScreen({ go, st, user }) {
  const tile = (ico, label, sub, onclick, href) => h(href ? 'a' : 'button', { class: 'pf-tile', type: href ? null : 'button', href, onclick }, h('span', { class: 'pf-tile-ico' }, icon(ico, 30)), h('span', {}, label), sub && h('small', {}, sub));
  return h('div', {}, head('Plus'), h('div', { class: 'pf-pad' }, h('div', { class: 'pf-tiles' },
    tile('bank', 'Comptes', null, () => go('accounts')), tile('receipt', 'Transactions', null, () => go('tx')),
    tile('star', 'Formule', st.tier === 'pro' ? 'Pro' : 'Gratuite', () => go('pro')), tile('settings', 'Paramètres', null, () => go('settings')),
    st.wallet?.eligible && tile('wallet', 'Portefeuille', 'Wallindirain', null, '#/app/wallet'), tile('user', 'Mon profil', null, null, '#/app/profile')),
    user.role !== 'member' && backLink()));
}
// ---------- Compte Wallindirain relié ----------
const AUTO_LINES = [['Gains de vente et rémunérations', 'revenus'], ['Achats de stock, frais et abonnements', 'dépenses'], ['Dépôts et retraits', 'virements avec votre compte Mobile Money']];
function walletScreen({ go, st, reload }) {
  return liveView(() => get('/pf/accounts'), (o, refresh) => {
    const linked = st.wallet?.linked, pro = st.tier === 'pro';
    const real = o.accounts.filter((a) => !a.auto && !a.archived_at);
    const done = async () => { await reload(); };
    const link = action(async () => {
      if (!pro) { go('pro'); return; }
      const v = await ask({ title: linked ? 'Compte qui reçoit mes retraits' : 'Relier mon compte Wallindirain', text: 'Choisissez le compte où arrive l\'argent de vos retraits (et d\'où partent vos dépôts). Les virements ne comptent ni comme revenu ni comme dépense.', submit: linked ? 'Enregistrer' : 'Relier', fields: [
        { name: 'account', label: 'Compte', type: 'select', options: [['', 'Créer un compte « Mobile Money » (recommandé)'], ...real.map((a) => [a.id, a.name])], value: st.wallet?.account || '' }] });
      if (!v) return;
      await post('/pf/wallet-link', { account_id: v.account || undefined });
    }, { ok: linked ? 'Compte enregistré' : 'Compte Wallindirain relié', refresh: done });
    const unlink = action(async () => {
      if (!(await confirmBox('Délier mon compte Wallindirain ?', 'Les lignes automatiques disparaissent de Mes finances (y compris les retraits reçus sur le compte choisi). Vos comptes et transactions saisis à la main restent. Votre portefeuille Wallindirain n\'est pas touché.', 'Délier', true))) return false;
      await post('/pf/wallet-unlink'); return true;
    }, { ok: (r) => (r ? 'Compte délié' : ''), refresh: done });
    return h('div', {}, head('Compte Wallindirain', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' },
      !pro && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'La liaison automatique fait partie de la formule Pro.'), icon('chevronRight', 18)),
      card(null, h('div', { class: 'pf-start' }, h('span', { class: 'pf-ico pf-c-teal' }, icon('wallet', 26)), h('div', {}, h('b', {}, linked ? 'Relié : tout arrive tout seul' : 'Zéro saisie pour votre activité Wallindirain'),
        h('p', {}, 'Tout ce qui passe par votre portefeuille Wallindirain est classé automatiquement dans un compte « Wallindirain », en lecture seule.'))),
        AUTO_LINES.map(([a, b]) => h('div', { class: 'pf-flow' }, h('b', {}, a), h('small', { class: 'pf-sub' }, b)))),
      linked
        ? h('div', { class: 'pf-btns' }, h('button', { class: 'pf-btn', type: 'button', onclick: link }, 'Changer le compte des retraits'), h('button', { class: 'pf-btn alt', type: 'button', onclick: unlink }, 'Délier'))
        : h('button', { class: 'pf-btn', type: 'button', onclick: link }, pro ? 'Relier mon compte Wallindirain' : 'Relier avec Pro'),
      h('p', { class: 'pf-note' }, 'Lecture seule : Mes finances lit votre portefeuille, elle ne le modifie jamais et ne bouge aucun argent. Seul vous voyez ces lignes.')));
  });
}

function settingsScreen({ go, st }) {
  const row = (ico, label, onclick, href) => h(href ? 'a' : 'button', { class: 'pf-set', type: href ? null : 'button', href, onclick }, icon(ico, 22), h('span', { class: 'grow' }, label), icon('chevronRight', 18));
  return h('div', {}, head('Paramètres', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' }, h('section', { class: 'pf-card flush' },
    row('dashboard', 'Tableau de bord', () => go('')), row('chart', 'Paramètres des jauges', () => go('gauges')), row('bank', 'Comptes', () => go('accounts')),
    st.wallet?.eligible && row('wallet', 'Compte Wallindirain', () => go('wallet')),
    row('users', 'Contacts et étiquettes', () => go('contacts')), row('clock', 'Budgets et objectif du mois', () => go('plan')), row('receipt', 'Revenus et dépenses récurrents', () => go('recurring')), row('star', 'Formule et abonnement', () => go('pro')),
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
    card('Gratuit', h('ul', { class: 'pf-list' }, h('li', {}, `${st.free_accounts} comptes personnels`), h('li', {}, 'Carnet de contacts (nombre limité), notes, appel, SMS, WhatsApp'), h('li', {}, 'Revenus, dépenses et virements'), h('li', {}, `Historique des ${st.free_history_days} derniers jours`), h('li', {}, 'Tableau de bord sur 30 jours'))),
    card('Pro', h('ul', { class: 'pf-list' }, h('li', {}, 'Comptes et contacts illimités'), h('li', {}, 'Étiquettes et import de fichier de contacts'), h('li', {}, 'Historique complet'), h('li', {}, 'Statistiques sur 90 jours et 1 an'), h('li', {}, 'Budgets, objectif du mois, récurrents et prévision à 30 jours'), h('li', {}, 'Règles automatiques et export (bientôt)')),
      st.priced ? h('div', { class: 'pf-btns' }, st.prices.monthly > 0 && h('button', { class: 'pf-btn', type: 'button', onclick: sub('monthly') }, `${fmtGNF(st.prices.monthly)} / mois`), st.prices.yearly > 0 && h('button', { class: 'pf-btn alt', type: 'button', onclick: sub('yearly') }, `${fmtGNF(st.prices.yearly)} / an`))
        : h('p', { class: 'pf-note' }, 'Aucun prix n\'est fixé pour le moment.')),
    h('p', { class: 'pf-note' }, 'Le paiement est prélevé sur votre portefeuille Wallindirain. Un abonnement terminé ne supprime rien : vos données restent, avec les limites de la formule gratuite.')));
}

export { fmtPhone, badge };
