// Relances : le vendeur écrit ou appelle ses clients un par un, avec son propre téléphone (migration 044).
// Wallindirain prépare les listes et tient le suivi ; elle n'envoie rien. Le texte des messages n'est jamais enregistré.
// Les étiquettes automatiques et les listes sont calculées ici, à partir des commandes (rien n'est enregistré en double).
// Les règles de contact (désinscrit, client à risque, délai, maximum par jour, engagement) sont appliquées par la base (_relance_check).
import { HttpError, v } from './http.js';

/** Doit rester égal à _relance_consent_version() en base : si le texte d'engagement change, on augmente les deux. */
export const RELANCE_CONSENT_VERSION = 1;

const FAILED = ['failed', 'return_pending', 'returned', 'refused'];
const DAY = 86_400_000;
const CHANNELS = ['sms', 'whatsapp', 'call'];
const OUTCOMES = ['answered', 'no_answer', 'call_back'];
const LOG_LISTS = ['fideles', 'nouveaux', 'inactifs', 'non_abouti', 'etiquette', 'fete', 'rappels'];
const LISTS = [...LOG_LISTS, 'a_eviter'];
const COLORS = ['green', 'red', 'gold', 'blue', 'grey'];

// la base renvoie les horodatages en texte (« 2026-11-05 06:00:00+00 ») et les tableaux en « {a,b} »
const ms = (s) => (s ? Date.parse(String(s).replace(' ', 'T').replace(/\+00$/, 'Z')) : null);
const parseArr = (s) => (typeof s === 'string' ? s.replace(/[{}]/g, '').split(',').filter(Boolean) : []);
const isoDate = (x, name = 'Date') => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw new HttpError(400, 'invalid_input', `${name} invalide`);
  return x;
};
const todayIso = () => new Date().toISOString().slice(0, 10);
const dayIso = (t) => new Date(t).toISOString().slice(0, 10);

/** Étiquettes automatiques : posées par le système, le vendeur ne peut pas les modifier. */
export function autoTags(c, now = Date.now()) {
  const t = [];
  if (c.delivered >= 1) t.push('livre');
  if (c.paid >= 1) t.push('paye');
  if (c.failed >= 1) t.push('echec');
  if (FAILED.includes(c.last_status) || c.reminder_on) t.push('a_relancer');
  if (c.first_delivered_at && now - ms(c.first_delivered_at) <= 30 * DAY) t.push('nouveau');
  if (c.delivered >= 2) t.push('fidele');
  if (c.delivered >= 2 && c.failed === 0) t.push('bon_client');
  if (c.delivered >= 1 && now - ms(c.last_delivered_at) >= 30 * DAY) t.push('inactif');
  if (c.risk_incidents) t.push('a_risque');
  return t;
}

// Listes d'envoi (jamais un client désinscrit ni un client à risque : ils sont retirés avant)
const LIST_FILTERS = {
  fideles: (c) => c.delivered >= 2,
  nouveaux: (c, now) => !!c.first_delivered_at && now - ms(c.first_delivered_at) <= 30 * DAY,
  inactifs: (c, now, p) => c.delivered >= 1 && now - ms(c.last_delivered_at) >= p.days * DAY,
  non_abouti: (c) => c.absent >= 1 && FAILED.includes(c.last_status),
  etiquette: (c, now, p) => c.tag_ids.includes(p.tag),
  fete: (c) => c.delivered >= 1,
  rappels: (c, now, p) => !!c.reminder_on && c.reminder_on <= p.today
};

