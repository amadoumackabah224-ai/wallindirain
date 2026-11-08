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
const optInt = (x, name, max = 1e11) => (x == null || x === '' ? null : v.int(x, name, { min: 1, max }));

/**
 * Position de l'aiguille d'une jauge, entre 0 (rouge) et 1 (vert).
 *  - revenus : revenus / objectif (objectif réglé, sinon les 30 jours d'avant)
 *  - flux : 0,5 quand rien ne bouge ; plus haut si on gagne plus qu'on ne dépense
 *  - solde : solde / objectif (réglé), sinon 0,5 à solde nul
 */
export function gauges({ income, expense, balance, prevIncome, incomeTarget, balanceTarget }) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const target = incomeTarget ?? (prevIncome > 0 ? prevIncome : null);
  const scale = Math.max(income, expense, 1);
  return {
    income: target ? clamp(income / target) : (income > 0 ? 1 : 0),
    flow: income === 0 && expense === 0 ? 0.5 : clamp(0.5 + (income - expense) / (2 * scale)),
    balance: balanceTarget ? clamp(balance / balanceTarget) : (balance > 0 ? 0.75 : balance < 0 ? 0 : 0.5)
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
    const rows = await q(`SELECT a.id, a.name, a.kind, a.color, a.opening_balance::bigint AS opening_balance, a.created_at, a.archived_at,
        (a.opening_balance + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END) FROM pf_all_tx t WHERE t.account_id = a.id AND t.voided_at IS NULL), 0))::bigint AS balance,
        a.archived_at IS NULL AS open
      FROM pf_accounts a WHERE a.owner_id = $1 ORDER BY a.archived_at NULLS FIRST, a.created_at, a.id`, [id]);
    // formule gratuite : seuls les plus anciens comptes actifs reçoivent des transactions (même règle que la base)
    let rank = 0;
    const list = rows.map((a) => ({ ...a, writable: a.open && (acc.tier === 'pro' || ++rank <= acc.free_accounts) }));
    // compte Wallindirain automatique (si relié) : lecture seule, solde = argent disponible du portefeuille
    const [link] = await q('SELECT wallet_linked, wallet_account FROM pf_prefs WHERE owner_id = $1', [id]);
    if (link?.wallet_linked) {
      const [w] = await q('SELECT COALESCE(sum(amount), 0)::bigint AS bal FROM wallet_entries WHERE user_id = $1 AND available_at <= now()', [id]);
      list.push({ id: 'wallindirain', name: 'Wallindirain', kind: 'wallindirain', color: 'teal', opening_balance: 0, created_at: null, archived_at: null, balance: Number(w.bal), open: true, writable: false, auto: true, receives: link.wallet_account });
    }
    return list;
  }
  const WALLET_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

  app.get('/api/pf/status', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const [link] = await q('SELECT wallet_linked, wallet_account FROM pf_prefs WHERE owner_id = $1', [ctx.user.id]);
    return { enabled: true, ...(await access(ctx.user.id)), wallet: { eligible: WALLET_ROLES.includes(ctx.user.role), linked: !!link?.wallet_linked, account: link?.wallet_account || null } };
  }));

  /** Tout l'écran « Tableau de bord » en un seul appel. */
  app.get('/api/pf/home', guard(ALL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id;
    const acc = await access(id);
    const days = Math.min(acc.tier === 'pro' ? 365 : FREE_MAX_DAYS, Math.max(7, Number(ctx.query.days) || 30));
    const accounts = await accountsOf(id, acc);
    const active = accounts.filter((a) => !a.archived_at);
    const balance = active.reduce((a, x) => a + Number(x.balance), 0);
    const since = dayStr(Date.now() - (days - 1) * DAY), prevFrom = dayStr(Date.now() - (2 * days - 1) * DAY);
    const flows = await q(`SELECT occurred_on::text AS day, kind, category, sum(amount)::bigint AS total FROM pf_all_tx
        WHERE owner_id = $1 AND voided_at IS NULL AND occurred_on >= $2::date AND occurred_on <= current_date GROUP BY 1, 2, 3`, [id, prevFrom]);
    const inRange = flows.filter((f) => f.day >= since);
    const sum = (rows, kinds) => rows.filter((f) => kinds.includes(f.kind)).reduce((a, f) => a + Number(f.total), 0);
    const income = sum(inRange, ['income']), expense = sum(inRange, ['expense']);
    const prevIncome = sum(flows.filter((f) => f.day < since), ['income']);
    // courbe du solde : on part du solde actuel et on remonte jour après jour (virements : net nul sur l'ensemble des comptes)
    const net = new Map();
    for (const f of flows) if (f.kind === 'income' || f.kind === 'expense') net.set(f.day, (net.get(f.day) || 0) + (f.kind === 'income' ? 1 : -1) * Number(f.total));
    const later = await q(`SELECT occurred_on::text AS day, sum(CASE WHEN kind = 'income' THEN amount WHEN kind = 'expense' THEN -amount ELSE 0 END)::bigint AS net FROM pf_all_tx
        WHERE owner_id = $1 AND voided_at IS NULL AND occurred_on > current_date GROUP BY 1`, [id]);
    const series = []; let run = balance - later.reduce((a, r) => a + Number(r.net), 0);   // les opérations datées de demain ne comptent pas encore dans la courbe
    for (let i = 0; i < days; i++) { const d = dayStr(Date.now() - i * DAY); series.unshift({ day: d, balance: run }); run -= net.get(d) || 0; }
    const byCategory = (kinds) => Object.entries(inRange.filter((f) => kinds.includes(f.kind)).reduce((m, f) => { m[f.category] = (m[f.category] || 0) + Number(f.total); return m; }, {}))
      .map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
    const [pref] = await q('SELECT income_target, balance_target FROM pf_prefs WHERE owner_id = $1', [id]);
    const [w] = await q(`SELECT COALESCE(sum(amount) FILTER (WHERE available_at <= now()), 0)::bigint AS available, COALESCE(sum(amount) FILTER (WHERE available_at > now()), 0)::bigint AS pending FROM wallet_entries WHERE user_id = $1`, [id]);
    const recent = await q(`SELECT t.id, t.kind, t.amount::bigint AS amount, t.category, t.note, t.occurred_on::text AS occurred_on, COALESCE(a.name, 'Wallindirain') AS account_name, COALESCE(a.color, 'teal') AS color, t.source
        FROM pf_all_tx t LEFT JOIN pf_accounts a ON a.id = t.account_id WHERE t.owner_id = $1 AND t.voided_at IS NULL AND t.occurred_on >= current_date - $2::int
        ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 6`, [id, acc.tier === 'pro' ? 100000 : acc.free_history_days]);
    return {
      enabled: true, ...acc, days, accounts, balance, income, expense, flow: income - expense, prev_income: prevIncome,
      gauges: gauges({ income, expense, balance, prevIncome, incomeTarget: pref?.income_target ? Number(pref.income_target) : null, balanceTarget: pref?.balance_target ? Number(pref.balance_target) : null }),
      targets: { income: pref?.income_target ? Number(pref.income_target) : null, balance: pref?.balance_target ? Number(pref.balance_target) : null },
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
      v.int(b.opening_balance ?? 0, 'Solde de départ', { min: -1e11, max: 1e11 }));
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
    const rows = await q(`SELECT t.id, t.kind, t.amount::bigint AS amount, t.category, t.note, t.occurred_on::text AS occurred_on, t.transfer_id, t.account_id, COALESCE(a.name, 'Wallindirain') AS account_name, COALESCE(a.color, 'teal') AS color, t.source
        FROM pf_all_tx t LEFT JOIN pf_accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 100`, params);
    return { enabled: true, transactions: rows, history_limited: acc.tier !== 'pro' ? acc.free_history_days : null };
  }));
  app.post('/api/pf/transactions', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const kind = v.oneOf(b.kind, ['income', 'expense'], 'Type');
    const id = await fn('fn_pf_tx_add', ctx.user.id, v.uuid(b.account_id, 'Compte'), kind, v.int(b.amount, 'Montant', { min: 1, max: 1e11 }),
      v.oneOf(b.category, kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES, 'Catégorie'), v.optStr(b.note, 'Note', 200), ymd(b.occurred_on));
    ctx.status = 201;
    return { id };
  }));
  app.post('/api/pf/transactions/:id/update', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    const [t] = await q('SELECT kind FROM pf_transactions WHERE id = $1 AND owner_id = $2', [v.uuid(ctx.params.id, 'Transaction'), ctx.user.id]);
    if (!t) throw new HttpError(404, 'not_found', 'Transaction introuvable');
    await fn('fn_pf_tx_update', ctx.user.id, ctx.params.id, v.uuid(b.account_id, 'Compte'), v.int(b.amount, 'Montant', { min: 1, max: 1e11 }),
      v.oneOf(b.category, t.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES, 'Catégorie'), v.optStr(b.note, 'Note', 200), ymd(b.occurred_on));
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
    const balance = accounts.filter((a) => !a.archived_at).reduce((t, a) => t + Number(a.balance), 0);
    const from = dayStr(Date.now() + DAY), to = dayStr(Date.now() + 30 * DAY);
    const upcoming = recurring.flatMap((r) => occurrences(r, from, to).map((day) => ({ day, label: r.label, kind: r.kind, category: r.category, amount: r.amount }))).sort((a, b) => a.day.localeCompare(b.day));
    const inc = upcoming.filter((u) => u.kind === 'income').reduce((t, u) => t + u.amount, 0), exp = upcoming.filter((u) => u.kind === 'expense').reduce((t, u) => t + u.amount, 0);
    return { enabled: true, ...acc, month, budgets, goal: g ? { target: Number(g.target), saved: Number(m.net) } : null, month_net: Number(m.net), recurring,
      forecast: { balance, income: inc, expense: exp, projected: balance + inc - exp, upcoming: upcoming.slice(0, 12) } };
  }));
  app.post('/api/pf/budgets', guard(ALL, async (ctx) => {
    writing(ctx); const b = ctx.body;
    await fn('fn_pf_budget_set', ctx.user.id, v.oneOf(b.category, EXPENSE_CATEGORIES, 'Catégorie'), optInt(b.amount, 'Budget'));
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
    const id = await fn('fn_pf_recurring_save', ctx.user.id, b.id ? v.uuid(b.id, 'Récurrent') : null, v.str(b.label, 'Nom', { max: 40 }), kind, v.oneOf(b.category, kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES, 'Catégorie'),
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
  app.post('/api/pf/wallet-link', guard(ALL, async (ctx) => {
    writing(ctx);
    const acct = ctx.body.account_id ? v.uuid(ctx.body.account_id, 'Compte') : null;
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
    users: await q(`SELECT u.id, u.full_name, u.phone, u.role, a.trial_until, a.paid_until, (SELECT count(*) FROM pf_accounts c WHERE c.owner_id = u.id AND c.archived_at IS NULL)::int AS accounts,
        (SELECT count(*) FROM pf_transactions t WHERE t.owner_id = u.id AND t.voided_at IS NULL)::int AS transactions, fn_pf_tier(u.id) AS tier
      FROM pf_access a JOIN users u ON u.id = a.owner_id ORDER BY a.updated_at DESC LIMIT 200`)
  })));
  app.post('/api/admin/pf/grant', guard(['admin'], async (ctx) => {
    limit(`pf-grant:${ctx.user.id}`, 100, 3600_000);
    return { paid_until: await fn('fn_admin_pf_grant', ctx.user.id, v.uuid(ctx.body.user_id, 'Utilisateur'), v.int(ctx.body.months, 'Durée', { min: 1, max: 24 }), v.str(ctx.body.note, 'Note', { min: 3, max: 200 })) };
  }));
}
