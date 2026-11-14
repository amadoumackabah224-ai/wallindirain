// « Mes finances » (migration 048) : comptes personnels, transactions, tableau de bord, formule gratuite / Pro.
// Ce sont des notes personnelles : aucune écriture du portefeuille de la plateforme n'est créée ici (sauf le paiement de l'abonnement, fait par la base).
// Le compte « Wallindirain » est lu depuis le portefeuille réel, en lecture seule.
import { HttpError, v } from './http.js';

const DAY = 86_400_000;
export const INCOME_CATEGORIES = ['sales', 'salary', 'gift', 'other_in'];
export const EXPENSE_CATEGORIES = ['food', 'transport', 'housing', 'telecom', 'health', 'family', 'business', 'shopping', 'savings', 'other_out'];
const KINDS = ['cash', 'mobile_money', 'bank', 'savings', 'other'];
const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'brown', 'teal', 'grey'];
const ROLES = ['admin', 'supplier', 'seller', 'agent', 'call_chief', 'courier', 'warehouse', 'member'];
export const FREE_MAX_DAYS = 30;

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const ymd = (x, name = 'Date') => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw new HttpError(400, 'invalid_input', `${name} invalide`);
  return x;
};
/** Clé de catégorie : lettres, chiffres et _ ; l'existence (système ou à la personne) et le type sont contrôlés par la base. */
const catKey = (x) => { if (typeof x !== 'string' || !/^[a-z0-9_]{1,40}$/.test(x)) throw new HttpError(400, 'invalid_input', 'Catégorie invalide'); return x; };
const optInt = (x, name, max = 1e11) => (x == null || x === '' ? null : v.int(x, name, { min: 1, max }));

export const GAUGE_DEFAULTS = { income: [0.9, 1.2], flow: [0.9, 1.2], balance: [0.9, 1.2] };
export const WIDGETS = ['balance_evolution', 'accounts', 'cash_flow', 'planned_payments', 'cash_forecast', 'balance', 'expenses', 'top_expense', 'exchange_rate', 'budget', 'recent_tx'];
export const WIDGET_DEFAULTS = { balance_evolution: true, accounts: true, cash_flow: true, recent_tx: true };
export const PERIODS = ['today', 'week', 'month', 'year', 'd7', 'd30', 'w12', 'm6', 'y1'];

/** Nombre de jours d'une période (la semaine commence le lundi ; mois et année en cours depuis le 1er). */
export function periodDays(period, now = new Date()) {
  const y = now.getUTCFullYear();
  switch (period) {
    case 'today': return 1;
    case 'week': return ((now.getUTCDay() + 6) % 7) + 1;
    case 'month': return now.getUTCDate();
    case 'year': return Math.floor((Date.UTC(y, now.getUTCMonth(), now.getUTCDate()) - Date.UTC(y, 0, 1)) / DAY) + 1;
    case 'd7': return 7;
    case 'w12': return 84;
    case 'm6': return 182;
    case 'y1': return 365;
    default: return 30;
  }
}

/**
 * Position de l'aiguille (0 = rouge, 1 = vert) pour un rapport « maintenant ÷ période d'avant ».
 * En dessous du seuil « faible » : zone rouge ; entre les deux seuils : zone orange ; à partir du seuil « élevé » : zone verte.
 */
export function ratioPosition(r, low, high) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r < low) return clamp(0.33 * (r / low));
  if (r < high) return clamp(0.33 + 0.34 * ((r - low) / (high - low)));
  return clamp(0.67 + 0.33 * Math.min(1, (r - high) / Math.max(high, 0.01)));
}
/** Rapport actuel / précédent ; sans base de comparaison, on lit le signe (vert si ça monte depuis rien, rouge si négatif). */
function ratioOf(now, before) {
  if (before > 0) return now / before;
  return now > 0 ? 2 : now === 0 ? null : 0;
}

/**
 * Jauges : chaque aiguille compare les 30 derniers jours aux 30 d'avant (solde : maintenant et il y a 30 jours).
 * Revenus : revenus d'exploitation seulement (financements et remboursements de prêt exclus). Un objectif réglé remplace la comparaison.
 */
export function gauges({ opIncome, prevOpIncome, net, prevNet, balance, balance30, incomeTarget, balanceTarget, thresholds = GAUGE_DEFAULTS }) {
  const t = { ...GAUGE_DEFAULTS, ...thresholds };
  const incomeR = incomeTarget ? opIncome / incomeTarget : ratioOf(opIncome, prevOpIncome);
  const flowR = ratioOf(net, prevNet);
  const balanceR = balanceTarget ? balance / balanceTarget : ratioOf(balance, balance30);
  const pos = (r, [lo, hi], fallback) => (r === null ? fallback : ratioPosition(r, lo, hi));
  return {
    income: pos(incomeR, t.income, opIncome === 0 && prevOpIncome === 0 ? 0 : 0.5),
    flow: pos(flowR, t.flow, 0.5),
    balance: pos(balanceR, t.balance, balance > 0 ? 0.75 : balance < 0 ? 0 : 0.5),
    ratios: { income: incomeR, flow: flowR, balance: balanceR }
  };
}

