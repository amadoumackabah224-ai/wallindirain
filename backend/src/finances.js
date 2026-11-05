// Tableau argent du vendeur (module Finances, migration 045) : prévision de l'argent à venir, dépenses récurrentes, budget, objectif.
// Tout est en lecture seule sur l'argent de la plateforme : le calcul part des écritures de portefeuille et des commandes existantes.
// Les nouvelles données (récurrents, budget, objectif, taux de prévision) sont écrites par des fonctions SQL qui vérifient les règles.
import { HttpError, v } from './http.js';

const DAY = 86_400_000;
const CATEGORIES = ['ads', 'goods', 'transport', 'other'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const IN_PROGRESS = ['new', 'in_call', 'confirmed', 'assigned', 'picked_up', 'on_the_way'];
export const HORIZONS = [30, 60, 90];
/** Taux de livraison utilisé quand le vendeur n'a pas assez d'historique (moins de 10 commandes terminées). */
export const DEFAULT_RATE = 60;
export const MIN_HISTORY = 10;
/** Écart entre le cas prudent / le cas favorable et le taux central, en points de pourcentage. */
export const SPREAD = { low: 15, high: 10 };

const ms = (s) => (s ? Date.parse(String(s).replace(' ', 'T').replace(/\+00$/, 'Z')) : null);
const dayStart = (t) => Math.floor(t / DAY) * DAY;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Échéances d'une dépense récurrente dans ]from, to] (jours UTC, aucune avant la première échéance).
 * Retourne des dates ISO. Mensuel : même jour du mois que la première échéance (1 à 28, imposé par la base).
 */
export function occurrences(r, fromDay, toDay) {
  const anchor = dayStart(ms(`${r.anchor_on} 00:00:00+00`));
  const out = [];
  if (r.frequency === 'daily' || r.frequency === 'weekly') {
    const step = r.frequency === 'daily' ? DAY : 7 * DAY;
    let t = anchor;
    if (t <= fromDay) t += Math.ceil((fromDay + 1 - t) / step) * step;
    for (; t <= toDay; t += step) out.push(iso(t));
  } else {
    const dom = new Date(anchor).getUTCDate();
    const d = new Date(fromDay);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let i = 0; i < 6; i++, m++) {
      const t = Date.UTC(y + Math.floor(m / 12), m % 12, dom);
      if (t > fromDay && t <= toDay && t >= anchor) out.push(iso(t));
    }
  }
  return out;
}

/**
 * Prévision à 30, 60 et 90 jours. Elle ne devine aucune vente future : elle compte ce qui est déjà certain ou en cours.
 *  - certain : solde disponible, moins les retraits réservés ; gains déjà bloqués qui se débloquent avant l'échéance
 *  - estimé : commandes en cours × gain moyen par livraison × taux de livraison (prudent / central / favorable)
 *  - sorties : dépenses récurrentes qui tombent avant l'échéance
 */
export function forecast({ now, available, reserved, locked, inProgress, avgGain, rate, recurring }) {
  const today = dayStart(now);
  return HORIZONS.map((days) => {
    const end = today + days * DAY;
    const unlocked = locked.filter((e) => ms(e.available_at) <= end + DAY - 1).reduce((a, e) => a + Number(e.amount), 0);
    let out = 0;
    for (const r of recurring) out += occurrences(r, today, end).length * Number(r.amount);
    const est = (pct) => Math.round(inProgress * avgGain * Math.max(0, Math.min(100, pct)) / 100);
    const base = available - reserved + unlocked - out;
    return { days, certain: base, low: base + est(rate - SPREAD.low), mid: base + est(rate), high: base + est(rate + SPREAD.high), unlocked, out };
  });
}

