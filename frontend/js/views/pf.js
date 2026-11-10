// « Mes finances » : outil de gestion financière personnelle pour tous les rôles (migration 048).
// Écran plein écran, sombre, avec sa propre barre du bas : Tableau de bord · Plan financier · Contacts · Statistiques · Plus.
// Ce sont des notes personnelles : le compte « Wallindirain » affiché est le vrai portefeuille, en lecture seule.
import { h, fmtGNF as baseFmt, eyeToggle, liveView, badge, ask, confirmBox, action, toast, errToast, empty, fmtPhone, showLegal } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { gaugeSvg, areaChart } from './pf-charts.js';
import { spacesScreen, spaceScreen } from './pf-spaces.js';
import { loadCats, catLabel, catOptions, profile as pfProfile, profileChooser, categoriesScreen } from './pf-cats.js';

export const INCOME_LABEL = { sales: 'Ventes', salary: 'Salaire', gift: 'Cadeau', other_in: 'Autre revenu' };
export const EXPENSE_LABEL = { food: 'Alimentation', transport: 'Transport', housing: 'Logement', telecom: 'Téléphone et internet', health: 'Santé', family: 'Famille', business: 'Activité', shopping: 'Achats', savings: 'Épargne', other_out: 'Autre dépense' };
const CAT_LABEL = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? catLabel(k) : undefined) });   // noms lus dans l'arbre des catégories (modifiable)
const KIND_LABEL = { wallindirain: 'Relié à Wallindirain', cash: 'Espèces', mobile_money: 'Mobile money', bank: 'Banque', savings: 'Épargne', other: 'Autre' };
const KIND_ICON = { wallindirain: 'wallet', cash: 'banknote', mobile_money: 'phoneMoney', bank: 'bank', savings: 'wallet', other: 'wallet' };
const COLOR_LABEL = { blue: 'Bleu', green: 'Vert', orange: 'Orange', red: 'Rouge', purple: 'Violet', brown: 'Marron', teal: 'Turquoise', grey: 'Gris' };
let decimals = false;   // réglage « décimales » : montants affichés avec deux décimales
const fmtGNF = (n) => (decimals ? `${(Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ')} GNF` : baseFmt(n));
const PERIODS = [['today', 'Aujourd\'hui'], ['week', 'Cette semaine'], ['month', 'Ce mois-ci'], ['year', 'Cette année'], ['d7', '7 jours'], ['d30', '30 jours'], ['w12', '12 semaines'], ['m6', '6 mois'], ['y1', '1 an']];
const PERIOD_DAYS = (p) => { const n = new Date(); return ({ today: 1, week: ((n.getUTCDay() + 6) % 7) + 1, month: n.getUTCDate(), year: Math.floor((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - Date.UTC(n.getUTCFullYear(), 0, 1)) / 86400000) + 1, d7: 7, d30: 30, w12: 84, m6: 182, y1: 365 })[p] || 30; };
const PERIOD_LABEL = Object.fromEntries(PERIODS);
const today = () => new Date().toISOString().slice(0, 10);
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtShort = (n) => { const a = Math.abs(n); const s = n < 0 ? '-' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(2).replace('.', ',')}M` : a >= 1e3 ? `${s}${Math.round(a / 1e3)}k` : `${s}${a}`; };
// Devises (migration 056) : les montants d'un compte sont dans sa devise, en plus petite unité (1 USD = 100). Les totaux sont en GNF.
let CURRENCIES = {};   // code → { name, decimals, rate }
const curDec = (code) => (!code || code === 'GNF' ? 0 : (CURRENCIES[code]?.decimals ?? 2));
const toMinor = (v, code) => Math.round(Number(String(v).replace(',', '.')) * 10 ** curDec(code));
const fromMinor = (n, code) => Number(n) / 10 ** curDec(code);
const fmtCur = (minor, code) => (!code || code === 'GNF' ? fmtGNF(minor) : `${fromMinor(minor, code).toLocaleString('fr-FR', { minimumFractionDigits: curDec(code), maximumFractionDigits: curDec(code) }).replace(/[\u202f\u00a0]/g, ' ')} ${code}`);
const curMoney = (n, code, signed = false) => `${signed && n > 0 ? '+' : ''}${fmtCur(n, code)}`;
const money = (n, signed = false) => `${signed && n > 0 ? '+' : ''}${fmtGNF(n)}`;

const TABS = [['home', 'dashboard', 'Tableau de bord'], ['plan', 'clock', 'Plan financier'], ['contacts', 'users', 'Contacts'], ['stats', 'chart', 'Statistiques'], ['more', 'more', 'Plus']];

/** Point d'entrée : `#/pf/<écran>`. */
export function pfApp(user, screen = '') {
  memberOnly = user.role === 'member';
  const go = (s) => { location.hash = `#/pf/${s}`; };
  const SCREENS = { '': homeScreen, home: homeScreen, plan: planScreen, recurring: recurringScreen, wallet: walletScreen, contacts: contactsScreen, stats: statsScreen, more: moreScreen, accounts: accountsScreen, tx: txScreen, pro: proScreen, settings: settingsScreen, gauges: gaugesScreen, general: generalScreen, currencies: currenciesScreen, categories: (a) => categoriesScreen({ ...a, head, card }), privacy: (a) => privacyScreen({ ...a, head, card }), spaces: (a) => spacesScreen({ ...a, head, card }) };
  const spaceId = /^space-[0-9a-f-]{36}$/.test(screen) ? screen.slice(6) : null;
  if (spaceId) SCREENS[screen] = (a) => spaceScreen({ ...a, head, card, id: spaceId });
  const accId = /^account-[0-9a-f-]{36}$/.test(screen) ? screen.slice(8) : null;
  if (accId) SCREENS[screen] = (a) => accountScreen({ ...a, id: accId });
  const key = SCREENS[screen] ? screen : '';
  const tabOf = ({ '': 'home', home: 'home', plan: 'plan', recurring: 'plan', wallet: 'more', contacts: 'contacts', stats: 'stats' })[key] || 'more';
  document.title = 'Mes finances · Wallindirain';
  const body = h('div', { class: 'pf-body' }, liveView(async () => { const [st, set, cu] = await Promise.all([get('/pf/status'), get('/pf/settings').catch(() => null), get('/pf/currencies').catch(() => null), loadCats().catch(() => null)]); decimals = !!set?.decimals; CURRENCIES = Object.fromEntries((cu?.currencies || []).map((c) => [c.code, c])); return st; }, (st, refresh) => {
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
const accountOptions = (accounts, writableOnly = true) => accounts.filter((a) => !a.archived_at && (!writableOnly || a.writable)).map((a) => [a.id, a.currency && a.currency !== 'GNF' ? `${a.name} · ${a.currency}` : a.name]);
const accCur = (accounts, id) => accounts.find((a) => a.id === id)?.currency || 'GNF';

async function askTx(kind, accounts, existing, preset) {
  const list = accountOptions(accounts);
  if (!list.length) { toast(accounts.some((a) => !a.archived_at) ? 'Aucun compte utilisable dans la formule gratuite : passez à Pro.' : 'Créez d\'abord un compte.', 'bad'); return false; }
  await loadCats().catch(() => null);
  const options = catOptions(kind, existing?.category);
  const v = await ask({ title: existing ? 'Modifier la transaction' : kind === 'income' ? 'Nouveau revenu' : 'Nouvelle dépense', submit: 'Enregistrer', fields: [
    { name: 'account_id', label: 'Compte', type: 'select', options: list, value: existing?.account_id || (list.some((o) => o[0] === preset) ? preset : list[0][0]) },
    { name: 'amount', label: 'Montant (dans la devise du compte)', type: 'number', step: 'any', inputmode: 'decimal', value: existing ? fromMinor(existing.amount, existing.currency) : '' },
    { name: 'category', label: 'Catégorie', type: 'select', options, value: existing?.category || options[0]?.[0] },
    { name: 'occurred_on', label: 'Date', type: 'date', value: existing?.occurred_on || today() },
    { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200, value: existing?.note || '' }] });
  if (!v) return false;
  const body = { account_id: v.account_id, amount: toMinor(v.amount, accCur(accounts, v.account_id)), category: v.category, occurred_on: v.occurred_on, note: v.note || undefined };
  if (existing) await post(`/pf/transactions/${existing.id}/update`, body); else await post('/pf/transactions', { ...body, kind });
  return true;
}
async function askTransfer(accounts, preset) {
  const list = accountOptions(accounts);
  if (list.length < 2) { toast('Il faut au moins deux comptes pour faire un virement.', 'bad'); return false; }
  const v = await ask({ title: 'Virement entre mes comptes', text: 'L\'argent passe d\'un de vos comptes à un autre. Cela ne change ni vos revenus ni vos dépenses.', submit: 'Virer', fields: [
    { name: 'from', label: 'Du compte', type: 'select', options: list, value: list.some((o) => o[0] === preset) ? preset : list[0][0] }, { name: 'to', label: 'Vers le compte', type: 'select', options: list, value: (list.find((o) => o[0] !== preset) || list[1])[0] },
    { name: 'amount', label: 'Montant (dans la devise des comptes)', type: 'number', step: 'any', inputmode: 'decimal' }, { name: 'occurred_on', label: 'Date', type: 'date', value: today() },
    { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200 }] });
  if (!v) return false;
  await post('/pf/transfers', { from: v.from, to: v.to, amount: toMinor(v.amount, accCur(accounts, v.from)), occurred_on: v.occurred_on, note: v.note || undefined });
  return true;
}
async function askAccount(existing) {
  const cur = existing?.currency || 'GNF';
  const curOptions = [['GNF', 'GNF · Franc guinéen'], ...Object.entries(CURRENCIES).map(([code, c]) => [code, `${code} · ${c.name}`])];
  const v = await ask({ title: existing ? 'Modifier le compte' : 'Nouveau compte', text: existing ? '' : 'Un compte est une de vos « poches » : espèces, Orange Money, banque, épargne…', submit: 'Enregistrer', fields: [
    { name: 'name', label: 'Nom (ex. Orange Money, Espèces)', value: existing?.name || '', maxlength: 40 },
    { name: 'kind', label: 'Type', type: 'select', options: Object.entries(KIND_LABEL), value: existing?.kind || 'mobile_money' },
    { name: 'color', label: 'Couleur', type: 'select', options: Object.entries(COLOR_LABEL), value: existing?.color || 'blue' },
    ...(existing ? [] : [{ name: 'currency', label: 'Devise', type: 'select', options: curOptions, value: 'GNF', hint: 'Une autre devise s\'ajoute dans Paramètres → Devises. Elle ne change plus après la création.' }]),
    { name: 'opening_balance', label: `Solde actuel (${cur === 'GNF' && !existing ? 'dans la devise choisie' : cur})`, type: 'number', step: 'any', inputmode: 'decimal', value: existing ? fromMinor(existing.balance, cur) : 0, required: false, hint: existing ? 'Le solde que ce compte doit afficher maintenant. Vos revenus et dépenses déjà notés sont conservés : seul le point de départ est ajusté.' : 'Ce que contient ce compte aujourd\'hui. Vos revenus et dépenses notés ensuite le feront varier.' }] });
  if (!v) return false;
  const code = existing ? cur : v.currency;
  // l'écran parle de « solde actuel » : le point de départ enregistré = solde voulu − mouvements déjà notés
  const moves = existing ? Number(existing.balance) - Number(existing.opening_balance) : 0;
  await post('/pf/accounts', { id: existing?.id, name: v.name, kind: v.kind, color: v.color, currency: code, opening_balance: toMinor(v.opening_balance || 0, code) - moves });
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
  h('span', { class: 'pf-row-main' }, h('b', {}, a.name), h('span', { class: 'pf-amt' }, curMoney(a.balance, a.currency)), h('small', {}, a.currency && a.currency !== 'GNF' ? `≈ ${fmtGNF(a.balance_base)} · ` : '', a.archived_at ? 'Archivé' : a.auto ? 'Automatique · lecture seule' : a.writable === false ? 'Lecture seule (formule gratuite)' : KIND_LABEL[a.kind])), icon('chevronRight', 18));
const wallindirainRow = (w) => h('a', { class: 'pf-row', href: '#/app/wallet' },
  h('span', { class: 'pf-ico pf-c-gold' }, icon('wallet', 24)),
  h('span', { class: 'pf-row-main' }, h('b', {}, 'Portefeuille Wallindirain'), h('span', { class: 'pf-amt' }, money(w.available)), h('small', {}, `Lecture seule${w.pending > 0 ? ` · ${money(w.pending)} en attente` : ''}`)), icon('chevronRight', 18));
const txRow = (t, onclick) => h('button', { class: 'pf-row', type: 'button', onclick },
  h('span', { class: `pf-ico pf-c-${t.color || 'blue'}` }, icon(t.kind === 'income' ? 'plus' : t.kind === 'expense' ? 'arrowUpRight' : 'arrowRight', 22)),
  h('span', { class: 'pf-row-main' }, h('b', {}, CAT_LABEL[t.category] || t.category), h('span', { class: `pf-amt ${t.kind === 'income' || t.kind === 'transfer_in' ? 'pos' : t.kind === 'expense' ? 'neg' : ''}` }, curMoney(t.kind === 'expense' || t.kind === 'transfer_out' ? -t.amount : t.amount, t.currency, true)), h('small', {}, `${t.account_name} · ${dayLabel(t.occurred_on)}${t.note ? ` · ${t.note}` : ''}`)));

async function editTx(t, accounts, done) {
  if (t.source === 'wallindirain') { toast('Ligne automatique : elle vient de votre portefeuille Wallindirain et ne se modifie pas ici.', 'ok'); return; }
  const isTransfer = t.kind === 'transfer_in' || t.kind === 'transfer_out';
  const v = await ask({ title: CAT_LABEL[t.category] || 'Transaction', text: `${curMoney(t.amount, t.currency)} · ${t.account_name} · ${dayLabel(t.occurred_on)}`, submit: isTransfer ? 'Fermer' : 'Modifier', fields: [] });
  if (!v) return;
  try {
    if (isTransfer) { if (await confirmBox('Annuler ce virement ?', 'Il sera annulé des deux comptes.', 'Annuler le virement', true)) { await post(`/pf/transactions/${t.id}/void`); toast('Virement annulé', 'ok'); done(); } return; }
    if (await askTx(t.kind, accounts, t)) { toast('Transaction modifiée', 'ok'); done(); }
  } catch (e) { errToast(e); }
}
const voidTx = (t, done) => action(async () => { if (await confirmBox('Supprimer cette transaction ?', 'Elle ne comptera plus dans vos soldes (conservée dans l\'historique interne).', 'Supprimer', true)) { await post(`/pf/transactions/${t.id}/void`); return true; } }, { ok: (r) => (r ? 'Transaction supprimée' : ''), refresh: done });

// ---------- Tableau de bord ----------
function homeScreen({ go, reload, st }) {
  let period = null;
  return liveView(async () => {
    const d = await get(`/pf/home${period ? `?period=${period}` : ''}`);
    const w = d.settings.widgets;
    d.plan = d.tier === 'pro' && (w.planned_payments || w.cash_forecast || w.budget) ? await get('/pf/plan').catch(() => null) : null;
    return d;
  }, (d, refresh) => {
    period ??= d.period;
    const chip = (p, label) => { const locked = d.tier !== 'pro' && PERIOD_DAYS(p) > 30; return h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(period === p), onclick: () => { if (locked) { go('pro'); return; } period = p; refresh(); } }, label, locked ? ' 🔒' : ''); };
    const active = d.accounts.filter((a) => !a.archived_at);
    const total = d.income + d.expense;
    const w = d.settings.widgets;
    const ratio = (r) => (r == null ? '–' : `×${r.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`);
    const periodTitle = (PERIOD_LABEL[d.period] || '').toUpperCase();
    const topExp = d.expense_by_category[0];
    const proLock = (title) => card(title, h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Disponible avec la formule Pro'), icon('chevronRight', 18)));
    const proNeeded = d.tier !== 'pro';
    return h('div', {},
      head('Tableau de bord', { right: h('button', { class: 'pf-gear', type: 'button', 'aria-label': 'Choisir les blocs affichés', onclick: () => go('general') }, icon('sliders', 20)) }),
      h('div', { class: 'pf-pad' },
        pfProfile() === null && profileChooser(reload),
        h('div', { class: 'pf-chips' }, PERIODS.map(([p, l]) => chip(p, l))),
        h('div', { class: 'pf-gauges' },
          h('div', { class: 'pf-g side' }, gaugeSvg(d.gauges.income, 96), h('span', { class: 'pf-g-l' }, 'Revenus'), h('b', {}, fmtShort(d.income))),
          h('div', { class: 'pf-g main' }, gaugeSvg(d.gauges.flow, 150), h('span', { class: 'pf-g-l' }, 'Flux de trésorerie'), h('b', {}, fmtShort(d.flow))),
          h('div', { class: 'pf-g side' }, gaugeSvg(d.gauges.balance, 96), h('span', { class: 'pf-g-l' }, 'Solde'), h('b', {}, fmtShort(d.balance)))),
        h('p', { class: 'pf-note center' }, `Aiguilles : 30 derniers jours contre les 30 d'avant · revenus ${ratio(d.gauges.ratios.income)} · flux ${ratio(d.gauges.ratios.flow)} · solde ${ratio(d.gauges.ratios.balance)}`),
        d.clamped && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Formule gratuite : cette période est limitée à 30 jours'), icon('chevronRight', 18)),
        active.length === 0 && card(null, h('div', { class: 'pf-start' }, h('span', { class: 'pf-ico pf-c-blue' }, icon('bank', 26)), h('div', {}, h('b', {}, 'Comment commencer ?'), h('p', {}, 'Créez votre premier compte (espèces, Orange Money…) puis notez vos revenus et vos dépenses.'),
          h('button', { class: 'pf-btn', type: 'button', onclick: action(async () => { await askAccount(); }, { ok: 'Compte créé', refresh }) }, 'Créer un compte')))),
        d.priced && d.tier !== 'pro' && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Formule gratuite · budgets, historique complet et statistiques avec Pro'), icon('chevronRight', 18)),
        d.on_trial && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, `Essai Pro jusqu'au ${new Date(d.trial_until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`), icon('chevronRight', 18)),
        w.exchange_rate && card('Taux de change', d.currencies.length === 0 ? h('p', { class: 'pf-note' }, 'Aucune devise ajoutée : le GNF est votre devise de base.') : d.currencies.map((c) => h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, `1 ${c.code}`), h('span', {}, rateText(c.rate))), h('small', {}, `${c.name} · mis à jour le ${new Date(c.updated_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`))), moreLink('Devises', () => go('currencies'))),
        w.balance && card('Solde', h('div', { class: 'pf-big' }, fmtGNF(d.balance)), h('div', { class: 'pf-sub' }, `${active.length} compte${active.length > 1 ? 's' : ''}`)),
        w.balance_evolution && card('Évolution du solde', h('div', { class: 'pf-sub' }, 'AUJOURD\'HUI'), h('div', { class: 'pf-big' }, fmtGNF(d.balance)), areaChart(d.series.map((p) => p.balance), d.series.map((p) => p.day))),
        w.accounts && card('Comptes', active.slice(0, 3).map((a) => accountRow(a, () => go(a.auto ? 'wallet' : 'accounts'))), !active.some((a) => a.auto) && wallindirainRow(d.wallindirain), moreLink('Afficher plus', () => go('accounts'))),
        st.wallet?.eligible && !st.wallet.linked && h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('wallet') }, icon('wallet', 22), h('span', {}, 'Reliez votre compte Wallindirain : gains, achats et retraits arrivent ici tout seuls.'), icon('chevronRight', 18)),
        w.cash_flow && card('Flux de trésorerie', h('div', { class: 'pf-sub' }, periodTitle), h('div', { class: 'pf-big' }, fmtGNF(d.flow)),
          flowBar('Tous les revenus', d.income, total, 'pos'), flowBar('Toutes les dépenses', d.expense, total, 'neg'), moreLink('Afficher plus', () => go('stats'))),
        w.expenses && card('Dépenses', h('div', { class: 'pf-sub' }, periodTitle), h('div', { class: 'pf-big' }, fmtGNF(d.expense)),
          d.expense_by_category.slice(0, 4).map((c) => flowBar(CAT_LABEL[c.category] || c.category, c.total, d.expense, 'neg')), moreLink('Afficher plus', () => go('stats'))),
        w.top_expense && card('Dépense principale', topExp ? [h('div', { class: 'pf-sub' }, CAT_LABEL[topExp.category] || topExp.category), h('div', { class: 'pf-big' }, fmtGNF(topExp.total)), flowBar(`${Math.round((topExp.total * 100) / Math.max(d.expense, 1))} % des dépenses`, topExp.total, d.expense, 'neg')] : h('p', { class: 'pf-note' }, 'Aucune dépense sur cette période.')),
        w.budget && (proNeeded ? proLock('Budget') : card('Budget du mois', !d.plan || d.plan.budgets.length === 0 ? h('p', { class: 'pf-note' }, 'Aucun budget. Créez-en dans le Plan financier.') : d.plan.budgets.slice(0, 4).map((b) => flowBar(CAT_LABEL[b.category] || b.category, b.spent, b.amount, b.spent > b.amount ? 'neg' : 'pos')), moreLink('Plan financier', () => go('plan')))),
        w.cash_forecast && (proNeeded ? proLock('Prévision de trésorerie') : card('Prévision de trésorerie', h('div', { class: 'pf-sub' }, 'DANS 30 JOURS'), h('div', { class: 'pf-big' }, fmtGNF(d.plan?.forecast.projected ?? d.balance)),
          h('dl', { class: 'pf-kv' }, h('dt', {}, 'Solde actuel'), h('dd', {}, fmtGNF(d.balance)), h('dt', {}, 'Revenus prévus'), h('dd', { class: 'pos' }, fmtGNF(d.plan?.forecast.income ?? 0)), h('dt', {}, 'Dépenses prévues'), h('dd', { class: 'neg' }, fmtGNF(d.plan?.forecast.expense ?? 0))), moreLink('Plan financier', () => go('plan')))),
        w.planned_payments && (proNeeded ? proLock('Paiements planifiés') : card('Paiements planifiés', !d.plan || d.plan.forecast.upcoming.length === 0 ? h('p', { class: 'pf-note' }, 'Rien de prévu dans les 30 prochains jours.') : d.plan.forecast.upcoming.slice(0, 5).map((u) => h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, u.label), h('span', { class: u.kind === 'income' ? 'pos' : 'neg' }, money(u.kind === 'income' ? u.amount : -u.amount, true))), h('small', {}, dayLabel(u.day)))), moreLink('Gérer', () => go('recurring')))),
        d.recent.length > 0 && w.recent_tx && card('Dernières transactions', d.recent.map((t) => txRow(t, () => go('tx'))), moreLink('Tout voir', () => go('tx')))),
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
    const open = (a) => () => go(a.auto ? 'wallet' : `account-${a.id}`);
    const archive = (a) => action(async () => { await post(`/pf/accounts/${a.id}/archive`, { archived: !a.archived_at }); }, { ok: a.archived_at ? 'Compte rétabli' : 'Compte archivé', refresh });
    return h('div', {}, head('Comptes', { back: ['Plus', () => go('more')] }),
      h('div', { class: 'pf-pad' },
        o.accounts.length === 0 ? empty('bank', 'Aucun compte pour le moment.') : h('section', { class: 'pf-card flush' }, o.accounts.map((a) => h('div', { class: 'pf-acc' }, accountRow(a, open(a)),
          !a.auto && h('button', { class: 'pf-mini', type: 'button', onclick: archive(a) }, a.archived_at ? 'Rétablir' : 'Archiver')))),
        h('p', { class: 'pf-note' }, 'Ces comptes sont vos notes personnelles. Ils ne contiennent pas d\'argent détenu par Wallindirain et n\'ont aucun effet sur votre portefeuille.')),
      fab(o.accounts, refresh));
  });
}