/** Dates où un récurrent tombe entre `from` et `to` inclus (chaînes AAAA-MM-JJ). */
export function occurrences(r, from, to) {
  const out = [];
  const a = new Date(`${r.anchor_on}T00:00:00Z`), f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`);
  if (r.frequency === 'monthly') {
    for (let y = f.getUTCFullYear(), m = f.getUTCMonth(); Date.UTC(y, m, 1) <= t.getTime(); m++) {
      const d = new Date(Date.UTC(y, m, a.getUTCDate()));
      if (d >= a && d >= f && d <= t) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  const step = r.frequency === 'daily' ? 1 : 7;
  let d = a < f ? new Date(a.getTime() + Math.ceil((f - a) / (step * DAY)) * step * DAY) : a;
  for (; d <= t; d = new Date(d.getTime() + step * DAY)) out.push(d.toISOString().slice(0, 10));
  return out;
}

export function registerPf(app, { q, fn, guard, limit }) {
  const ALL = ROLES;
  const featureOn = async () => Number((await q(`SELECT value FROM settings WHERE key = 'feature_finances_perso'`))[0]?.value ?? 0) >= 1;
  const setting = async (k) => Number((await q('SELECT value FROM settings WHERE key = $1', [k]))[0]?.value ?? 0);

  async function access(id) {
    const [r] = await q(`SELECT fn_pf_tier($1) AS tier, a.trial_until, a.paid_until FROM (SELECT 1) x LEFT JOIN pf_access a ON a.owner_id = $1`, [id]);
    const [s] = await q(`SELECT (SELECT value FROM settings WHERE key = 'pf_price_monthly')::bigint AS monthly, (SELECT value FROM settings WHERE key = 'pf_price_yearly')::bigint AS yearly,
        (SELECT value FROM settings WHERE key = 'pf_trial_days')::int AS trial_days, (SELECT value FROM settings WHERE key = 'pf_free_accounts')::int AS free_accounts,
        (SELECT value FROM settings WHERE key = 'pf_free_history_days')::int AS free_history_days`);
    const priced = Number(s.monthly) > 0;
    return { tier: r.tier, priced, trial_until: r.trial_until, paid_until: r.paid_until,
      on_trial: priced && r.tier === 'pro' && !(r.paid_until && Date.parse(String(r.paid_until).replace(' ', 'T').replace(/\+00$/, 'Z')) > Date.now()),
      prices: { monthly: Number(s.monthly), yearly: Number(s.yearly) }, trial_days: s.trial_days, free_accounts: s.free_accounts, free_history_days: s.free_history_days };
  }

  async function accountsOf(id, acc) {
    const rows = await q(`SELECT a.id, a.name, a.kind, a.color, a.currency, COALESCE(c.decimals, 0)::int AS decimals, c.rate::float8 AS rate, a.opening_balance::bigint AS opening_balance, a.created_at, a.archived_at,
        (a.opening_balance + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount_orig ELSE -t.amount_orig END) FROM pf_all_tx t WHERE t.account_id = a.id AND t.voided_at IS NULL), 0))::bigint AS balance,
        a.archived_at IS NULL AS open
      FROM pf_accounts a LEFT JOIN pf_currencies c ON c.owner_id = a.owner_id AND c.code = a.currency WHERE a.owner_id = $1 ORDER BY a.archived_at NULLS FIRST, a.created_at, a.id`, [id]);
    // solde converti en GNF au taux enregistré (les comptes en GNF restent tels quels)
    for (const a of rows) { a.rate = a.rate == null ? null : Number(a.rate); a.decimals = Number(a.decimals); }
    for (const a of rows) a.balance_base = a.currency === 'GNF' || !a.rate ? Number(a.balance) : Math.round((Number(a.balance) / 10 ** a.decimals) * a.rate);
    // formule gratuite : seuls les plus anciens comptes actifs reçoivent des transactions (même règle que la base)
    let rank = 0;
    const list = rows.map((a) => ({ ...a, writable: a.open && (acc.tier === 'pro' || ++rank <= acc.free_accounts) }));
    // compte Wallindirain automatique (si relié) : lecture seule, solde = argent disponible du portefeuille
    const [link] = await q('SELECT wallet_linked, wallet_account FROM pf_prefs WHERE owner_id = $1', [id]);
    if (link?.wallet_linked) {
      const [w] = await q('SELECT COALESCE(sum(amount), 0)::bigint AS bal FROM wallet_entries WHERE user_id = $1 AND available_at <= now()', [id]);
      list.push({ id: 'wallindirain', name: 'Wallindirain', kind: 'wallindirain', color: 'teal', opening_balance: 0, created_at: null, archived_at: null, balance: Number(w.bal), balance_base: Number(w.bal), currency: 'GNF', decimals: 0, rate: null, open: true, writable: false, auto: true, receives: link.wallet_account });
    }
    return list;
  }
  const WALLET_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

  app.get('/api/pf/status', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const [link] = await q('SELECT wallet_linked, wallet_account FROM pf_prefs WHERE owner_id = $1', [ctx.user.id]);
    return { enabled: true, spaces_enabled: await spaceFlag(), ...(await access(ctx.user.id)), wallet: { eligible: WALLET_ROLES.includes(ctx.user.role), linked: !!link?.wallet_linked, account: link?.wallet_account || null } };
  }));

  /** Tout l'écran « Tableau de bord » en un seul appel. */
  /** Rubriques de catégories hors exploitation (financements, remboursements de prêt), y compris les sous-catégories ajoutées par la personne. */
  async function nonOperating(id) {
    const rows = [...(await q('SELECT key, parent_key AS parent, operating FROM pf_cat_system')), ...(await q('SELECT key, parent_key AS parent, true AS operating FROM pf_cat_custom WHERE owner_id = $1', [id]))];
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    const out = new Set();
    for (const r of rows) { let c = r; for (let i = 0; i < 5 && c.parent; i++) c = by[c.parent] || { operating: true }; if (c.operating === false) out.add(r.key); }
    return out;
  }
  const settingsOf = (pref) => ({
    decimals: !!pref?.decimals, default_period: pref?.default_period || 'd30',
    widgets: { ...Object.fromEntries(WIDGETS.map((w) => [w, !!WIDGET_DEFAULTS[w]])), ...(pref?.widgets || {}) },
    gauges: { income_low: pref?.g_income_low == null ? null : Number(pref.g_income_low), income_high: pref?.g_income_high == null ? null : Number(pref.g_income_high),
      flow_low: pref?.g_flow_low == null ? null : Number(pref.g_flow_low), flow_high: pref?.g_flow_high == null ? null : Number(pref.g_flow_high),
      balance_low: pref?.g_balance_low == null ? null : Number(pref.g_balance_low), balance_high: pref?.g_balance_high == null ? null : Number(pref.g_balance_high) },
    defaults: { gauges: GAUGE_DEFAULTS }
  });
  const thresholdsOf = (g) => ({ income: [g.income_low ?? 0.9, g.income_high ?? 1.2], flow: [g.flow_low ?? 0.9, g.flow_high ?? 1.2], balance: [g.balance_low ?? 0.9, g.balance_high ?? 1.2] });

  app.get('/api/pf/settings', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const [pref] = await q('SELECT decimals, default_period, widgets, g_income_low, g_income_high, g_flow_low, g_flow_high, g_balance_low, g_balance_high FROM pf_prefs WHERE owner_id = $1', [ctx.user.id]);
    return { enabled: true, ...settingsOf(pref) };
  }));
  app.post('/api/pf/settings', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    if (b.widgets != null && (typeof b.widgets !== 'object' || Array.isArray(b.widgets))) throw new HttpError(400, 'invalid_input', 'Réglage des blocs invalide');
    if (b.gauges != null && (typeof b.gauges !== 'object' || Array.isArray(b.gauges))) throw new HttpError(400, 'invalid_input', 'Seuils invalides');
    await fn('fn_pf_settings_set', ctx.user.id, b.decimals === true, v.oneOf(b.default_period, PERIODS, 'Période'), b.widgets == null ? null : JSON.stringify(b.widgets), b.gauges == null ? null : JSON.stringify(b.gauges));
    return { ok: true };
  }));

  /** Tout l'écran « Tableau de bord » en un seul appel. */
  app.get('/api/pf/home', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id;
    if (ctx.user.role === 'admin' && !(await q('SELECT 1 FROM pf_prefs WHERE owner_id = $1 AND profile IS NOT NULL', [id])).length) await fn('fn_pf_profile_set', id, 'business').catch(() => null);
    const acc = await access(id);
    const [pref] = await q('SELECT income_target, balance_target, decimals, default_period, widgets, g_income_low, g_income_high, g_flow_low, g_flow_high, g_balance_low, g_balance_high FROM pf_prefs WHERE owner_id = $1', [id]);
    const settings = settingsOf(pref);
    const period = ctx.query.days ? null : (PERIODS.includes(ctx.query.period) ? ctx.query.period : settings.default_period);
    const wanted = period ? periodDays(period) : Math.max(7, Number(ctx.query.days) || 30);
    const days = Math.min(acc.tier === 'pro' ? 365 : FREE_MAX_DAYS, wanted);
    const accounts = await accountsOf(id, acc);
    const active = accounts.filter((a) => !a.archived_at);
    const balance = active.reduce((a, x) => a + x.balance_base, 0);
    const seriesDays = Math.max(days, 7), span = Math.max(2 * days, 60, seriesDays);
    const since = dayStr(Date.now() - (days - 1) * DAY), from = dayStr(Date.now() - (span - 1) * DAY);
    const w30 = dayStr(Date.now() - 29 * DAY);   // les 30 derniers jours des jauges ; les 30 d'avant vont de -59 à -30
    const flows = await q(`SELECT occurred_on::text AS day, kind, category, sum(amount)::bigint AS total FROM pf_all_tx
        WHERE owner_id = $1 AND voided_at IS NULL AND occurred_on >= $2::date AND occurred_on <= current_date GROUP BY 1, 2, 3`, [id, from]);
    const inRange = flows.filter((f) => f.day >= since);
    const sum = (rows, kinds) => rows.filter((f) => kinds.includes(f.kind)).reduce((a, f) => a + Number(f.total), 0);
    const income = sum(inRange, ['income']), expense = sum(inRange, ['expense']);
    // jauges : 30 derniers jours contre les 30 d'avant
    const nonOp = await nonOperating(id);
    const cur30 = flows.filter((f) => f.day >= w30), prev30 = flows.filter((f) => f.day < w30 && f.day >= dayStr(Date.now() - 59 * DAY));
    const opIncome = (rows) => rows.filter((f) => f.kind === 'income' && !nonOp.has(f.category)).reduce((a, f) => a + Number(f.total), 0);
    const netOf = (rows) => sum(rows, ['income']) - sum(rows, ['expense']);
    const gaugeSet = gauges({ opIncome: opIncome(cur30), prevOpIncome: opIncome(prev30), net: netOf(cur30), prevNet: netOf(prev30), balance, balance30: balance - netOf(cur30),
      incomeTarget: pref?.income_target ? Number(pref.income_target) : null, balanceTarget: pref?.balance_target ? Number(pref.balance_target) : null, thresholds: thresholdsOf(settings.gauges) });
    // courbe du solde : on part du solde actuel et on remonte jour après jour (virements : net nul sur l'ensemble des comptes)
    const net = new Map();
    for (const f of flows) if (f.kind === 'income' || f.kind === 'expense') net.set(f.day, (net.get(f.day) || 0) + (f.kind === 'income' ? 1 : -1) * Number(f.total));
    const later = await q(`SELECT occurred_on::text AS day, sum(CASE WHEN kind = 'income' THEN amount WHEN kind = 'expense' THEN -amount ELSE 0 END)::bigint AS net FROM pf_all_tx
        WHERE owner_id = $1 AND voided_at IS NULL AND occurred_on > current_date GROUP BY 1`, [id]);
    const series = []; let run = balance - later.reduce((a, r) => a + Number(r.net), 0);   // les opérations datées de demain ne comptent pas encore dans la courbe
    for (let i = 0; i < seriesDays; i++) { const d = dayStr(Date.now() - i * DAY); series.unshift({ day: d, balance: run }); run -= net.get(d) || 0; }
    const byCategory = (kinds) => Object.entries(inRange.filter((f) => kinds.includes(f.kind)).reduce((m, f) => { m[f.category] = (m[f.category] || 0) + Number(f.total); return m; }, {}))
      .map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
    const [w] = await q(`SELECT COALESCE(sum(amount) FILTER (WHERE available_at <= now()), 0)::bigint AS available, COALESCE(sum(amount) FILTER (WHERE available_at > now()), 0)::bigint AS pending FROM wallet_entries WHERE user_id = $1`, [id]);
    const recent = await q(`SELECT t.id, t.kind, t.amount_orig::bigint AS amount, t.currency, t.category, t.note, t.occurred_on::text AS occurred_on, COALESCE(a.name, 'Wallindirain') AS account_name, COALESCE(a.color, 'teal') AS color, t.source
        FROM pf_all_tx t LEFT JOIN pf_accounts a ON a.id = t.account_id WHERE t.owner_id = $1 AND t.voided_at IS NULL AND t.occurred_on >= current_date - $2::int
        ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 6`, [id, acc.tier === 'pro' ? 100000 : acc.free_history_days]);
    return {
      enabled: true, ...acc, period, days, clamped: days < wanted, settings, accounts, balance, income, expense, flow: income - expense, prev_income: opIncome(prev30),
      gauges: gaugeSet,
      targets: { income: pref?.income_target ? Number(pref.income_target) : null, balance: pref?.balance_target ? Number(pref.balance_target) : null },
      currencies: (await q('SELECT code, name, decimals, rate::float8 AS rate, updated_at FROM pf_currencies WHERE owner_id = $1 ORDER BY code', [id])).map((c) => ({ ...c, rate: Number(c.rate) })),
      series, income_by_category: byCategory(['income']), expense_by_category: byCategory(['expense']), recent,
      wallindirain: { available: Number(w.available), pending: Number(w.pending) }
    };
  }));

  const writing = (ctx) => limit(`pf-edit:${ctx.user.id}`, 300, 3600_000);

  app.get('/api/pf/accounts', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    return { enabled: true, accounts: await accountsOf(ctx.user.id, await access(ctx.user.id)) };
  }));
  app.post('/api/pf/accounts', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const id = await fn('fn_pf_account_save', ctx.user.id, b.id ? v.uuid(b.id, 'Compte') : null, v.str(b.name, 'Nom', { max: 80 }), v.oneOf(b.kind, KINDS, 'Type'), v.oneOf(b.color || 'blue', COLORS, 'Couleur'),
      v.int(b.opening_balance ?? 0, 'Solde de départ', { min: -1e11, max: 1e11 }), b.currency ? v.str(b.currency, 'Devise', { max: 3 }) : null);
    ctx.status = b.id ? 200 : 201;
    return { id };
  }));
  app.post('/api/pf/accounts/:id/archive', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_account_archive', ctx.user.id, v.uuid(ctx.params.id, 'Compte'), ctx.body.archived !== false);
    return { ok: true };
  }));

  app.get('/api/pf/transactions', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, acc = await access(id);
    const params = [id, acc.tier === 'pro' ? 100000 : acc.free_history_days];
    let where = `t.owner_id = $1 AND t.voided_at IS NULL AND t.occurred_on >= current_date - $2::int`;
    if (ctx.query.account === 'wallindirain') where += ' AND t.account_id IS NULL';
    else if (ctx.query.account) { params.push(v.uuid(ctx.query.account, 'Compte')); where += ` AND t.account_id = $${params.length}`; }
    if (ctx.query.kind && ['income', 'expense', 'transfer'].includes(ctx.query.kind)) where += ctx.query.kind === 'transfer' ? ` AND t.kind IN ('transfer_in','transfer_out')` : ` AND t.kind = '${ctx.query.kind}'`;
    if (ctx.query.q) { params.push(`%${String(ctx.query.q).slice(0, 50).replace(/[\\%_]/g, '\\$&')}%`); where += ` AND (t.note ILIKE $${params.length} OR t.category ILIKE $${params.length})`; }
    if (ctx.query.before) { params.push(ymd(ctx.query.before)); where += ` AND t.occurred_on < $${params.length}::date`; }
    const rows = await q(`SELECT t.id, t.kind, t.amount_orig::bigint AS amount, t.currency, t.category, t.note, t.occurred_on::text AS occurred_on, t.transfer_id, t.account_id, COALESCE(a.name, 'Wallindirain') AS account_name, COALESCE(a.color, 'teal') AS color, t.source
        FROM pf_all_tx t LEFT JOIN pf_accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 100`, params);
    return { enabled: true, transactions: rows, history_limited: acc.tier !== 'pro' ? acc.free_history_days : null };
  }));
  // Saisie hors connexion : l'application renvoie la même opération avec la même clé ; elle n'est enregistrée qu'une fois.
  const once = async (ctx, work) => {
    const key = ctx.body && ctx.body.client_key;
    if (key === undefined || key === null) return work();
    const st = (await q('SELECT fn_pf_once($1, $2) AS r', [ctx.user.id, String(key)]))[0].r;
    if (st.state === 'done') { ctx.status = 200; return { ...st.result, repeated: true }; }
    if (st.state === 'busy') throw new HttpError(409, 'invalid_state', 'Cet envoi est déjà en cours, réessayez dans un instant.');
    try {
      const out = await work();
      await q('SELECT fn_pf_once_done($1, $2, $3::jsonb)', [ctx.user.id, String(key), JSON.stringify(out)]);
      return out;
    } catch (e) { await q('SELECT fn_pf_once_release($1, $2)', [ctx.user.id, String(key)]).catch(() => {}); throw e; }
  };
  app.post('/api/pf/transactions', guard(ALL, (ctx) => once(ctx, async () => {
    writing(ctx); const b = ctx.body;
    const kind = v.oneOf(b.kind, ['income', 'expense'], 'Type');
    const id = await fn('fn_pf_tx_add', ctx.user.id, v.uuid(b.account_id, 'Compte'), kind, v.int(b.amount, 'Montant', { min: 1, max: 1e11 }),
      catKey(b.category), v.optStr(b.note, 'Note', 200), ymd(b.occurred_on));
    ctx.status = 201;
    return { id };
  })));
  app.post('/api/pf/transactions/:id/update', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const [t] = await q('SELECT kind FROM pf_transactions WHERE id = $1 AND owner_id = $2', [v.uuid(ctx.params.id, 'Transaction'), ctx.user.id]);
    if (!t) throw new HttpError(404, 'not_found', 'Transaction introuvable');
    await fn('fn_pf_tx_update', ctx.user.id, ctx.params.id, v.uuid(b.account_id, 'Compte'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }),
      catKey(b.category), v.optStr(b.note, 'Note', 200), ymd(b.occurred_on));
    return { ok: true };
  }));
  app.post('/api/pf/transactions/:id/void', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_tx_void', ctx.user.id, v.uuid(ctx.params.id, 'Transaction'));
    return { ok: true };
  }));
  app.post('/api/pf/transfers', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    ctx.status = 201;
    return { id: await fn('fn_pf_transfer', ctx.user.id, v.uuid(b.from, 'Compte de départ'), v.uuid(b.to, 'Compte d\'arrivée'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }), v.optStr(b.note, 'Note', 200), ymd(b.occurred_on)) };
  }));


  // ----- Profil et catégories (migration 054) : arbre système + catégories de la personne, avec nom/icône/masquage modifiables -----
  /** Arbre des catégories d'une personne : catégories du système (noms et icônes modifiés par elle) + celles qu'elle a ajoutées. */
  async function catTree(id) {
    const sys = await q('SELECT s.key, s.parent_key AS parent, s.kind, s.label AS default_label, COALESCE(o.label, s.label) AS label, COALESCE(o.icon, s.icon) AS icon, s.profile, s.operating, s.position, COALESCE(o.hidden, false) AS hidden FROM pf_cat_system s LEFT JOIN pf_cat_override o ON o.key = s.key AND o.owner_id = $1 ORDER BY s.position', [id]);
    const own = await q('SELECT key, parent_key AS parent, kind, label, icon, archived_at IS NOT NULL AS hidden FROM pf_cat_custom WHERE owner_id = $1 ORDER BY created_at', [id]);
    const rootOf = Object.fromEntries(sys.map((c) => [c.key, c]));
    const operatingOf = (k) => { let c = rootOf[k]; while (c && c.parent) c = rootOf[c.parent]; return c ? c.operating : true; };
    return [
      ...sys.map((c) => ({ key: c.key, parent: c.parent, kind: c.kind, label: c.label, default_label: c.default_label, icon: c.icon, profile: c.profile, operating: c.operating, hidden: c.hidden, system: true })),
      ...own.map((c) => ({ key: c.key, parent: c.parent, kind: c.kind, label: c.label, default_label: null, icon: c.icon, profile: 'both', operating: operatingOf(c.parent), hidden: c.hidden, system: false })),
    ];
  }
  app.get('/api/pf/categories', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id;
    const [pref] = await q('SELECT profile FROM pf_prefs WHERE owner_id = $1', [id]);
    return { enabled: true, profile: pref?.profile ?? null, items: await catTree(id) };
  }));
  app.post('/api/pf/profile', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_profile_set', ctx.user.id, v.oneOf(ctx.body.profile, ['personal', 'business', 'both'], 'Profil'));
    return { ok: true };
  }));
  app.post('/api/pf/categories', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const key = await fn('fn_pf_cat_add', ctx.user.id, b.parent ? catKey(b.parent) : null, b.parent ? null : v.oneOf(b.kind, ['income', 'expense'], 'Type'), v.str(b.label, 'Nom', { max: 40 }), v.optStr(b.icon, 'Icône', 12));
    ctx.status = 201;
    return { key };
  }));
  app.post('/api/pf/categories/:key', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    await fn('fn_pf_cat_edit', ctx.user.id, catKey(ctx.params.key), v.optStr(b.label, 'Nom', 40), v.optStr(b.icon, 'Icône', 12), b.hidden === true);
    return { ok: true };
  }));

  app.post('/api/pf/prefs', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_prefs_set', ctx.user.id, optInt(ctx.body.income_target, 'Objectif de revenus'), optInt(ctx.body.balance_target, 'Objectif de solde'));
    return { ok: true };
  }));
  // ----- Plan financier (Pro) : budgets, objectif du mois, récurrents, prévision à 30 jours -----
  app.get('/api/pf/plan', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, acc = await access(id);
    const month = dayStr(Date.now()).slice(0, 8) + '01';
    const spent = await q(`SELECT category, sum(amount)::bigint AS total FROM pf_all_tx WHERE owner_id = $1 AND kind = 'expense' AND voided_at IS NULL AND occurred_on >= $2::date AND occurred_on <= current_date GROUP BY 1`, [id, month]);
    const spentBy = Object.fromEntries(spent.map((r) => [r.category, Number(r.total)]));
    const budgets = (await q('SELECT category, amount::bigint AS amount FROM pf_budgets WHERE owner_id = $1 ORDER BY category', [id])).map((b) => ({ category: b.category, amount: Number(b.amount), spent: spentBy[b.category] || 0 }));
    const [m] = await q(`SELECT COALESCE(sum(CASE WHEN kind = 'income' THEN amount WHEN kind = 'expense' THEN -amount ELSE 0 END), 0)::bigint AS net FROM pf_all_tx WHERE owner_id = $1 AND voided_at IS NULL AND occurred_on >= $2::date AND occurred_on <= current_date`, [id, month]);
    const [g] = await q('SELECT target::bigint AS target FROM pf_goals WHERE owner_id = $1 AND month = $2::date', [id, month]);
    const recurring = (await q(`SELECT id, label, kind, category, amount::bigint AS amount, frequency, anchor_on::text AS anchor_on FROM pf_recurring WHERE owner_id = $1 AND stopped_at IS NULL ORDER BY kind, label`, [id])).map((r) => ({ ...r, amount: Number(r.amount) }));
    const accounts = await accountsOf(id, acc);
    const balance = accounts.filter((a) => !a.archived_at).reduce((t, a) => t + a.balance_base, 0);
    const from = dayStr(Date.now() + DAY), to = dayStr(Date.now() + 30 * DAY);
    const upcoming = recurring.flatMap((r) => occurrences(r, from, to).map((day) => ({ day, label: r.label, kind: r.kind, category: r.category, amount: r.amount }))).sort((a, b) => a.day.localeCompare(b.day));
    const inc = upcoming.filter((u) => u.kind === 'income').reduce((t, u) => t + u.amount, 0), exp = upcoming.filter((u) => u.kind === 'expense').reduce((t, u) => t + u.amount, 0);
    return { enabled: true, ...acc, month, budgets, goal: g ? { target: Number(g.target), saved: Number(m.net) } : null, month_net: Number(m.net), recurring,
      forecast: { balance, income: inc, expense: exp, projected: balance + inc - exp, upcoming: upcoming.slice(0, 12) } };
  }));
  app.post('/api/pf/budgets', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    await fn('fn_pf_budget_set', ctx.user.id, catKey(b.category), optInt(b.amount, 'Budget'));
    return { ok: true };
  }));
  app.post('/api/pf/goal', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_goal_set', ctx.user.id, optInt(ctx.body.target, 'Objectif'));
    return { ok: true };
  }));
  app.post('/api/pf/recurring', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const kind = v.oneOf(b.kind, ['income', 'expense'], 'Type');
    const id = await fn('fn_pf_recurring_save', ctx.user.id, b.id ? v.uuid(b.id, 'Récurrent') : null, v.str(b.label, 'Nom', { max: 40 }), kind, catKey(b.category),
      v.int(b.amount, 'Montant', { min: 1, max: 1e11 }), v.oneOf(b.frequency, ['daily', 'weekly', 'monthly'], 'Fréquence'), ymd(b.anchor_on));
    ctx.status = b.id ? 200 : 201;
    return { id };
  }));
  app.post('/api/pf/recurring/:id/stop', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_recurring_stop', ctx.user.id, v.uuid(ctx.params.id, 'Récurrent'));
    return { ok: true };
  }));

  // ----- Contacts : carnet unique, notes, étiquettes (Pro), import (Pro) -----
  const STAGES = ['prospect', 'client', 'other'], LABEL_COLORS = ['green', 'red', 'gold', 'blue', 'grey'];
  app.get('/api/pf/contacts', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, acc = await access(id);
    const params = [id]; let where = 'c.owner_id = $1 AND c.archived_at IS NULL';
    if (ctx.query.archived === '1') where = 'c.owner_id = $1 AND c.archived_at IS NOT NULL';
    if (ctx.query.stage && STAGES.includes(ctx.query.stage)) { params.push(ctx.query.stage); where += ` AND c.stage = $${params.length}`; }
    if (ctx.query.label) { params.push(v.uuid(ctx.query.label, 'Étiquette')); where += ` AND EXISTS (SELECT 1 FROM pf_contact_label_links k WHERE k.contact_id = c.id AND k.label_id = $${params.length})`; }
    if (ctx.query.q) { const t = String(ctx.query.q).slice(0, 50).replace(/[\\%_]/g, '\\$&'); params.push(`%${t}%`); where += ` AND (c.name ILIKE $${params.length} OR c.phone LIKE $${params.length} OR c.city ILIKE $${params.length})`; }
    const contacts = await q(`SELECT c.id, c.name, c.phone, c.city, c.stage, c.origin, c.created_at,
        COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name) FROM pf_contact_label_links k JOIN pf_contact_labels l ON l.id = k.label_id AND l.deleted_at IS NULL WHERE k.contact_id = c.id), '[]'::json) AS labels,
        (SELECT count(*)::int FROM pf_contact_notes n WHERE n.contact_id = c.id AND n.voided_at IS NULL) AS notes
      FROM pf_contacts c WHERE ${where} ORDER BY lower(c.name) LIMIT 500`, params);
    const labels = await q('SELECT id, name, color FROM pf_contact_labels WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name', [id]);
    const [n] = await q('SELECT count(*)::int AS n FROM pf_contacts WHERE owner_id = $1 AND archived_at IS NULL', [id]);
    return { enabled: true, ...acc, contacts, labels, total: n.n, free_contacts: await setting('pf_free_contacts'), seller: ctx.user.role === 'seller' };
  }));
  app.get('/api/pf/contacts/:id', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, cid = v.uuid(ctx.params.id, 'Contact');
    const [c] = await q('SELECT id, name, phone, city, stage, origin, created_at, archived_at FROM pf_contacts WHERE id = $1 AND owner_id = $2', [cid, id]);
    if (!c) throw new HttpError(404, 'not_found', 'Contact introuvable');
    const notes = await q('SELECT id, body, created_at FROM pf_contact_notes WHERE contact_id = $1 AND voided_at IS NULL ORDER BY created_at DESC LIMIT 100', [cid]);
    const labels = await q(`SELECT l.id, l.name, l.color FROM pf_contact_label_links k JOIN pf_contact_labels l ON l.id = k.label_id AND l.deleted_at IS NULL WHERE k.contact_id = $1 ORDER BY l.name`, [cid]);
    // historique de commandes : uniquement pour un vendeur, uniquement ses propres commandes avec ce numéro
    let orders = null;
    if (ctx.user.role === 'seller') {
      orders = await q(`SELECT o.id, o.ref, o.status, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total::bigint AS sale_total, o.created_at
        FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.seller_id = $1 AND o.customer_phone = $2 ORDER BY o.created_at DESC LIMIT 20`, [id, c.phone]);
    }
    return { enabled: true, contact: c, notes, labels, orders };
  }));
  app.post('/api/pf/contacts', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const cid = await fn('fn_pf_contact_save', ctx.user.id, b.id ? v.uuid(b.id, 'Contact') : null, v.str(b.name, 'Nom', { max: 60 }), v.str(b.phone, 'Téléphone', { max: 30 }), v.optStr(b.city, 'Ville', 40), v.oneOf(b.stage || 'prospect', STAGES, 'Statut'));
    ctx.status = b.id ? 200 : 201;
    return { id: cid };
  }));
  app.post('/api/pf/contacts/:id/archive', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_contact_archive', ctx.user.id, v.uuid(ctx.params.id, 'Contact'), ctx.body.archived !== false);
    return { ok: true };
  }));
  app.post('/api/pf/contacts/:id/notes', guard(ALL, async (ctx) => {
    writing(ctx);
    ctx.status = 201;
    return { id: await fn('fn_pf_contact_note_add', ctx.user.id, v.uuid(ctx.params.id, 'Contact'), v.str(ctx.body.body, 'Note', { max: 500 })) };
  }));
  app.post('/api/pf/contact-notes/:id/void', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_contact_note_void', ctx.user.id, v.uuid(ctx.params.id, 'Note'));
    return { ok: true };
  }));
  app.post('/api/pf/contacts/:id/labels', guard(ALL, async (ctx) => {
    writing(ctx);
    const ids = Array.isArray(ctx.body.labels) ? ctx.body.labels.slice(0, 10).map((x) => v.uuid(x, 'Étiquette')) : [];
    await fn('fn_pf_contact_labels_set', ctx.user.id, v.uuid(ctx.params.id, 'Contact'), ids);
    return { ok: true };
  }));
  app.post('/api/pf/labels', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const lid = await fn('fn_pf_label_save', ctx.user.id, b.id ? v.uuid(b.id, 'Étiquette') : null, v.str(b.name, 'Nom', { max: 30 }), v.oneOf(b.color || 'blue', LABEL_COLORS, 'Couleur'));
    ctx.status = b.id ? 200 : 201;
    return { id: lid };
  }));
  app.post('/api/pf/labels/:id/delete', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_label_delete', ctx.user.id, v.uuid(ctx.params.id, 'Étiquette'));
    return { ok: true };
  }));
  app.post('/api/pf/contacts-import', guard(ALL, async (ctx) => {
    limit(`pf-import:${ctx.user.id}`, 20, 3600_000);
    const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : null;
    if (!rows || rows.length > 500) throw new HttpError(400, 'invalid_input', '500 lignes au plus par import');
    const clean = rows.map((r) => ({ name: String(r?.name ?? '').slice(0, 80), phone: String(r?.phone ?? '').slice(0, 30), city: String(r?.city ?? '').slice(0, 60) }));
    return fn('fn_pf_contact_import', ctx.user.id, JSON.stringify(clean));
  }));
  app.post('/api/pf/contacts-from-orders', guard(['seller'], async (ctx) => {
    limit(`pf-fromord:${ctx.user.id}`, 20, 3600_000);
    return { added: await fn('fn_pf_contacts_from_orders', ctx.user.id) };
  }));

  // Relier / délier le compte Wallindirain (Pro) : l'activité du portefeuille apparaît seule dans Mes finances


  // ----- Espaces de groupe (migration 057) : comptes et transactions partagés selon le rôle, séparés des finances personnelles -----
  const SPACE_ROLES = ['accountant', 'contributor', 'viewer'];
  const spaceFlag = async () => (await setting('pf_spaces')) >= 1;
  /** Rôle de la personne dans l'espace (membre actif) ; sinon « introuvable » : un non-membre ne sait même pas que l'espace existe. */
  async function spaceRole(userId, spaceId) {
    const [m] = await q(`SELECT m.role, s.name, s.owner_id, s.archived_at, o.full_name AS owner_name FROM pf_space_members m JOIN pf_spaces s ON s.id = m.space_id JOIN users o ON o.id = s.owner_id
        WHERE m.space_id = $1 AND m.user_id = $2 AND m.status = 'active'`, [spaceId, userId]);
    if (!m) throw new HttpError(404, 'not_found', 'Espace introuvable');
    return m;
  }

  app.get('/api/pf/spaces', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id;
    const on = await spaceFlag();
    if (!on) return { enabled: true, spaces_enabled: false, spaces: [], invitations: [] };
    const acc = await access(id);
    const spaces = await q(`SELECT s.id, s.name, m.role, s.archived_at, o.full_name AS owner_name,
        (SELECT count(*) FROM pf_space_members x WHERE x.space_id = s.id AND x.status = 'active')::int AS members,
        COALESCE((SELECT sum(a.opening_balance) FROM pf_space_accounts a WHERE a.space_id = s.id AND a.archived_at IS NULL), 0)::bigint
          + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END) FROM pf_space_tx t JOIN pf_space_accounts a ON a.id = t.account_id WHERE t.space_id = s.id AND t.voided_at IS NULL AND a.archived_at IS NULL), 0)::bigint AS balance
      FROM pf_space_members m JOIN pf_spaces s ON s.id = m.space_id JOIN users o ON o.id = s.owner_id
      WHERE m.user_id = $1 AND m.status = 'active' ORDER BY s.archived_at NULLS FIRST, s.created_at`, [id]);
    const invitations = await q(`SELECT s.id AS space_id, s.name, m.role, i.full_name AS invited_by_name FROM pf_space_members m JOIN pf_spaces s ON s.id = m.space_id LEFT JOIN users i ON i.id = m.invited_by
      WHERE m.user_id = $1 AND m.status = 'invited' AND s.archived_at IS NULL ORDER BY m.created_at DESC`, [id]);
    return { enabled: true, spaces_enabled: true, can_create: acc.tier === 'pro', spaces, invitations };
  }));

  app.get('/api/pf/spaces/:id', guard(ALL, async (ctx) => {
    if (!(await featureOn()) || !(await spaceFlag())) throw new HttpError(404, 'not_found', 'Espace introuvable');
    const sid = v.uuid(ctx.params.id, 'Espace'), uid = ctx.user.id;
    const me = await spaceRole(uid, sid);
    const ownerAcc = await access(me.owner_id);
    const period = PERIODS.includes(ctx.query.period) ? ctx.query.period : 'd30';
    const days = periodDays(period);
    const since = dayStr(Date.now() - (days - 1) * DAY);
    const accounts = await q(`SELECT a.id, a.name, a.kind, a.color, a.opening_balance::bigint AS opening_balance, a.archived_at,
        (a.opening_balance + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END) FROM pf_space_tx t WHERE t.account_id = a.id AND t.voided_at IS NULL), 0))::bigint AS balance
      FROM pf_space_accounts a WHERE a.space_id = $1 ORDER BY a.archived_at NULLS FIRST, a.created_at`, [sid]);
    const flows = await q(`SELECT kind, category, sum(amount)::bigint AS total FROM pf_space_tx WHERE space_id = $1 AND voided_at IS NULL AND kind IN ('income','expense') AND occurred_on >= $2::date AND occurred_on <= current_date GROUP BY 1, 2`, [sid, since]);
    const sumOf = (k) => flows.filter((f) => f.kind === k).reduce((a, f) => a + Number(f.total), 0);
    const by = (k) => flows.filter((f) => f.kind === k).map((f) => ({ category: f.category, total: Number(f.total) })).sort((a, b) => b.total - a.total);
    const recent = await q(`SELECT t.id, t.kind, t.amount::bigint AS amount, t.category, t.note, t.occurred_on::text AS occurred_on, t.transfer_id, t.account_id, a.name AS account_name, t.author_id, u.full_name AS author_name, t.created_at
      FROM pf_space_tx t JOIN pf_space_accounts a ON a.id = t.account_id JOIN users u ON u.id = t.author_id WHERE t.space_id = $1 AND t.voided_at IS NULL ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 80`, [sid]);
    const members = await q(`SELECT m.user_id, u.full_name AS name, m.role, m.status, ${me.role === 'owner' ? 'u.phone' : 'NULL::text'} AS phone FROM pf_space_members m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1 AND m.status IN ('active','invited') ORDER BY (m.role = 'owner') DESC, m.status, u.full_name`, [sid]);
    const log = ['owner', 'accountant'].includes(me.role) ? await q(`SELECT l.id, l.action, l.detail, l.created_at, u.full_name AS actor_name FROM pf_space_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.space_id = $1 ORDER BY l.id DESC LIMIT 60`, [sid]) : [];
    return {
      enabled: true, space: { id: sid, name: me.name, archived: !!me.archived_at, owner_name: me.owner_name }, role: me.role,
      writable: !me.archived_at && ownerAcc.tier === 'pro', can_write: !me.archived_at && ownerAcc.tier === 'pro' && ['owner', 'accountant', 'contributor'].includes(me.role),
      me: uid, period, days, accounts, balance: accounts.filter((a) => !a.archived_at).reduce((t, a) => t + Number(a.balance), 0),
      income: sumOf('income'), expense: sumOf('expense'), income_by_category: by('income'), expense_by_category: by('expense'),
      categories: await catTree(me.owner_id), recent, members, log
    };
  }));

  app.post('/api/pf/spaces', guard(ALL, async (ctx) => {
    writing(ctx); ctx.status = 201;
    return { id: await fn('fn_pf_space_create', ctx.user.id, v.str(ctx.body.name, 'Nom', { max: 60 })) };
  }));
  const spaceAction = (path, name, args) => app.post(path, guard(ALL, async (ctx) => {
    writing(ctx);
    const out = await fn(name, ctx.user.id, v.uuid(ctx.params.id, 'Espace'), ...args(ctx.body, ctx));
    return out && typeof out === 'object' ? out : { ok: true };
  }));
  const day = (b) => ymd(b.occurred_on);
  spaceAction('/api/pf/spaces/:id/rename', 'fn_pf_space_rename', (b) => [v.str(b.name, 'Nom', { max: 60 })]);
  spaceAction('/api/pf/spaces/:id/archive', 'fn_pf_space_archive', (b) => [b.archived !== false]);
  spaceAction('/api/pf/spaces/:id/invite', 'fn_pf_space_invite', (b) => [v.str(b.phone, 'Téléphone', { max: 20 }), v.oneOf(b.role, SPACE_ROLES, 'Rôle')]);
  spaceAction('/api/pf/spaces/:id/respond', 'fn_pf_space_respond', (b) => [b.accept === true]);
  spaceAction('/api/pf/spaces/:id/leave', 'fn_pf_space_leave', () => []);
  app.post('/api/pf/spaces/:id/members/:uid/role', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_space_set_role', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(ctx.params.uid, 'Membre'), v.oneOf(ctx.body.role, SPACE_ROLES, 'Rôle')); return { ok: true }; }));
  app.post('/api/pf/spaces/:id/members/:uid/remove', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_space_remove', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(ctx.params.uid, 'Membre')); return { ok: true }; }));
  app.post('/api/pf/spaces/:id/accounts', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body; ctx.status = b.id ? 200 : 201;
    return { id: await fn('fn_pf_space_account_save', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), b.id ? v.uuid(b.id, 'Compte') : null, v.str(b.name, 'Nom', { max: 40 }), v.oneOf(b.kind, ['cash', 'mobile_money', 'bank', 'savings', 'other'], 'Type'), v.oneOf(b.color, ['blue', 'green', 'orange', 'red', 'purple', 'brown', 'teal', 'grey'], 'Couleur'), v.int(b.opening_balance ?? 0, 'Solde', { min: -1e11, max: 1e11 })) };
  }));
  app.post('/api/pf/spaces/:id/accounts/:aid/archive', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_space_account_archive', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(ctx.params.aid, 'Compte'), ctx.body.archived !== false); return { ok: true }; }));
  app.post('/api/pf/spaces/:id/transactions', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body; ctx.status = 201;
    return { id: await fn('fn_pf_space_tx_add', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(b.account_id, 'Compte'), v.oneOf(b.kind, ['income', 'expense'], 'Type'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }), catKey(b.category), v.optStr(b.note, 'Note', 200), day(b)) };
  }));
  app.post('/api/pf/spaces/:id/transactions/:tid', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    await fn('fn_pf_space_tx_update', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(ctx.params.tid, 'Transaction'), v.uuid(b.account_id, 'Compte'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }), catKey(b.category), v.optStr(b.note, 'Note', 200), day(b));
    return { ok: true };
  }));
  app.post('/api/pf/spaces/:id/transactions/:tid/void', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_space_tx_void', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(ctx.params.tid, 'Transaction')); return { ok: true }; }));
  app.post('/api/pf/spaces/:id/transfers', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body; ctx.status = 201;
    return { id: await fn('fn_pf_space_transfer', ctx.user.id, v.uuid(ctx.params.id, 'Espace'), v.uuid(b.from, 'Compte'), v.uuid(b.to, 'Compte'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }), v.optStr(b.note, 'Note', 200), day(b)) };
  }));

  // ----- Devises (migration 056) : base GNF, autres devises avec un taux saisi à la main -----
  app.get('/api/pf/currencies', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id;
    const list = await q(`SELECT c.code, c.name, c.decimals, c.rate::float8 AS rate, c.updated_at, (SELECT count(*) FROM pf_accounts a WHERE a.owner_id = c.owner_id AND a.currency = c.code)::int AS accounts FROM pf_currencies c WHERE c.owner_id = $1 ORDER BY c.code`, [id]);
    const [pref] = await q('SELECT rates_auto FROM pf_prefs WHERE owner_id = $1', [id]);
    const acc = await access(id);
    return { enabled: true, base: { code: 'GNF', name: 'Franc guinéen', decimals: 0 }, currencies: list.map((c) => ({ ...c, rate: Number(c.rate) })), rates_auto: !!pref?.rates_auto, tier: acc.tier, free_currencies: acc.tier === 'pro' ? null : await setting('pf_free_currencies') };
  }));
  app.post('/api/pf/currencies', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const rate = Number(String(b.rate).replace(',', '.'));
    if (!Number.isFinite(rate)) throw new HttpError(400, 'invalid_input', 'Taux invalide');
    await fn('fn_pf_currency_save', ctx.user.id, v.str(b.code, 'Code', { max: 3 }), v.str(b.name, 'Nom', { max: 40 }), v.int(b.decimals ?? 2, 'Décimales', { min: 0, max: 3 }), String(rate));
    return { ok: true };
  }));
  app.post('/api/pf/currencies/:code/remove', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_currency_remove', ctx.user.id, v.str(ctx.params.code, 'Code', { max: 3 }));
    return { ok: true };
  }));
  // Données personnelles : la personne efface elle-même ses données Mes finances (rien d'autre).
  app.post('/api/pf/erase', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_erase', ctx.user.id, v.str(ctx.body.confirm, 'Confirmation', { max: 20 }));
    return { ok: true };
  }));
  // ---------- Pro : export CSV, règles automatiques, import ----------
  const needPro = async (id) => { if ((await access(id)).tier !== 'pro') throw new HttpError(403, 'pro_required', 'Cette fonction fait partie de la formule Pro'); };
  app.get('/api/pf/export', guard(ALL, async (ctx) => {
    if (!(await featureOn())) throw new HttpError(404, 'feature_off', 'Indisponible');
    const id = ctx.user.id; await needPro(id);
    const params = [id]; let where = 't.owner_id = $1 AND t.voided_at IS NULL';
    if (ctx.query.from) { params.push(ymd(ctx.query.from)); where += ` AND t.occurred_on >= $${params.length}::date`; }
    if (ctx.query.to) { params.push(ymd(ctx.query.to)); where += ` AND t.occurred_on <= $${params.length}::date`; }
    if (ctx.query.account === 'wallindirain') where += ' AND t.account_id IS NULL';
    else if (ctx.query.account) { params.push(v.uuid(ctx.query.account, 'Compte')); where += ` AND t.account_id = $${params.length}`; }
    const rows = await q(`SELECT t.occurred_on::text AS day, t.kind, COALESCE(a.name, 'Wallindirain') AS account, t.category, t.amount_orig::bigint AS amount, t.currency, COALESCE(c.decimals, 0)::int AS decimals, t.note
        FROM pf_all_tx t LEFT JOIN pf_accounts a ON a.id = t.account_id LEFT JOIN pf_currencies c ON c.owner_id = t.owner_id AND c.code = t.currency
       WHERE ${where} ORDER BY t.occurred_on, t.created_at LIMIT 50000`, params);
    const label = Object.fromEntries((await catTree(id)).map((c) => [c.key, c.label]));
    const KIND_FR = { income: 'Revenu', expense: 'Dépense', transfer_in: 'Virement reçu', transfer_out: 'Virement émis' };
    const cell = (x, num = false) => { let t = String(x ?? ''); if (!num && /^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['Date', 'Type', 'Compte', 'Catégorie', 'Montant', 'Devise', 'Note'].join(';')];
    for (const r of rows) {
      const d = Number(r.decimals), n = Number(r.amount) * (r.kind === 'expense' || r.kind === 'transfer_out' ? -1 : 1);
      lines.push([r.day, KIND_FR[r.kind] || r.kind, r.account, label[r.category] || r.category, (n / 10 ** d).toFixed(d).replace('.', ','), r.currency || 'GNF', r.note].map((x, i) => cell(x, i === 4)).join(';'));
    }
    ctx.headers['Content-Type'] = 'text/csv; charset=utf-8';
    ctx.headers['Content-Disposition'] = `attachment; filename="mes-finances-${dayStr(new Date())}.csv"`;
    return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
  }));
  app.get('/api/pf/rules', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    return { enabled: true, rules: await q('SELECT id, contains, kind, category FROM pf_rules WHERE owner_id = $1 ORDER BY created_at, id', [ctx.user.id]) };
  }));
  app.post('/api/pf/rules', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const id = await fn('fn_pf_rule_save', ctx.user.id, v.str(b.contains, 'Mot à repérer', { max: 40 }), b.kind ? v.oneOf(b.kind, ['income', 'expense'], 'Type') : null, catKey(b.category));
    ctx.status = 201; return { id };
  }));
  app.post('/api/pf/rules/:id/remove', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_rule_remove', ctx.user.id, v.uuid(ctx.params.id, 'Règle')); }));
  app.post('/api/pf/import', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    if (!Array.isArray(b.rows)) throw new HttpError(400, 'invalid_input', 'Liste invalide');
    const rows = b.rows.slice(0, 501).map((r) => ({ date: String(r?.date ?? '').slice(0, 10), kind: r?.kind, amount: r?.amount, category: r?.category || null, note: r?.note == null ? null : String(r.note).slice(0, 200) }));
    const [out] = await q('SELECT fn_pf_tx_import($1, $2, $3::jsonb) AS r', [ctx.user.id, v.uuid(b.account_id, 'Compte'), JSON.stringify(rows)]);
    return out.r;
  }));
  // ---------- Paie des employés ----------
  const monthOf = (x) => { const m = /^(\d{4})-(\d{2})$/.exec(String(x ?? '')); const d = m ? `${m[1]}-${m[2]}-01` : `${dayStr(new Date()).slice(0, 7)}-01`; if (Number.isNaN(Date.parse(d))) throw new HttpError(400, 'invalid_input', 'Mois invalide'); return d; };
  app.get('/api/pf/payroll', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, month = monthOf(ctx.query.month);
    const employees = await q(`SELECT e.id, e.name, e.job, e.monthly_amount::bigint AS monthly_amount, e.user_id, e.archived_at, u.role AS staff_role,
        p.amount::bigint AS paid_amount, p.paid_on::text AS paid_on
      FROM pf_payroll e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN pf_payroll_pay p ON p.payroll_id = e.id AND p.month = $2::date
      WHERE e.owner_id = $1 AND (e.archived_at IS NULL OR p.id IS NOT NULL) ORDER BY e.archived_at NULLS FIRST, e.name`, [id, month]);
    const num = (n) => Number(n);
    const list = employees.map((e) => ({ ...e, monthly_amount: num(e.monthly_amount), paid_amount: e.paid_amount == null ? null : num(e.paid_amount) }));
    const active = list.filter((e) => !e.archived_at);
    return { enabled: true, tier: (await access(id)).tier, month: month.slice(0, 7), employees: list,
      due: active.reduce((n, e) => n + e.monthly_amount, 0), paid: list.reduce((n, e) => n + (e.paid_amount || 0), 0),
      unpaid: active.filter((e) => e.paid_amount == null).reduce((n, e) => n + e.monthly_amount, 0) };
  }));
  app.get('/api/pf/payroll/staff', guard(['admin'], async () => ({ staff: await q(`SELECT id, full_name, role FROM users WHERE role IN ('agent','call_chief','courier','warehouse') AND deleted_at IS NULL AND status = 'active' ORDER BY full_name LIMIT 300`) })));
  app.post('/api/pf/payroll', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const id = await fn('fn_pf_payroll_save', ctx.user.id, b.id ? v.uuid(b.id, 'Employé') : null, v.str(b.name, 'Nom', { min: 2, max: 80 }), v.optStr(b.job, 'Poste', 60), v.int(b.monthly_amount, 'Salaire', { min: 1, max: 100_000_000_000 }), b.user_id ? v.uuid(b.user_id, 'Membre') : null);
    ctx.status = b.id ? 200 : 201; return { id };
  }));
  app.post('/api/pf/payroll/:id/archive', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_payroll_archive', ctx.user.id, v.uuid(ctx.params.id, 'Employé'), ctx.body.archived !== false); }));
  app.post('/api/pf/payroll/:id/pay', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const [r] = await q('SELECT fn_pf_payroll_pay($1, $2, $3::date, $4, $5, $6::date) AS id', [ctx.user.id, v.uuid(ctx.params.id, 'Employé'), monthOf(b.month), v.uuid(b.account_id, 'Compte'), b.amount == null || b.amount === '' ? null : v.int(b.amount, 'Montant', { min: 1, max: 100_000_000_000 }), ymd(b.paid_on)]);
    ctx.status = 201; return { id: r.id };
  }));
  app.post('/api/pf/payroll/:id/unpay', guard(ALL, async (ctx) => { writing(ctx); await q('SELECT fn_pf_payroll_unpay($1, $2, $3::date)', [ctx.user.id, v.uuid(ctx.params.id, 'Employé'), monthOf(ctx.body.month)]); }));
  // ---------- Boutique : produits et stock, vente rapide, clôture de caisse ----------
  const N = (x) => (x == null ? null : Number(x));
  app.get('/api/pf/shop', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, day = ctx.query.date ? ymd(ctx.query.date) : dayStr(new Date());
    const items = (await q('SELECT id, name, price::bigint, cost::bigint, stock, low_stock, archived_at FROM pf_items WHERE owner_id = $1 ORDER BY archived_at NULLS FIRST, lower(name)', [id]))
      .map((i) => ({ ...i, price: N(i.price), cost: N(i.cost) }));
    const [t] = await q('SELECT count(*)::int AS n, COALESCE(sum(total), 0)::bigint AS total, COALESCE(sum(cost_total), 0)::bigint AS cost FROM pf_sales WHERE owner_id = $1 AND occurred_on = $2::date AND voided_at IS NULL', [id, day]);
    const sales = await q(`SELECT s.id, s.total::bigint AS total, s.cost_total::bigint AS cost_total, s.created_at, a.name AS account_name,
        (SELECT jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'price', l.unit_price) ORDER BY l.name) FROM pf_sale_lines l WHERE l.sale_id = s.id) AS lines
      FROM pf_sales s JOIN pf_accounts a ON a.id = s.account_id WHERE s.owner_id = $1 AND s.occurred_on = $2::date AND s.voided_at IS NULL ORDER BY s.created_at DESC LIMIT 100`, [id, day]);
    return { enabled: true, tier: (await access(id)).tier, day, items,
      low_stock: items.filter((i) => !i.archived_at && i.stock != null && i.stock <= i.low_stock).length,
      today: { count: t.n, total: N(t.total), cost: N(t.cost), margin: N(t.total) - N(t.cost) },
      sales: sales.map((x) => ({ ...x, total: N(x.total), cost_total: N(x.cost_total) })) };
  }));
  app.post('/api/pf/shop/items', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const stock = b.stock === '' || b.stock == null ? null : v.int(b.stock, 'Stock', { min: 0, max: 100_000_000 });
    const itemId = await fn('fn_pf_item_save', ctx.user.id, b.id ? v.uuid(b.id, 'Produit') : null, v.str(b.name, 'Nom', { min: 2, max: 80 }), v.int(b.price, 'Prix de vente', { min: 1, max: 100_000_000_000 }),
      v.int(b.cost ?? 0, 'Prix d\'achat', { min: 0, max: 100_000_000_000 }), stock, v.int(b.low_stock ?? 0, 'Seuil d\'alerte', { min: 0, max: 100_000_000 }));
    ctx.status = b.id ? 200 : 201; return { id: itemId };
  }));
  app.post('/api/pf/shop/items/:id/archive', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_item_archive', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), ctx.body.archived !== false); }));
  app.post('/api/pf/shop/items/:id/restock', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    await q('SELECT fn_pf_item_restock($1, $2, $3, $4, $5, $6::date)', [ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.int(b.qty, 'Quantité', { min: 1, max: 1_000_000 }),
      b.unit_cost == null || b.unit_cost === '' ? null : v.int(b.unit_cost, 'Prix d\'achat', { min: 0, max: 100_000_000_000 }), b.account_id ? v.uuid(b.account_id, 'Compte') : null, ymd(b.occurred_on || dayStr(new Date()))]);
  }));
  app.post('/api/pf/shop/sales', guard(ALL, (ctx) => once(ctx, async () => {
    writing(ctx); const b = ctx.body;
    if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 100) throw new HttpError(400, 'invalid_input', 'Aucun produit dans la vente');
    const lines = b.lines.map((l) => ({ item_id: v.uuid(l?.item_id, 'Produit'), qty: v.int(l?.qty, 'Quantité', { min: 1, max: 100_000 }) }));
    const [r] = await q('SELECT fn_pf_sale_add($1, $2, $3::date, $4::jsonb, $5) AS r', [ctx.user.id, v.uuid(b.account_id, 'Compte'), ymd(b.occurred_on || dayStr(new Date())), JSON.stringify(lines), v.optStr(b.note, 'Note', 200)]);
    ctx.status = 201; return r.r;
  })));
  app.post('/api/pf/shop/sales/:id/void', guard(ALL, async (ctx) => { writing(ctx); await fn('fn_pf_sale_void', ctx.user.id, v.uuid(ctx.params.id, 'Vente')); }));
  app.get('/api/pf/shop/margins', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const days = Math.min(365, Math.max(1, Number(ctx.query.days) || 30));
    const rows = await q(`SELECT l.name, sum(l.qty)::int AS qty, sum(l.qty * l.unit_price)::bigint AS revenue, sum(l.qty * (l.unit_price - l.unit_cost))::bigint AS margin
      FROM pf_sale_lines l JOIN pf_sales s ON s.id = l.sale_id WHERE s.owner_id = $1 AND s.voided_at IS NULL AND s.occurred_on > current_date - $2::int
      GROUP BY l.name ORDER BY margin DESC LIMIT 50`, [ctx.user.id, days]);
    return { enabled: true, days, products: rows.map((r) => ({ ...r, revenue: N(r.revenue), margin: N(r.margin) })) };
  }));
  app.get('/api/pf/shop/closes', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const rows = await q(`SELECT c.id, c.day::text AS day, c.expected::bigint AS expected, c.counted::bigint AS counted, c.note, a.name AS account_name
      FROM pf_cash_close c JOIN pf_accounts a ON a.id = c.account_id WHERE c.owner_id = $1 ORDER BY c.day DESC, c.created_at DESC LIMIT 30`, [ctx.user.id]);
    return { enabled: true, closes: rows.map((r) => ({ ...r, expected: N(r.expected), counted: N(r.counted), diff: N(r.counted) - N(r.expected) })) };
  }));
  app.post('/api/pf/shop/close', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const [r] = await q('SELECT fn_pf_cash_close($1, $2, $3::date, $4, $5) AS r', [ctx.user.id, v.uuid(b.account_id, 'Compte'), ymd(b.day || dayStr(new Date())), v.int(b.counted, 'Montant compté', { min: 0, max: 100_000_000_000 }), v.optStr(b.note, 'Note', 200)]);
    return r.r;
  }));
  app.post('/api/pf/rates-auto', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_rates_auto_set', ctx.user.id, ctx.body.on === true);
    return { ok: true };
  }));

  app.post('/api/pf/wallet-link', guard(ALL, async (ctx) => {
    writing(ctx);
    const acct = ctx.body.account_id ? v.uuid(ctx.body.account_id, 'Compte') : null;
    if (acct) { const [a] = await q('SELECT currency FROM pf_accounts WHERE id = $1 AND owner_id = $2', [acct, ctx.user.id]); if (a && a.currency !== 'GNF') throw new HttpError(400, 'invalid_input', 'Le compte qui reçoit les mouvements Wallindirain doit être en GNF'); }
    return { account_id: await fn('fn_pf_wallet_link', ctx.user.id, acct) };
  }));
  app.post('/api/pf/wallet-unlink', guard(ALL, async (ctx) => {
    writing(ctx);
    await fn('fn_pf_wallet_unlink', ctx.user.id);
    return { ok: true };
  }));

  app.post('/api/pf/subscribe', guard(ALL, async (ctx) => {
    limit(`pf-sub:${ctx.user.id}`, 10, 3600_000);
    return { paid_until: await fn('fn_pf_subscribe', ctx.user.id, v.oneOf(ctx.body.plan, ['monthly', 'yearly'], 'Formule')) };
  }));

  // ----- administration : réglages du module et abonnés -----
  app.get('/api/admin/pf', guard(['admin'], async () => ({
    settings: Object.fromEntries((await q(`SELECT key, value FROM settings WHERE key = 'feature_finances_perso' OR key LIKE 'pf\\_%'`)).map((r) => [r.key, Number(r.value)])),
    users: await q(`SELECT u.id, u.full_name, u.phone, u.role, u.status, u.created_at, a.trial_until, a.paid_until,
        (SELECT count(*) FROM pf_accounts c WHERE c.owner_id = u.id AND c.archived_at IS NULL)::int AS accounts,
        (SELECT count(*) FROM pf_transactions t WHERE t.owner_id = u.id AND t.voided_at IS NULL)::int AS transactions,
        (SELECT max(t.created_at) FROM pf_transactions t WHERE t.owner_id = u.id) AS last_activity, fn_pf_tier(u.id) AS tier
      FROM users u LEFT JOIN pf_access a ON a.owner_id = u.id
      WHERE u.deleted_at IS NULL AND (a.owner_id IS NOT NULL OR u.role = 'member') ORDER BY COALESCE(a.updated_at, u.created_at) DESC LIMIT 200`)
  })));
  app.post('/api/admin/pf/grant', guard(['admin'], async (ctx) => {
    limit(`pf-grant:${ctx.user.id}`, 100, 3600_000);
    return { paid_until: await fn('fn_admin_pf_grant', ctx.user.id, v.uuid(ctx.body.user_id, 'Utilisateur'), v.int(ctx.body.months, 'Durée', { min: 1, max: 24 }), v.str(ctx.body.note, 'Note', { min: 3, max: 200 })) };
  }));
}