export function registerFinances(app, { q, fn, guard, limit }) {
  const SEL = ['seller'];
  const featureOn = async () => Number((await q(`SELECT value FROM settings WHERE key = 'feature_finances'`))[0]?.value ?? 0) >= 1;

  app.get('/api/seller/finances', guard(SEL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, now = Date.now();
    const [bal] = await q(`SELECT COALESCE(sum(amount) FILTER (WHERE available_at <= now()), 0)::bigint AS available,
        COALESCE(sum(amount) FILTER (WHERE available_at > now()), 0)::bigint AS pending FROM wallet_entries WHERE user_id = $1`, [id]);
    const [res] = await q(`SELECT COALESCE(sum(amount), 0)::bigint AS r FROM withdrawals WHERE user_id = $1 AND status = 'requested' AND NOT debited`, [id]);
    const locked = await q(`SELECT amount::bigint AS amount, available_at FROM wallet_entries WHERE user_id = $1 AND available_at > now() ORDER BY available_at`, [id]);
    const [ord] = await q(`SELECT count(*) FILTER (WHERE status = ANY($2))::int AS in_progress,
        count(*) FILTER (WHERE status = 'delivered' AND created_at >= now() - interval '90 days')::int AS delivered90,
        count(*) FILTER (WHERE status IN ('failed','return_pending','returned','refused') AND created_at >= now() - interval '90 days')::int AS failed90
      FROM orders WHERE seller_id = $1`, [id, IN_PROGRESS]);
    const [g90] = await q(`SELECT COALESCE(sum(amount), 0)::bigint AS gains, count(DISTINCT order_id)::int AS n FROM wallet_entries
        WHERE user_id = $1 AND kind = 'seller_gain' AND created_at >= now() - interval '90 days'`, [id]);
    const [pref] = await q('SELECT delivery_rate FROM finance_prefs WHERE owner_id = $1', [id]);
    const recurring = await q(`SELECT id, label, category, amount::bigint AS amount, frequency, anchor_on FROM finance_recurring WHERE owner_id = $1 AND stopped_at IS NULL ORDER BY created_at`, [id]);
    const budgets = await q('SELECT category, amount::bigint AS amount FROM finance_budgets WHERE owner_id = $1', [id]);
    const spent = await q(`SELECT category, sum(amount)::bigint AS total FROM seller_expenses
        WHERE seller_id = $1 AND voided_at IS NULL AND spent_on >= date_trunc('month', current_date) GROUP BY 1`, [id]);
    const [goal] = await q(`SELECT target::bigint AS target FROM finance_goals WHERE owner_id = $1 AND month = date_trunc('month', current_date)::date`, [id]);
    const [month] = await q(`SELECT COALESCE(sum(amount), 0)::bigint AS gains FROM wallet_entries WHERE user_id = $1 AND kind = 'seller_gain' AND created_at >= date_trunc('month', now())`, [id]);
    const [ads30] = await q(`SELECT COALESCE(sum(amount), 0)::bigint AS ads FROM seller_expenses WHERE seller_id = $1 AND voided_at IS NULL AND category = 'ads' AND spent_on >= current_date - 30`, [id]);
    const [del30] = await q(`SELECT count(*)::int AS n FROM orders WHERE seller_id = $1 AND status = 'delivered' AND delivered_at >= now() - interval '30 days'`, [id]);

    const done = ord.delivered90 + ord.failed90;
    const realRate = done >= MIN_HISTORY ? Math.round((ord.delivered90 * 100) / done) : null;
    const rate = pref?.delivery_rate ?? realRate ?? DEFAULT_RATE;
    const avgGain = g90.n > 0 ? Math.round(Number(g90.gains) / g90.n) : 0;
    const today = dayStart(now);

    const fc = forecast({ now, available: Number(bal.available), reserved: Number(res.r), locked, inProgress: ord.in_progress, avgGain, rate, recurring });
    // une seule ligne par dépense : sa prochaine échéance dans les 7 prochains jours (aujourd'hui compris)
    const dueSoon = recurring.flatMap((r) => { const on = occurrences(r, today - 1, today + 7 * DAY)[0]; return on ? [{ id: r.id, label: r.label, amount: Number(r.amount), on }] : []; })
      .sort((a, b) => a.on.localeCompare(b.on));
    const spentBy = Object.fromEntries(spent.map((s) => [s.category, Number(s.total)]));
    const daysInMonth = new Date(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - new Date(now).getUTCDate();
    const gains = Number(month.gains), target = goal ? Number(goal.target) : null;
    const adsPerDelivery = del30.n > 0 && Number(ads30.ads) > 0 ? Math.round(Number(ads30.ads) / del30.n) : null;

    return {
      enabled: true,
      available: Number(bal.available), pending: Number(bal.pending), reserved: Number(res.r),
      in_progress: ord.in_progress, avg_gain: avgGain,
      rate: { used: rate, real: realRate, custom: pref?.delivery_rate ?? null, enough_history: realRate != null },
      forecast: fc,
      recurring: recurring.map((r) => ({ ...r, amount: Number(r.amount), next: occurrences(r, today, today + 400 * DAY)[0] || null })),
      due_soon: dueSoon,
      budgets: CATEGORIES.map((c) => { const b = budgets.find((x) => x.category === c); return { category: c, budget: b ? Number(b.amount) : null, spent: spentBy[c] || 0 }; }),
      goal: { target, gains, days_left: daysLeft, missing: target != null ? Math.max(0, target - gains) : null,
        deliveries_missing: target != null && avgGain > 0 ? Math.ceil(Math.max(0, target - gains) / avgGain) : null },
      ads_alert: adsPerDelivery != null && avgGain > 0 && adsPerDelivery > avgGain ? { ads_per_delivery: adsPerDelivery, avg_gain: avgGain } : null
    };
  }));

  const writing = (ctx) => limit(`finance-edit:${ctx.user.id}`, 200, 3600_000);
  const optInt = (x, name, max) => (x == null || x === '' ? null : v.int(x, name, { min: 0, max }));

  app.post('/api/seller/finances/recurring', guard(SEL, async (ctx) => {
    writing(ctx);
    const b = ctx.body;
    const anchor = typeof b.anchor_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.anchor_on) && !Number.isNaN(Date.parse(b.anchor_on)) ? b.anchor_on : null;
    if (!anchor) throw new HttpError(400, 'invalid_input', 'Date invalide');
    const id = await fn('fn_seller_finance_recurring_save', ctx.user.id, b.id ? v.uuid(b.id, 'Dépense') : null, v.str(b.label, 'Nom', { max: 200 }),
      v.oneOf(b.category, CATEGORIES, 'Catégorie'), v.int(b.amount, 'Montant', { min: 0, max: 1e12 }), v.oneOf(b.frequency, FREQUENCIES, 'Fréquence'), anchor);
    ctx.status = b.id ? 200 : 201;
    return { id };
  }));
  app.post('/api/seller/finances/recurring/:id/stop', guard(SEL, async (ctx) => {
    writing(ctx);
    await fn('fn_seller_finance_recurring_stop', ctx.user.id, v.uuid(ctx.params.id, 'Dépense'));
    return { ok: true };
  }));
  app.post('/api/seller/finances/budget', guard(SEL, async (ctx) => {
    writing(ctx);
    await fn('fn_seller_finance_budget_set', ctx.user.id, v.oneOf(ctx.body.category, CATEGORIES, 'Catégorie'), optInt(ctx.body.amount, 'Montant', 1e12));
    return { ok: true };
  }));
  app.post('/api/seller/finances/goal', guard(SEL, async (ctx) => {
    writing(ctx);
    await fn('fn_seller_finance_goal_set', ctx.user.id, optInt(ctx.body.target, 'Objectif', 1e12));
    return { ok: true };
  }));
  app.post('/api/seller/finances/rate', guard(SEL, async (ctx) => {
    writing(ctx);
    await fn('fn_seller_finance_rate_set', ctx.user.id, optInt(ctx.body.rate, 'Taux', 1000));
    return { ok: true };
  }));
}