// ---------- Détail d'un compte : solde, courbe sur 30 jours, opérations, ajout direct ----------
function accountScreen({ go, id }) {
  const host = h('div', {});
  const load = async () => {
    const [accs, res] = await Promise.all([get('/pf/accounts'), get(`/pf/transactions?account=${id}`)]);
    const a = accs.accounts.find((x) => x.id === id);
    if (!a) { host.replaceChildren(h('div', { class: 'pf-pad' }, empty('bank', 'Compte introuvable.'))); return; }
    // courbe : on remonte dans le temps depuis le solde actuel en défaisant les opérations
    const net = (t) => (t.kind === 'income' || t.kind === 'transfer_in' ? 1 : -1) * Number(t.amount);
    const days = [], values = [];
    let bal = Number(a.balance);
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      days.unshift(d); values.unshift(bal / (CURRENCIES[a.currency]?.decimals === 2 ? 100 : 1));
      bal -= res.transactions.filter((t) => t.occurred_on === d).reduce((n, t) => n + net(t), 0);
    }
    const done = load;
    const edit = async () => { try { if (await askAccount(a)) { toast('Compte modifié', 'ok'); load(); } } catch (e) { errToast(e); } };
    const writable = a.writable !== false && !a.archived_at;
    const menu = () => {
      const run = (fn) => async () => { try { if (await fn()) done(); } catch (e) { errToast(e); } };
      const items = [['Nouvelle dépense', 'arrowUpRight', () => askTx('expense', accs.accounts, null, id)], ['Nouveau revenu', 'plus', () => askTx('income', accs.accounts, null, id)], ['Virement', 'arrowRight', () => askTransfer(accs.accounts, id)]];
      const close = () => overlay.remove();
      const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, h('div', { class: 'modal sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ajouter' }, h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
        h('div', { class: 'more-list' }, items.map(([label, ico, fn]) => h('button', { class: 'more-row', type: 'button', onclick: () => { close(); run(fn)(); } }, icon(ico, 22), h('span', { class: 'grow' }, label), icon('chevronRight', 18)))),
        h('button', { class: 'btn btn-ghost btn-block mt', type: 'button', onclick: close }, 'Fermer')));
      document.body.append(overlay);
    };
    host.replaceChildren(h('div', { class: 'pf-pad' },
      card('30 derniers jours', h('div', { class: 'pf-big' }, curMoney(a.balance, a.currency)), a.currency && a.currency !== 'GNF' && h('small', { class: 'pf-note' }, `≈ ${fmtGNF(a.balance_base)}`), areaChart(values, days)),
      res.transactions.length === 0 ? empty('receipt', 'Aucune opération sur ce compte pour le moment.') : h('section', { class: 'pf-card flush' }, res.transactions.map((t) => txRow(t, () => editTx(t, accs.accounts, done)))),
      res.history_limited && h('p', { class: 'pf-note' }, `Formule gratuite : les ${res.history_limited} derniers jours sont affichés.`)),
      writable && h('button', { class: 'pf-fab wide', type: 'button', onclick: menu }, icon('plus', 22), h('span', {}, 'Transaction')));
    host.prepend(head(a.name, { back: ['Comptes', () => go('accounts')], right: h('button', { class: 'pf-back', type: 'button', onclick: edit }, h('span', {}, 'Modifier')) }));
  };
  load().catch(errToast);
  return host;
}