export function registerRelances(app, { q, fn, guard, limit }) {
  const SEL = ['seller'];
  const ADM = ['admin'];

  const featureOn = async () => Number((await q(`SELECT value FROM settings WHERE key = 'feature_relances'`))[0]?.value ?? 0) >= 1;
  const needFeature = async () => { if (!(await featureOn())) throw new HttpError(403, 'feature_off', 'Les relances ne sont pas encore activées'); };

  async function prefsOf(sellerId) {
    const [p] = await q('SELECT consent_version, daily_max, interval_days, shop_name FROM relance_prefs WHERE seller_id = $1', [sellerId]);
    return { consent_ok: p?.consent_version === RELANCE_CONSENT_VERSION, daily_max: p?.daily_max ?? null, interval_days: p?.interval_days ?? 14, shop_name: p?.shop_name ?? null };
  }
  const sentToday = async (sellerId) => (await q(`SELECT count(*)::int AS n FROM relance_log WHERE seller_id = $1 AND channel IN ('sms','whatsapp') AND at >= date_trunc('day', now())`, [sellerId]))[0].n;
  const tagsOf = (sellerId) => q('SELECT id, name, color FROM relance_tags WHERE seller_id = $1 AND deleted_at IS NULL ORDER BY lower(name)', [sellerId]);

  async function loadCustomers(sellerId) {
    const rows = await q('SELECT * FROM fn_seller_relance_customers($1)', [sellerId]);
    return rows.map((c) => ({ ...c, tag_ids: parseArr(c.tag_ids) }));
  }
  const contactable = (c) => !c.opted_out && !c.risk_incidents;
  const matches = (key, c, now, p) => LIST_FILTERS[key](c, now, p);

  // ---------- Vue d'ensemble : réglages, modèles, étiquettes, fêtes, compteurs des listes ----------
  app.get('/api/seller/relances', guard(SEL, async (ctx) => {
    if (!(await featureOn())) return { enabled: false };
    const id = ctx.user.id, now = Date.now(), today = todayIso();
    const [prefs, tags, templates, feasts, customers, sent] = await Promise.all([
      prefsOf(id), tagsOf(id),
      q('SELECT id, title, body FROM relance_templates WHERE seller_id = $1 AND deleted_at IS NULL ORDER BY created_at', [id]),
      q('SELECT id, name, on_date FROM relance_feasts WHERE seller_id = $1 AND deleted_at IS NULL AND on_date >= current_date ORDER BY on_date', [id]),
      loadCustomers(id), sentToday(id)]);
    const ok = customers.filter(contactable);
    const count = (key, p = {}) => ok.filter((c) => matches(key, c, now, { today, ...p })).length;
    return {
      enabled: true,
      seller_name: ctx.user.name || null,
      consent: { ok: prefs.consent_ok, version: RELANCE_CONSENT_VERSION },
      prefs: { daily_max: prefs.daily_max, interval_days: prefs.interval_days, shop_name: prefs.shop_name },
      sent_today: sent, templates, feasts: feasts.map((f) => ({ ...f, days_left: Math.round((Date.parse(f.on_date) - Date.parse(today)) / DAY) })),
      tags: tags.map((t) => ({ ...t, count: ok.filter((c) => c.tag_ids.includes(t.id)).length })),
      reminders_today: count('rappels'),
      lists: { total: ok.length, fideles: count('fideles'), nouveaux: count('nouveaux'), inactifs_30: count('inactifs', { days: 30 }), inactifs_60: count('inactifs', { days: 60 }), inactifs_90: count('inactifs', { days: 90 }),
        non_abouti: count('non_abouti'), fete: count('fete'), rappels: count('rappels'), a_eviter: customers.filter((c) => !c.opted_out && c.risk_incidents).length }
    };
  }));

  // ---------- Une liste de clients ----------
  app.get('/api/seller/relances/list', guard(SEL, async (ctx) => {
    await needFeature();
    const id = ctx.user.id, now = Date.now(), today = todayIso();
    const key = v.oneOf(ctx.query.list, LISTS, 'Liste');
    const p = { today, days: [30, 60, 90].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30, tag: null };
    const allTags = await tagsOf(id);
    if (key === 'etiquette') {
      p.tag = v.uuid(ctx.query.tag, 'Étiquette');
      if (!allTags.some((t) => t.id === p.tag)) throw new HttpError(404, 'not_found', 'Étiquette introuvable');
    }
    const [prefs, sent, customers] = await Promise.all([prefsOf(id), sentToday(id), loadCustomers(id)]);
    const dailyReached = prefs.daily_max != null && sent >= prefs.daily_max;
    const readOnly = key === 'a_eviter';
    const rows = customers.filter((c) => (readOnly ? !c.opted_out && c.risk_incidents : contactable(c) && matches(key, c, now, p)));
    // les rappels arrivés à échéance d'abord, puis les clients dont la dernière commande est la plus récente
    const due = (c) => (c.reminder_on && c.reminder_on <= today ? 1 : 0);
    rows.sort((a, b) => due(b) - due(a) || ms(b.last_order_at) - ms(a.last_order_at));
    let blocked = 0;
    const out = rows.map((c) => {
      const lastMsg = ms(c.last_message_at);
      const tooSoon = lastMsg != null && lastMsg > now - prefs.interval_days * DAY;
      if (tooSoon) blocked++;
      return {
        phone: c.phone, name: c.name, first_name: String(c.name || '').trim().split(/\s+/)[0] || '', commune: c.commune, orders: c.orders, delivered: c.delivered, failed: c.failed,
        auto_tags: autoTags(c, now), tags: allTags.filter((t) => c.tag_ids.includes(t.id)), note: c.note, reminder_on: c.reminder_on,
        last_message_at: c.last_message_at, last_contact_at: c.last_contact_at,
        can_message: !readOnly && !tooSoon && !dailyReached, can_call: !readOnly,
        next_message_on: tooSoon ? dayIso(lastMsg + prefs.interval_days * DAY) : null
      };
    });
    return { list: key, count: out.length, readonly: readOnly, sent_today: sent, daily_max: prefs.daily_max, daily_reached: dailyReached, interval_days: prefs.interval_days, blocked_recently: blocked, customers: out };
  }));

  // ---------- Fiche d'un client : historique daté, étiquettes, rappel ----------
  app.get('/api/seller/relances/customer/:phone', guard(SEL, async (ctx) => {
    await needFeature();
    const id = ctx.user.id, phone = v.phone(ctx.params.phone, 'Numéro du client');
    const c = (await loadCustomers(id)).find((x) => x.phone === phone);
    if (!c) throw new HttpError(404, 'not_found', 'Client introuvable');
    const [created, steps, logs, [note], allTags] = await Promise.all([
      q('SELECT ref, created_at FROM orders WHERE seller_id = $1 AND customer_phone = $2 ORDER BY created_at DESC LIMIT 50', [id, phone]),
      q(`SELECT o.ref, h.to_status, h.at FROM order_history h JOIN orders o ON o.id = h.order_id
          WHERE o.seller_id = $1 AND o.customer_phone = $2 AND h.to_status IN ('delivered','failed','returned','refused') ORDER BY h.at DESC LIMIT 100`, [id, phone]),
      q('SELECT channel, outcome, list_key, at FROM relance_log WHERE seller_id = $1 AND customer_phone = $2 ORDER BY at DESC LIMIT 100', [id, phone]),
      q('SELECT updated_at FROM seller_customer_notes WHERE seller_id = $1 AND customer_phone = $2', [id, phone]),
      tagsOf(id)]);
    const history = [
      ...created.map((o) => ({ kind: 'order_created', at: o.created_at, ref: o.ref })),
      ...steps.map((s) => ({ kind: s.to_status, at: s.at, ref: s.ref })),
      ...logs.map((l) => ({ kind: 'relance', at: l.at, channel: l.channel, outcome: l.outcome })),
      ...(note ? [{ kind: 'note', at: note.updated_at }] : [])
    ].sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 100);
    return { phone, name: c.name, commune: c.commune, orders: c.orders, delivered: c.delivered, failed: c.failed, opted_out: c.opted_out, risky: !!c.risk_incidents,
      auto_tags: autoTags(c), tags: allTags.filter((t) => c.tag_ids.includes(t.id)), all_tags: allTags, note: c.note, reminder_on: c.reminder_on, history };
  }));

  // ---------- Contacter ----------
  // avant d'ouvrir SMS, WhatsApp ou l'appel : la base dit si c'est permis (rien n'est écrit)
  app.post('/api/seller/relances/open', guard(SEL, async (ctx) => {
    limit(`relance:${ctx.user.id}`, 300, 60_000);
    await fn('fn_seller_relance_open', ctx.user.id, v.phone(ctx.body.phone, 'Numéro du client'), v.oneOf(ctx.body.channel, CHANNELS, 'Canal'));
    return { ok: true };
  }));
  // « C'est envoyé » (message) ou résultat de l'appel : seul « qui, quand, par quel canal » est enregistré, jamais le texte
  app.post('/api/seller/relances/log', guard(SEL, async (ctx) => {
    limit(`relance:${ctx.user.id}`, 300, 60_000);
    const b = ctx.body;
    const channel = v.oneOf(b.channel, CHANNELS, 'Canal');
    if (channel !== 'call' && b.outcome != null) throw new HttpError(400, 'invalid_input', 'Un message n\'a pas de résultat d\'appel');
    const outcome = channel === 'call' ? v.oneOf(b.outcome, OUTCOMES, 'Résultat de l\'appel') : null;
    const list = b.list == null || b.list === '' ? null : v.oneOf(b.list, LOG_LISTS, 'Liste');
    const remind = b.remind_on == null || b.remind_on === '' ? null : isoDate(b.remind_on, 'Date de rappel');
    const id = await fn('fn_seller_relance_log', ctx.user.id, v.phone(b.phone, 'Numéro du client'), channel, outcome, list, remind);
    ctx.status = 201;
    return { id: Number(id) };
  }));
  app.post('/api/seller/relances/customers/:phone/optout', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    await fn('fn_seller_relance_optout', ctx.user.id, v.phone(ctx.params.phone, 'Numéro du client'));
    return { ok: true };
  }));
  app.post('/api/seller/relances/customers/:phone/reminder', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    const d = ctx.body.date == null || ctx.body.date === '' ? null : isoDate(ctx.body.date, 'Date de rappel');
    await fn('fn_seller_relance_remind', ctx.user.id, v.phone(ctx.params.phone, 'Numéro du client'), d);
    return { ok: true };
  }));
  app.post('/api/seller/relances/customers/:phone/tags', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    await fn('fn_seller_relance_tag_set', ctx.user.id, v.uuid(ctx.body.tag_id, 'Étiquette'), v.phone(ctx.params.phone, 'Numéro du client'), ctx.body.on !== false);
    return { ok: true };
  }));

  // ---------- Réglages, engagement ----------
  app.post('/api/seller/relances/consent', guard(SEL, async (ctx) => {
    if (ctx.body.version !== RELANCE_CONSENT_VERSION) throw new HttpError(400, 'invalid_input', 'Texte d\'engagement périmé : rechargez la page');
    await fn('fn_seller_relance_consent', ctx.user.id);
    return { ok: true };
  }));
  app.post('/api/seller/relances/prefs', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    const b = ctx.body;
    // les bornes exactes (7 jours minimum, etc.) sont contrôlées par la base, qui renvoie un message clair
    const daily = b.daily_max == null || b.daily_max === '' ? null : v.int(b.daily_max, 'Maximum par jour', { min: 0, max: 1e7 });
    await fn('fn_seller_relance_set_prefs', ctx.user.id, daily, v.int(b.interval_days, 'Délai entre deux messages', { min: 0, max: 1e7 }), v.optStr(b.shop_name, 'Nom de la boutique', 100));
    return { ok: true };
  }));

  // ---------- Modèles, étiquettes, fêtes ----------
  app.post('/api/seller/relances/templates', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    const b = ctx.body;
    const id = await fn('fn_seller_relance_template_save', ctx.user.id, b.id ? v.uuid(b.id, 'Modèle') : null, v.str(b.title, 'Titre', { max: 200 }), v.str(b.body, 'Message', { max: 2000 }));
    ctx.status = b.id ? 200 : 201;
    return { id };
  }));
  app.post('/api/seller/relances/templates/:id/delete', guard(SEL, async (ctx) => { await fn('fn_seller_relance_template_delete', ctx.user.id, v.uuid(ctx.params.id, 'Modèle')); return { ok: true }; }));

  app.post('/api/seller/relances/tags', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    const id = await fn('fn_seller_relance_tag_create', ctx.user.id, v.str(ctx.body.name, 'Nom de l\'étiquette', { max: 100 }), v.oneOf(ctx.body.color, COLORS, 'Couleur'));
    ctx.status = 201;
    return { id };
  }));
  app.post('/api/seller/relances/tags/:id/delete', guard(SEL, async (ctx) => { await fn('fn_seller_relance_tag_delete', ctx.user.id, v.uuid(ctx.params.id, 'Étiquette')); return { ok: true }; }));

  app.post('/api/seller/relances/feasts', guard(SEL, async (ctx) => {
    limit(`relance-edit:${ctx.user.id}`, 300, 3600_000);
    const b = ctx.body;
    const id = await fn('fn_seller_relance_feast_save', ctx.user.id, b.id ? v.uuid(b.id, 'Fête') : null, v.str(b.name, 'Nom de la fête', { max: 100 }), isoDate(b.date, 'Date de la fête'));
    ctx.status = b.id ? 200 : 201;
    return { id };
  }));
  app.post('/api/seller/relances/feasts/:id/delete', guard(SEL, async (ctx) => { await fn('fn_seller_relance_feast_delete', ctx.user.id, v.uuid(ctx.params.id, 'Fête')); return { ok: true }; }));

  // ---------- Administrateur : clients désinscrits (seul l'administrateur peut les réactiver) ----------
  app.get('/api/admin/relances/optouts', guard(ADM, async () => ({
    optouts: await q(`SELECT o.seller_id, u.full_name AS seller_name, o.customer_phone, o.created_at FROM relance_optouts o JOIN users u ON u.id = o.seller_id ORDER BY o.created_at DESC LIMIT 500`)
  })));
  app.post('/api/admin/relances/reactivate', guard(ADM, async (ctx) => {
    await fn('fn_admin_relance_reactivate', ctx.user.id, v.uuid(ctx.body.seller_id, 'Vendeur'), v.phone(ctx.body.phone, 'Numéro du client'));
    return { ok: true };
  }));
}