// ---------- Données personnelles et confidentialité ----------
function privacyScreen({ go, head, card }) {
  const doc = (slug, text) => h('button', { class: 'pf-set', type: 'button', onclick: () => showLegal(slug) }, icon('receipt', 22), h('span', { class: 'grow' }, text), h('small', { class: 'pf-note' }, 'Consulter'), icon('chevronRight', 18));
  const erase = async () => {
    if (!await confirmBox('Effacer mes données Mes finances ?', 'Comptes, transactions, budgets, objectifs, contacts, catégories et devises de Mes finances seront effacés définitivement. Votre compte Wallindirain, votre portefeuille et vos commandes ne sont pas touchés.', 'Continuer', true)) return;
    const v = await ask({ title: 'Dernière confirmation', text: 'Tapez EFFACER pour confirmer. Cette action ne peut pas être annulée.', submit: 'Effacer mes données', fields: [{ name: 'confirm', label: 'EFFACER', maxlength: 20 }] });
    if (!v) return;
    try { await post('/pf/erase', { confirm: v.confirm.trim().toUpperCase() }); toast('Vos données Mes finances ont été effacées.', 'ok'); go(''); } catch (e) { errToast(e); }
  };
  return h('div', {}, head('Données personnelles', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' },
    h('h3', { class: 'pf-sub' }, 'DOCUMENTS À CONSULTER'), h('section', { class: 'pf-card flush' }, doc('confidentialite', 'Politique de confidentialité'), doc('conditions', 'Conditions d\'utilisation')),
    h('h3', { class: 'pf-sub' }, 'VOS DROITS'),
    h('p', { class: 'pf-note' }, 'Vous pouvez modifier vos données à tout moment : modifiez le profil, vos comptes et vos transactions directement dans l\'application.'),
    h('p', { class: 'pf-note' }, 'Vous pouvez aussi effacer toutes les données de Mes finances. Cela ne supprime pas votre compte Wallindirain : l\'argent de votre portefeuille et vos commandes restent gérés comme avant. Pour fermer entièrement votre compte, contactez le support.'),
    h('p', { class: 'pf-note' }, 'Si vous avez un espace de groupe dont vous êtes propriétaire, archivez-le d\'abord : il appartient à plusieurs personnes.'),
    h('button', { class: 'btn btn-bad btn-block', type: 'button', onclick: erase }, icon('alert', 18), ' Effacer mes données Mes finances')));
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
  let period = null;
  return liveView(() => get(`/pf/home${period ? `?period=${period}` : ''}`), (d, refresh) => {
    period ??= d.period;
    const chip = (p, label) => { const locked = d.tier !== 'pro' && PERIOD_DAYS(p) > 30; return h('button', { class: 'pf-chip', type: 'button', 'aria-pressed': String(period === p), onclick: () => { if (locked) { go('pro'); return; } period = p; refresh(); } }, label, locked ? ' 🔒' : ''); };
    const cats = (list, labels, tone) => list.length === 0 ? h('p', { class: 'pf-note' }, 'Rien sur cette période.') : list.map((c) => {
      const max = list[0].total; const f = h('span', { class: `pf-bar-fill ${tone}` }); f.style.width = `${Math.max(4, Math.round((c.total * 100) / max))}%`;
      return h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, labels[c.category] || c.category), h('span', {}, fmtGNF(c.total))), h('span', { class: 'pf-bar-track' }, f));
    });
    return h('div', {}, head('Statistiques'), h('div', { class: 'pf-pad' },
      h('div', { class: 'pf-chips' }, PERIODS.map(([p, l]) => chip(p, l))),
      card('Résumé', h('dl', { class: 'pf-kv' }, h('dt', {}, 'Revenus'), h('dd', { class: 'pos' }, fmtGNF(d.income)), h('dt', {}, 'Dépenses'), h('dd', { class: 'neg' }, fmtGNF(d.expense)), h('dt', {}, 'Flux net'), h('dd', {}, fmtGNF(d.flow)), h('dt', {}, 'Solde actuel'), h('dd', {}, fmtGNF(d.balance)))),
      card('Dépenses par catégorie', cats(d.expense_by_category, CAT_LABEL, 'neg')),
      card('Revenus par catégorie', cats(d.income_by_category, CAT_LABEL, 'pos')),
      card('Évolution du solde', areaChart(d.series.map((p) => p.balance), d.series.map((p) => p.day)))));
  });
}

// ---------- Plan financier (budgets, objectif du mois, récurrents, prévision) ----------
const FREQ_LABEL = { daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois' };
const lock = (go) => h('button', { class: 'pf-upsell', type: 'button', onclick: () => go('pro') }, proBadge(), h('span', {}, 'Le plan financier fait partie de la formule Pro. Vos données restent visibles.'), icon('chevronRight', 18));
const needPro = (d, go) => { if (d.tier === 'pro') return false; go('pro'); return true; };

async function askRecurring(existing) {
  await loadCats().catch(() => null);
  let kind = existing?.kind;
  if (!kind) { const k = await ask({ title: 'Nouveau récurrent', text: 'Un revenu ou une dépense qui revient.', submit: 'Suivant', fields: [{ name: 'kind', label: 'Type', type: 'select', options: [['expense', 'Dépense'], ['income', 'Revenu']], value: 'expense' }] }); if (!k) return false; kind = k.kind; }
  const options = catOptions(kind, existing?.category);
  const v = await ask({ title: existing ? 'Modifier le récurrent' : (kind === 'income' ? 'Nouveau revenu récurrent' : 'Nouvelle dépense récurrente'), text: 'Il sert à la prévision : rien n\'est enregistré automatiquement.', submit: 'Enregistrer', fields: [
    { name: 'label', label: 'Nom (ex. Loyer, Salaire)', value: existing?.label || '', maxlength: 40 },
    { name: 'category', label: 'Catégorie', type: 'select', options, value: existing?.category || options[0]?.[0] },
    { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: existing?.amount ?? '' },
    { name: 'frequency', label: 'Fréquence', type: 'select', options: Object.entries(FREQ_LABEL), value: existing?.frequency || 'monthly' },
    { name: 'anchor_on', label: 'Prochaine date (mensuel : jour 1 à 28)', type: 'date', value: existing?.anchor_on || today() }] });
  if (!v) return false;
  await post('/pf/recurring', { id: existing?.id, label: v.label, kind, category: v.category, amount: Number(v.amount), frequency: v.frequency, anchor_on: v.anchor_on });
  return true;
}
async function askBudget(category, current) {
  const v = await ask({ title: `Budget · ${CAT_LABEL[category]}`, text: 'Combien voulez-vous dépenser au plus chaque mois dans cette catégorie ? Laissez vide pour retirer le budget.', submit: 'Enregistrer', fields: [
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
      const left = catOptions('expense').filter(([k]) => !used.has(k));
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
            h('div', { class: 'pf-flow-row' }, h('b', {}, CAT_LABEL[b.category]), h('span', { class: b.spent > b.amount ? 'neg' : '' }, `${fmtGNF(b.spent)} / ${fmtGNF(b.amount)}`)), bar(b.spent, b.amount, b.spent > b.amount))),
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
    (pfProfile() === 'business' || pfProfile() === 'both') && st.spaces_enabled && tile('users', 'Espaces de groupe', 'Budget partagé', () => go('spaces')),
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
    row('sliders', 'Général, tableau de bord et jauges', () => go('general')), row('wallet', 'Devises et taux de change', () => go('currencies')), row('dashboard', 'Tableau de bord', () => go('')), row('chart', 'Objectifs des jauges', () => go('gauges')), row('bag', 'Catégories et profil', () => go('categories')), row('bank', 'Comptes', () => go('accounts')),
    st.wallet?.eligible && row('wallet', 'Compte Wallindirain', () => go('wallet')),
    row('users', 'Contacts et étiquettes', () => go('contacts')), row('clock', 'Budgets et objectif du mois', () => go('plan')), row('receipt', 'Revenus et dépenses récurrents', () => go('recurring')), row('star', 'Formule et abonnement', () => go('pro')),
    row('shield', 'Sécurité', null, '#/app/profile'), row('shield', 'Données personnelles et confidentialité', () => go('privacy'))),
    h('p', { class: 'pf-note' }, 'Vos données financières personnelles ne sont visibles que par vous. Vous pouvez archiver un compte à tout moment ; rien n\'est partagé avec les autres utilisateurs.')));
}
const rateText = (r) => `${Number(r).toLocaleString('fr-FR', { maximumFractionDigits: 4 }).replace(/[\u202f\u00a0]/g, ' ')} GNF`;
const CUR_PRESETS = { USD: ['Dollar américain', 2], EUR: ['Euro', 2], XOF: ['Franc CFA (BCEAO)', 0], XAF: ['Franc CFA (BEAC)', 0], GBP: ['Livre sterling', 2], CNY: ['Yuan chinois', 2], AED: ['Dirham des Émirats', 2], MAD: ['Dirham marocain', 2], SAR: ['Riyal saoudien', 2], CAD: ['Dollar canadien', 2], CHF: ['Franc suisse', 2], NGN: ['Naira nigérian', 2], GHS: ['Cedi ghanéen', 2] };

async function askCurrency(existing) {
  const isNew = !existing;
  const v = await ask({ title: isNew ? 'Ajouter une devise' : `Taux du ${existing.code}`, text: isNew ? 'Votre devise de base reste le GNF. Vous saisissez vous-même le taux et le mettez à jour quand vous voulez.' : existing.name, submit: 'Enregistrer', fields: [
    ...(isNew ? [{ name: 'preset', label: 'Devise', type: 'select', options: [...Object.entries(CUR_PRESETS).filter(([c]) => !CURRENCIES[c]).map(([c, [n]]) => [c, `${c} · ${n}`]), ['OTHER', 'Autre devise…']], value: 'USD' },
      { name: 'custom', label: 'Si « Autre » : code à 3 lettres (ex. JPY)', required: false, maxlength: 3 },
      { name: 'name', label: 'Si « Autre » : nom de la devise', required: false, maxlength: 40 },
      { name: 'decimals', label: 'Si « Autre » : décimales', type: 'select', options: [['0', '0'], ['2', '2'], ['3', '3']], value: '2' }] : []),
    { name: 'rate', label: `Taux : 1 ${existing?.code || 'unité'} = combien de GNF ?`, type: 'number', step: 'any', inputmode: 'decimal', value: existing?.rate ?? '' }] });
  if (!v) return false;
  let code = existing?.code, name = existing?.name, decimalsN = existing?.decimals;
  if (isNew) {
    if (v.preset === 'OTHER') { code = String(v.custom || '').trim().toUpperCase(); name = String(v.name || '').trim() || code; decimalsN = Number(v.decimals); } else { code = v.preset; [name, decimalsN] = CUR_PRESETS[v.preset]; }
  }
  await post('/pf/currencies', { code, name, decimals: decimalsN, rate: v.rate });
  return true;
}

/** Paramètres → Devises : GNF en base, « + » pour en ajouter, taux saisis à la main. */
function currenciesScreen({ go }) {
  return liveView(() => get('/pf/currencies'), (d, refresh) => {
    CURRENCIES = Object.fromEntries(d.currencies.map((c) => [c.code, c]));
    const add = action(async () => { await askCurrency(); }, { ok: 'Devise ajoutée', refresh });
    const edit = (c) => action(async () => { await askCurrency(c); }, { ok: 'Taux enregistré', refresh });
    const remove = (c) => action(async () => { if (await confirmBox(`Retirer le ${c.code} ?`, 'Aucun compte ne l\'utilise. Vous pourrez l\'ajouter de nouveau.', 'Retirer', true)) await post(`/pf/currencies/${c.code}/remove`, {}); }, { ok: 'Devise retirée', refresh });
    const auto = h('input', { type: 'checkbox', checked: d.rates_auto, onchange: action(async () => { await post('/pf/rates-auto', { on: auto.checked }); }, { ok: 'Réglage enregistré', refresh }) });
    return h('div', {}, head('Devises', { back: ['Paramètres', () => go('settings')], right: h('button', { class: 'pf-gear', type: 'button', 'aria-label': 'Ajouter une devise', onclick: add }, icon('plus', 24)) }),
      h('div', { class: 'pf-pad' },
        card('Devise de base', h('div', { class: 'pf-row static' }, h('span', { class: 'pf-ico pf-c-green' }, h('b', {}, 'GNF')), h('span', { class: 'pf-row-main' }, h('b', {}, d.base.name), h('small', {}, 'Tous vos totaux sont calculés dans cette devise')))),
        card('Mes autres devises', d.currencies.length === 0 ? h('p', { class: 'pf-note' }, 'Aucune pour le moment. Touchez « + » en haut pour en ajouter une (dollar, euro, franc CFA…).')
          : d.currencies.map((c) => h('div', { class: 'pf-acc' }, h('button', { class: 'pf-row', type: 'button', onclick: edit(c) }, h('span', { class: 'pf-ico pf-c-blue' }, h('b', {}, c.code)), h('span', { class: 'pf-row-main' }, h('b', {}, c.name), h('span', { class: 'pf-amt' }, `1 ${c.code} = ${rateText(c.rate)}`), h('small', {}, `${c.accounts} compte${c.accounts > 1 ? 's' : ''} · mis à jour le ${new Date(c.updated_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`))),
            c.accounts === 0 && h('button', { class: 'pf-mini', type: 'button', onclick: remove(c) }, 'Retirer'))),
          d.free_currencies != null && h('p', { class: 'pf-note' }, `Formule gratuite : ${d.free_currencies} devise en plus du GNF. Pro : autant que vous voulez.`)),
        card('Taux de change', h('label', { class: 'pf-opt' }, h('span', { class: 'grow' }, 'Mise à jour automatique des taux', h('small', {}, 'Réglage enregistré. Aucun service de taux n\'est encore connecté : pour l\'instant, vos taux restent ceux que vous saisissez.')), auto),
          h('p', { class: 'pf-note' }, 'Changer un taux recalcule vos totaux en GNF (tableau de bord, statistiques, budgets). Le solde de chaque compte, lui, reste dans sa devise.'))));
  });
}
const WIDGET_INFO = [['balance_evolution', 'Évolution du solde'], ['accounts', 'Comptes'], ['cash_flow', 'Flux de trésorerie'], ['planned_payments', 'Paiements planifiés', true], ['cash_forecast', 'Prévision de trésorerie', true], ['balance', 'Solde'], ['expenses', 'Dépenses'], ['top_expense', 'Dépense principale'], ['budget', 'Budget', true], ['recent_tx', 'Dernières transactions'], ['exchange_rate', 'Taux de change']];
const GAUGE_INFO = [['income', 'Revenus', 'Revenus d\'exploitation des 30 derniers jours ÷ ceux des 30 jours d\'avant (financements et remboursements de prêt exclus).'], ['flow', 'Flux de trésorerie', 'Flux net des 30 derniers jours ÷ celui des 30 jours d\'avant.'], ['balance', 'Solde', 'Solde actuel ÷ solde d\'il y a 30 jours.']];

/** Paramètres → Général : décimales, période par défaut, blocs du tableau de bord, seuils des jauges. */
function generalScreen({ go }) {
  return liveView(() => get('/pf/settings'), (set, refresh) => {
    const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
    const dec = h('input', { type: 'checkbox', checked: set.decimals });
    const per = h('select', {}, PERIODS.map(([k, l]) => h('option', { value: k, selected: k === set.default_period }, l)));
    const wid = Object.fromEntries(WIDGET_INFO.map(([k]) => [k, h('input', { type: 'checkbox', checked: !!set.widgets[k] })]));
    const gin = {}; for (const [g] of GAUGE_INFO) for (const side of ['low', 'high']) gin[`${g}_${side}`] = h('input', { type: 'number', step: '0.05', min: '0', max: '10', inputmode: 'decimal', value: set.gauges[`${g}_${side}`] ?? '', placeholder: String(set.defaults.gauges[g][side === 'low' ? 0 : 1]).replace('.', ',') });
    const save = action(async () => {
      const gauges = Object.fromEntries(Object.entries(gin).map(([k, el]) => [k, num(el.value)]).filter(([, v]) => v !== null));
      await post('/pf/settings', { decimals: dec.checked, default_period: per.value, widgets: Object.fromEntries(WIDGET_INFO.map(([k]) => [k, wid[k].checked])), gauges });
      decimals = dec.checked;
    }, { ok: 'Paramètres enregistrés', refresh });
    const reset = action(async () => { for (const el of Object.values(gin)) el.value = ''; }, {});
    const line = (label, ctrl, hint) => h('label', { class: 'pf-opt' }, h('span', { class: 'grow' }, label, hint && h('small', {}, hint)), ctrl);
    return h('div', {}, head('Général', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' },
      card('Général',
        line('Utiliser des décimales dans les montants', dec, 'Affiche deux décimales (1 000,00). Le franc guinéen n\'a pas de centimes : utile pour d\'autres devises.'),
        line('Période par défaut des statistiques', per),
        line('Devise de base', h('b', {}, 'GNF'), 'Pour ajouter d\'autres devises : Paramètres → Devises.')),
      card('Tableau de bord', h('p', { class: 'pf-note' }, 'Choisissez les blocs à afficher. Les blocs Pro restent visibles mais verrouillés dans la formule gratuite.'),
        WIDGET_INFO.map(([k, l, pro]) => line(l, wid[k], pro ? 'Pro' : undefined))),
      card('Jauges', h('p', { class: 'pf-note' }, 'Réglez à partir de quel rapport l\'aiguille passe de « faible » (rouge) à « élevé » (vert). Exemple : 0,9 et 1,2. Vide = valeur par défaut.'),
        GAUGE_INFO.map(([g, l, help]) => h('div', { class: 'pf-gset' }, h('b', {}, l), h('small', {}, help),
          h('div', { class: 'pf-gset-row' }, h('label', {}, 'Faible en dessous de', gin[`${g}_low`]), h('label', {}, 'Élevé à partir de', gin[`${g}_high`])))),
        h('button', { class: 'pf-btn ghost block', type: 'button', onclick: reset }, 'Remettre les valeurs par défaut')),
      h('button', { class: 'pf-btn block', type: 'button', onclick: save }, 'Enregistrer'),
      h('p', { class: 'pf-note' }, 'Ces réglages ne concernent que vous.')));
  });
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
    return h('div', {}, head('Objectifs des jauges', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' }, card(null,
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
