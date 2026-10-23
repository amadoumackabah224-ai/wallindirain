// Toutes les routes de l'API. Règle d'or : chaque route vérifie le rôle côté serveur,
// et chaque requête de lecture nomme explicitement les colonnes visibles pour ce rôle
// (cloisonnement : le fournisseur ne voit jamais le vendeur/client, et inversement).
import { HttpError, v, page } from './http.js';
import crypto from 'node:crypto';
import { parseImage, MAX_PROOF_BODY } from './proofs.js';
import { legalMissing, createLegal, PAGES as LEGAL_PAGES } from './legal.js';
import { answer, suggestions, topic, topics } from './assistant.js';
import { parseSheetUrl, fetchSheetCsv, parseCsv, mapRows, phone9, isYes, parsePrice, rowHash } from './sheets.js';
import { hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, newToken, tokenHash, RateLimiter, parseCookies } from './security.js';

const COOKIE = 'wld_session';
const WALLET_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

export function registerRoutes(app, { db, cfg }) {
  const limiter = new RateLimiter();
  const fn = async (name, ...args) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(',');
    return (await db.query(`SELECT ${name}(${ph}) AS r`, args)).rows[0].r;
  };
  const q = (text, params) => db.query(text, params).then((r) => r.rows);

  // ---------- utilitaires ----------
  const clientIp = (req) => {
    if (cfg.trustProxy) { const xff = req.headers['x-forwarded-for']; if (xff) return xff.split(',').pop().trim(); }
    return req.socket.remoteAddress || 'unknown';
  };
  const limit = (key, max, windowMs) => {
    if (!limiter.allow(key, max, windowMs)) throw new HttpError(429, 'too_many', 'Trop de tentatives. Patientez quelques minutes puis réessayez.');
  };

  async function auth(ctx, roles) {
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (!token) throw new HttpError(401, 'unauthorized', 'Connexion requise');
    // protection CSRF : cookie SameSite=Strict + en-tête obligatoire + origine identique
    if (ctx.req.method !== 'GET') {
      if (ctx.req.headers['x-wld'] !== '1') throw new HttpError(403, 'csrf', 'Requête refusée');
      const origin = ctx.req.headers.origin;
      let originHost = null;
      try { originHost = origin ? new URL(origin).host : null; } catch { throw new HttpError(403, 'csrf', 'Origine refusée'); }
      if (originHost && originHost !== ctx.req.headers.host) throw new HttpError(403, 'csrf', 'Origine refusée');
    }
    const rows = await q('SELECT * FROM fn_session_user($1)', [tokenHash(token)]);
    if (!rows.length) throw new HttpError(401, 'unauthorized', 'Session expirée, reconnectez-vous');
    const u = rows[0];
    if (roles && !roles.includes(u.role)) throw new HttpError(403, 'forbidden', 'Action non autorisée pour votre rôle');
    ctx.user = u;
    ctx.token = token;
    return u;
  }
  const guard = (roles, handler) => async (ctx) => { await auth(ctx, roles); return handler(ctx); };
  const setCookie = (ctx, value, maxAge) => {
    ctx.cookies.push(`${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cfg.prod ? '; Secure' : ''}`);
  };

  // moment de la dernière affectation d'un livreur (pour détecter un colis non récupéré)
  const ASSIGNED_SINCE = `(SELECT max(h.at) FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned')`;
  const pickupHours = async () => Number((await q(`SELECT value FROM settings WHERE key = 'pickup_alert_hours'`))[0]?.value ?? 0);

  const ANY_ROLE = ['admin', 'seller', 'supplier', 'agent', 'call_chief', 'courier', 'warehouse'];
  // vérifie le mot de passe actuel de la personne connectée (actions sensibles)
  async function requirePassword(ctx, pw) {
    const rows = await q('SELECT * FROM fn_login_lookup($1)', [ctx.user.phone]);
    const given = typeof pw === 'string' ? pw.slice(0, 128) : '';
    if (!rows.length || !(await verifyPassword(given, rows[0].password_hash))) throw new HttpError(403, 'bad_password', 'Mot de passe incorrect');
  }
  const tempPassword = () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', digits = '23456789';
    const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
    return pick(letters, 6) + pick(digits, 3) + pick(letters, 1);
  };

  // exposé pour les tests : remet les compteurs de débit à zéro
  app.resetLimits = () => limiter.reset();

  // =========================================================================
  // Public : informations générales
  // =========================================================================
  app.get('/api/public/info', async () => ({
    contact_phone: cfg.contactPhone,
    email_enabled: (cfg.email?.provider || 'simulated') !== 'simulated',
    communes: await q('SELECT commune, fee FROM delivery_rates WHERE active ORDER BY commune')
  }));

  // =========================================================================
  // Authentification
  // =========================================================================
  app.post('/api/auth/register', async (ctx) => {
    limit(`reg:${clientIp(ctx.req)}`, 5, 3600_000);
    const b = ctx.body;
    const pwErr = passwordProblem(b.password);
    if (pwErr) throw new HttpError(400, 'weak_password', pwErr);
    if (b.accept_terms !== true) throw new HttpError(400, 'consent_required', 'Vous devez accepter les conditions d\'utilisation et la politique de confidentialité');
    const role = v.oneOf(b.role, ['seller', 'supplier'], 'Rôle');
    const phone = v.phone(b.phone);
    if (b.email) v.email(b.email);   // validé avant la création du compte
    // numéro sur lequel l'argent sera versé : opérateur obligatoire, numéro = celui de connexion par défaut
    const payMethod = v.oneOf(b.payout_method, ['orange_money', 'mtn_momo'], 'Opérateur de versement');
    const payPhone = b.payout_phone ? v.phone(b.payout_phone, 'Numéro de versement') : phone;
    const id = await fn('fn_register', phone, v.str(b.name, 'Nom', { min: 2, max: 100 }), role,
      await hashPassword(b.password),
      role === 'supplier' ? v.str(b.identity_doc, 'Pièce d\'identité', { min: 4, max: 60 }) : v.optStr(b.identity_doc, 'Pièce d\'identité', 60),
      payMethod, payPhone, cfg.legal.version);
    if (b.email) await fn('fn_register_email', id, v.email(b.email));   // code de vérification envoyé par e-mail
    let referral = null;
    if (role === 'seller' && typeof b.referral_code === 'string' && b.referral_code.trim()) referral = await fn('fn_register_referral', id, v.str(b.referral_code, 'Code de parrainage', { min: 4, max: 12 }));
    ctx.status = 201;
    return { id, pending_validation: role === 'supplier', email_pending: !!b.email, referral_applied: referral,
      message: role === 'supplier' ? 'Compte créé. Il sera activé après validation par l\'administration.' : 'Compte créé. Vous pouvez vous connecter.' };
  });

  app.post('/api/auth/login', async (ctx) => {
    const ip = clientIp(ctx.req);
    const phone = v.identifier(ctx.body.identifier ?? ctx.body.phone);   // numéro OU adresse e-mail vérifiée
    limit(`login-ip:${ip}`, 20, 300_000);
    limit(`login-phone:${phone}`, 10, 300_000);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 128) : '';
    const rows = await q('SELECT * FROM fn_login_lookup($1)', [phone]);   // lève "locked" si bloqué
    const u = rows[0];
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) {
      if (u) await fn('fn_login_failed', phone);
      throw new HttpError(401, 'bad_credentials', 'Numéro, adresse e-mail ou mot de passe incorrect');
    }
    if (u.status === 'pending') throw new HttpError(403, 'pending', 'Votre compte attend la validation de l\'administration');
    if (u.status === 'suspended') throw new HttpError(403, 'suspended', 'Compte suspendu. Contactez Wallindirain.');
    await fn('fn_login_ok', u.id);
    const token = newToken();
    await fn('fn_session_create', u.id, tokenHash(token));
    setCookie(ctx, token, 12 * 3600);
    return { user: { id: u.id, role: u.role, name: u.full_name } };
  });

  app.post('/api/auth/logout', async (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (token) await fn('fn_session_revoke', tokenHash(token));
    setCookie(ctx, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', guard(null, async (ctx) => ({ user: { id: ctx.user.id, role: ctx.user.role, name: ctx.user.full_name,
    phone: ctx.user.phone, email: ctx.user.email, email_verified: ctx.user.email_verified, team: ctx.user.team, identity_verified: ctx.user.identity_verified,
    has_avatar: (await q('SELECT 1 FROM avatars WHERE user_id = $1', [ctx.user.id])).length > 0 } })));

  app.post('/api/auth/forgot', async (ctx) => {
    const ident = v.identifier(ctx.body.identifier ?? ctx.body.phone);
    limit(`forgot-ip:${clientIp(ctx.req)}`, 10, 3600_000);
    limit(`forgot-phone:${ident}`, 3, 900_000);
    await fn('fn_password_reset_request', ident);
    // même réponse que le compte existe ou non (pas de fuite d'information)
    return { ok: true, message: 'Si ce compte existe, un code vient d\'être envoyé : dans votre boîte e-mail si votre adresse est confirmée, sinon par message au numéro.' };
  });

  app.post('/api/auth/reset', async (ctx) => {
    limit(`reset-ip:${clientIp(ctx.req)}`, 10, 900_000);
    const pwErr = passwordProblem(ctx.body.password);
    if (pwErr) throw new HttpError(400, 'weak_password', pwErr);
    const r = await fn('fn_password_reset_confirm', v.identifier(ctx.body.identifier ?? ctx.body.phone), v.str(ctx.body.code, 'Code', { min: 6, max: 6 }), await hashPassword(ctx.body.password));
    if (!r.ok) throw new HttpError(400, 'invalid_code', 'Code invalide ou expiré');
    return { ok: true };
  });

  // ---------- Adresse e-mail du compte (confirmée par un code reçu dans la boîte) ----------
  app.post('/api/me/email', guard(ANY_ROLE, async (ctx) => {
    limit(`email-set:${ctx.user.id}`, 5, 3600_000);
    await requirePassword(ctx, ctx.body.password);
    await fn('fn_email_set', ctx.user.id, v.email(ctx.body.email));
    return { ok: true };
  }));
  app.post('/api/me/email/resend', guard(ANY_ROLE, async (ctx) => {
    limit(`email-resend:${ctx.user.id}`, 5, 3600_000);
    await fn('fn_email_resend', ctx.user.id);
    return { ok: true };
  }));
  app.post('/api/me/email/verify', guard(ANY_ROLE, async (ctx) => {
    limit(`email-verify:${ctx.user.id}`, 10, 900_000);
    const r = await fn('fn_email_verify', ctx.user.id, v.str(ctx.body.code, 'Code', { min: 6, max: 6 }));
    if (!r.ok) throw new HttpError(400, r.reason === 'taken' ? 'email_taken' : 'invalid_code',
      r.reason === 'taken' ? 'Cette adresse est déjà utilisée par un autre compte' : 'Code invalide ou expiré');
    return { ok: true };
  }));

  // =========================================================================
  // Page publique du lien partagé (le client ne voit ni le vendeur ni le fournisseur)
  // =========================================================================
  app.get('/api/public/link/:code', async (ctx) => {
    limit(`link:${clientIp(ctx.req)}`, 120, 60_000);
    const rows = await q(`SELECT p.name, p.description, sp.sale_price AS unit_price, (p.stock_qty - p.reserved_qty) AS available
        FROM seller_links l JOIN products p ON p.id = l.product_id AND p.status = 'approved' AND p.deleted_at IS NULL
        JOIN users u ON u.id = l.seller_id AND u.status = 'active'
        JOIN seller_prices sp ON sp.seller_id = l.seller_id AND sp.product_id = l.product_id
        WHERE l.code = $1`, [ctx.params.code]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Ce lien n\'est plus valable');
    return { product: rows[0], communes: await q('SELECT commune, fee FROM delivery_rates WHERE active ORDER BY commune'), contact_phone: cfg.contactPhone };
  });

  app.post('/api/public/link/:code/order', async (ctx) => {
    limit(`pub-order:${clientIp(ctx.req)}`, 10, 600_000);
    const b = ctx.body;
    if (b.accepted !== true) throw new HttpError(400, 'consent_required', 'Vous devez accepter la politique de confidentialité pour commander');
    const custPhone = v.phone(b.phone, 'Votre numéro');
    await fn('fn_record_consent', 'order', null, custPhone, cfg.legal.version);
    const r = await fn('fn_public_order', ctx.params.code, v.int(b.qty, 'Quantité', { min: 1, max: 100 }),
      v.str(b.name, 'Nom', { min: 2, max: 100 }), custPhone, v.str(b.commune, 'Commune', { max: 60 }), v.str(b.address, 'Adresse', { min: 3, max: 300 }));
    ctx.status = 201;
    return r;
  });

  // Suivi de commande pour le client : lien secret (aucune donnée personnelle renvoyée)
  app.get('/api/public/track/:token', async (ctx) => {
    limit(`track:${clientIp(ctx.req)}`, 60, 60_000);
    const r = await fn('fn_public_track', typeof ctx.params.token === 'string' ? ctx.params.token.slice(0, 40) : '');
    if (!r) throw new HttpError(404, 'not_found', 'Suivi introuvable ou expiré');
    return { ...r, contact_phone: cfg.contactPhone };
  });

  // Demande sur les données personnelles (accès, correction, suppression, opposition) : sans connexion
  app.post('/api/public/data-request', async (ctx) => {
    limit(`datareq:${clientIp(ctx.req)}`, 5, 3600_000);
    const b = ctx.body;
    const id = await fn('fn_data_request_create', v.oneOf(b.kind, ['access', 'rectification', 'erasure', 'opposition'], 'Type de demande'),
      v.str(b.name, 'Nom', { min: 2, max: 100 }), v.phone(b.phone), v.optStr(b.message, 'Message', 1000));
    ctx.status = 201;
    return { id, message: 'Demande reçue. Nous vous répondrons sous 30 jours, après vérification de votre identité par un appel.' };
  });

  // Pièce d'identité ajoutée plus tard (vendeur ou fournisseur), nécessaire avant le premier retrait
  app.post('/api/me/identity', guard(WALLET_ROLES, async (ctx) => {
    await fn('fn_set_identity_doc', ctx.user.id, v.str(ctx.body.identity_doc, 'Pièce d\'identité', { min: 4, max: 60 }));
  }));

  // Vérification d'identité (KYC) : images de la pièce, visibles du propriétaire et des administrateurs seulement
  const KYC_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];
  app.get('/api/me/identity', guard(KYC_ROLES, async (ctx) => (await q('SELECT fn_my_identity($1) AS r', [ctx.user.id]))[0].r));
  app.post('/api/me/identity/image', guard(KYC_ROLES, async (ctx) => {
    limit(`kyc:${ctx.user.id}`, 30, 3600_000);
    const { mime, buf } = parseImage(ctx.body.image);
    await fn('fn_identity_image_set', ctx.user.id, v.oneOf(ctx.body.side, ['front', 'back', 'selfie'], 'Côté'), v.oneOf(ctx.body.doc_type || 'cni', ['cni', 'passeport', 'autre'], 'Type de pièce'), mime, buf);
  }), { maxBody: MAX_PROOF_BODY });
  app.post('/api/me/identity/submit', guard(KYC_ROLES, async (ctx) => { await fn('fn_identity_submit', ctx.user.id); }));
  app.get('/api/identity/:id/:side', guard(ANY_ROLE, async (ctx) => {
    const rows = await q('SELECT * FROM fn_identity_image_get($1, $2, $3)', [ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), v.oneOf(ctx.params.side, ['front', 'back', 'selfie'], 'Côté')]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Image introuvable');
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'no-store';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  }));

  // =========================================================================
  // Profil (tous les rôles) : nom, photo, mot de passe, numéro de versement
  // =========================================================================
  app.get('/api/me/profile', guard(ANY_ROLE, async (ctx) => {
    const [u] = await q(`SELECT full_name, phone, email, (email_verified_at IS NOT NULL) AS email_verified, role, team, payout_method, payout_phone, identity_verified, created_at,
        EXISTS (SELECT 1 FROM avatars a WHERE a.user_id = users.id) AS has_avatar FROM users WHERE id = $1`, [ctx.user.id]);
    return { id: ctx.user.id, name: u.full_name, phone: u.phone, email: u.email, email_verified: u.email_verified, email_enabled: (cfg.email?.provider || 'simulated') !== 'simulated', role: u.role, team: u.team, has_avatar: u.has_avatar,
      identity_verified: u.identity_verified, created_at: u.created_at,
      payout: u.payout_phone ? { method: u.payout_method, phone: u.payout_phone } : null };
  }));
  app.post('/api/me/profile', guard(ANY_ROLE, async (ctx) => {
    await fn('fn_update_profile', ctx.user.id, v.str(ctx.body.name, 'Nom', { min: 2, max: 100 }));
  }));
  app.post('/api/me/password', guard(ANY_ROLE, async (ctx) => {
    limit(`pwchg:${ctx.user.id}`, 5, 900_000);
    const b = ctx.body;
    await requirePassword(ctx, b.current);
    const pwErr = passwordProblem(b.next);
    if (pwErr) throw new HttpError(400, 'weak_password', pwErr);
    if (b.next === b.current) throw new HttpError(400, 'invalid_input', 'Le nouveau mot de passe doit être différent de l\'ancien');
    await fn('fn_set_password', ctx.user.id, await hashPassword(b.next), tokenHash(ctx.token));
  }));
  app.post('/api/me/payout/change', guard(WALLET_ROLES, async (ctx) => {
    limit(`payout:${ctx.user.id}`, 5, 3600_000);
    const b = ctx.body;
    await requirePassword(ctx, b.password);
    await fn('fn_change_payout', ctx.user.id, v.oneOf(b.method, ['orange_money', 'mtn_momo'], 'Opérateur'), v.phone(b.phone, 'Numéro de versement'));
  }));
  app.post('/api/me/avatar', guard(ANY_ROLE, async (ctx) => {
    limit(`avatar:${ctx.user.id}`, 20, 3600_000);
    const { mime, buf } = parseImage(ctx.body.image);
    if (buf.length > 140_000) throw new HttpError(413, 'too_large', 'Photo trop lourde');
    await fn('fn_avatar_set', ctx.user.id, mime, buf);
  }), { maxBody: 260_000 });
  app.post('/api/me/avatar/delete', guard(ANY_ROLE, async (ctx) => { await fn('fn_avatar_delete', ctx.user.id); }));
  app.get('/api/users/:id/avatar', guard(ANY_ROLE, async (ctx) => {
    const rows = await q('SELECT * FROM fn_avatar_get($1, $2)', [ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur')]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Pas de photo');
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'private, no-cache';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  }));

  // =========================================================================
  // Assistant d'aide (réponses écrites à l'avance, aucune donnée enregistrée) et messagerie avec l'équipe
  // =========================================================================
  // Les textes légaux sont lus DANS l'application (fenêtre de lecture), y compris avant la connexion : ils doivent rester accessibles pour consentir
  const legalPages = createLegal(cfg);
  app.get('/api/public/legal', async () => ({ pages: LEGAL_PAGES.map(([slug, title]) => ({ slug, title })), version: cfg.legal.version }));
  app.get('/api/public/legal/:slug', async (ctx) => {
    const page = /^[a-z-]+$/.test(ctx.params.slug) ? legalPages.content(ctx.params.slug) : null;
    if (!page) throw new HttpError(404, 'not_found', 'Page introuvable');
    return page;
  });
  // L'assistant est réservé aux personnes connectées
  app.post('/api/assistant', guard(ANY_ROLE, async (ctx) => {
    limit(`bot:${ctx.user.id}`, 60, 600_000);
    if (ctx.body.topic) { const t = topic(ctx.user.role, v.str(ctx.body.topic, 'Sujet', { min: 1, max: 60 })); if (!t) throw new HttpError(404, 'not_found', 'Sujet introuvable'); return t; }
    return answer(ctx.user.role, v.str(ctx.body.question, 'Question', { min: 2, max: 300 }));
  }));
  app.get('/api/assistant/topics', guard(ANY_ROLE, async (ctx) => ({ topics: topics(ctx.user.role) })));
  app.get('/api/assistant/suggestions', guard(ANY_ROLE, async (ctx) => ({ suggestions: suggestions(ctx.user.role) })));

  app.get('/api/support', guard(ANY_ROLE, async (ctx) => {
    const [t] = await q(`SELECT id, status, unread_user FROM support_threads WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [ctx.user.id]);
    if (!t) return { messages: [], unread: false };
    const messages = await q('SELECT id, sender, body, created_at FROM support_messages WHERE thread_id = $1 ORDER BY id LIMIT 200', [t.id]);
    if (t.unread_user && ctx.query.read === '1') await fn('fn_support_mark_read', ctx.user.id);
    return { messages, unread: t.unread_user };
  }));
  app.post('/api/support', guard(ANY_ROLE, async (ctx) => {
    limit(`support:${ctx.user.id}`, 30, 3600_000);
    await fn('fn_support_post', ctx.user.id, v.str(ctx.body.body, 'Message', { min: 1, max: 1000 }));
    ctx.status = 201;
  }));
  // visiteur sans compte (mot de passe oublié, urgence) : réponse envoyée par message sur son numéro
  // =========================================================================
  // Portefeuille et retraits (vendeur, fournisseur, agent, chef, livreur)
  // =========================================================================
  async function subscriptionInfo(id) {
    const [st] = await q(`SELECT (SELECT value FROM settings WHERE key='subscription_monthly')::bigint AS monthly, (SELECT value FROM settings WHERE key='subscription_required')::int AS required,
        (SELECT value FROM settings WHERE key='subscription_trial_days')::int AS trial_days, (SELECT paid_until FROM seller_subscriptions WHERE seller_id = $1) AS paid_until,
        (SELECT created_at FROM users WHERE id = $1) AS created_at`, [id]);
    const trialEnd = new Date(new Date(st.created_at).getTime() + st.trial_days * 86400_000);
    return { monthly: Number(st.monthly), required: st.required === 1, paid_until: st.paid_until, trial_until: trialEnd.toISOString(),
      active: !(st.required === 1 && Number(st.monthly) > 0) || (st.paid_until && new Date(st.paid_until) > new Date()) || trialEnd > new Date() };
  }
  app.get('/api/wallet', guard(WALLET_ROLES, async (ctx) => {
    const id = ctx.user.id;
    const [bal] = await q(`SELECT COALESCE(sum(amount) FILTER (WHERE available_at <= now()),0)::bigint AS available,
        COALESCE(sum(amount) FILTER (WHERE available_at > now()),0)::bigint AS pending FROM wallet_entries WHERE user_id = $1`, [id]);
    const { limit: l, offset } = page(ctx.query);
    return {
      ...bal,
      entries: await q(`SELECT id, kind, amount, description, available_at, created_at, (available_at > now()) AS locked
        FROM wallet_entries WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [id, l, offset]),
      withdrawals: await q(`SELECT id, amount, method, account_number, status, payment_ref, proof_id, created_at, decided_at FROM withdrawals
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      payout: (await q('SELECT payout_method AS method, payout_phone AS phone FROM users WHERE id = $1', [id]))[0],
      min_withdrawal: Number((await q(`SELECT value FROM settings WHERE key = 'min_withdrawal'`))[0].value),
      role: ctx.user.role,
      reserved: Number((await q(`SELECT COALESCE(sum(amount),0)::bigint AS r FROM withdrawals WHERE user_id = $1 AND status = 'requested' AND NOT debited`, [id]))[0].r),
      subscription: ctx.user.role === 'seller' ? await subscriptionInfo(id) : null,
      identity_verified: ctx.user.identity_verified,
      identity_submitted: !!(await q('SELECT identity_doc FROM users WHERE id = $1', [id]))[0]?.identity_doc,
      kyc_status: (await q('SELECT status, reject_reason FROM identity_documents WHERE user_id = $1', [id]))[0] || { status: 'none' }
    };
  }));

  app.post('/api/withdrawals', guard(WALLET_ROLES, async (ctx) => {
    limit(`wd:${ctx.user.id}`, 5, 3600_000);
    // le versement part toujours vers le numéro enregistré : on n'accepte plus de numéro dans la demande
    const id = await fn('fn_withdrawal_request', ctx.user.id, v.int(ctx.body.amount, 'Montant', { min: 1, max: 1e10 }));
    ctx.status = 201;
    return { id, status: 'requested', message: 'Demande envoyée. L\'administration la vérifie puis envoie l\'argent avec une capture du transfert ; le montant est débité à ce moment-là.' };
  }));

  // Numéro de versement : à définir une seule fois (mot de passe demandé) ; ensuite seule l'administration le modifie
  app.post('/api/me/payout', guard(WALLET_ROLES, async (ctx) => {
    limit(`payout:${ctx.user.id}`, 5, 3600_000);
    const b = ctx.body;
    const rows = await q('SELECT * FROM fn_login_lookup($1)', [ctx.user.phone]);
    const pw = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
    if (!rows.length || !(await verifyPassword(pw, rows[0].password_hash))) throw new HttpError(403, 'bad_password', 'Mot de passe incorrect');
    await fn('fn_set_payout', ctx.user.id, v.oneOf(b.method, ['orange_money', 'mtn_momo'], 'Opérateur'), v.phone(b.phone, 'Numéro de versement'));
    return { ok: true };
  }));

  // =========================================================================
  // Captures d'écran de preuve (admin : retrait payé ; livreur : paiement du client, reversement)
  // =========================================================================
  const PROOF_ROLE = { withdrawal_payment: 'admin', order_payment: 'courier', remittance: 'courier' };
  app.post('/api/proofs', guard(['admin', 'courier'], async (ctx) => {
    limit(`proof:${ctx.user.id}`, 60, 3600_000);
    const kind = v.oneOf(ctx.body.kind, Object.keys(PROOF_ROLE), 'Type de preuve');
    if (PROOF_ROLE[kind] !== ctx.user.role) throw new HttpError(403, 'forbidden', 'Action non autorisée pour votre rôle');
    const { mime, buf } = parseImage(ctx.body.image);
    ctx.status = 201;
    return { id: await fn('fn_proof_create', ctx.user.id, kind, mime, buf) };
  }), { maxBody: MAX_PROOF_BODY });

  // Affichage d'une capture : administrateur, auteur, ou bénéficiaire du retrait (droits vérifiés dans la base)
  app.get('/api/proofs/:id', guard(null, async (ctx) => {
    const rows = await q('SELECT * FROM fn_proof_get($1, $2)', [ctx.user.id, v.uuid(ctx.params.id, 'Image')]);
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'private, max-age=300';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  }));

  // =========================================================================
  // FOURNISSEUR : ne voit jamais le vendeur, le client ni les prix de vente
  // =========================================================================
  const SUP = ['supplier'];
  app.get('/api/supplier/products', guard(SUP, async (ctx) => ({
    products: await q(`SELECT id, name, description, supplier_price, storage, stock_qty, reserved_qty, status, created_at
        FROM products WHERE supplier_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [ctx.user.id]),
    arrivals: await q(`SELECT a.id, p.name AS product_name, a.announced_qty, a.counted_qty, a.created_at, a.counted_at
        FROM arrivals a JOIN products p ON p.id = a.product_id WHERE p.supplier_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [ctx.user.id])
  })));

  app.post('/api/supplier/products', guard(SUP, async (ctx) => {
    const b = ctx.body;
    const id = await fn('fn_supplier_add_product', ctx.user.id, v.str(b.name, 'Nom du produit', { min: 2, max: 120 }), v.optStr(b.description, 'Description', 1000),
      v.int(b.supplier_price, 'Prix fournisseur', { min: 1, max: 1e9 }), v.oneOf(b.storage, ['wallindirain', 'supplier'], 'Stockage'),
      b.storage === 'supplier' ? v.int(b.stock_qty ?? 0, 'Quantité', { min: 0, max: 1e6 }) : 0);
    ctx.status = 201;
    return { id, message: 'Produit proposé. Il sera visible des vendeurs après validation.' };
  }));

  app.post('/api/supplier/products/:id/arrival', guard(SUP, async (ctx) => {
    const id = await fn('fn_supplier_announce_arrival', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.int(ctx.body.qty, 'Quantité', { min: 1, max: 100000 }));
    ctx.status = 201;
    return { id };
  }));

  app.post('/api/supplier/products/:id/stock', guard(SUP, async (ctx) => {
    await fn('fn_supplier_set_stock', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.int(ctx.body.qty, 'Quantité', { min: 0, max: 1e6 }));
  }));

  // Colis à préparer : uniquement la référence WLD, le produit et la quantité
  app.get('/api/supplier/orders', guard(SUP, async (ctx) => ({
    orders: await q(`SELECT o.ref, p.name AS product_name, o.qty, o.status, o.created_at,
          CASE WHEN p.storage = 'supplier' THEN o.qty_from_catalog ELSE 0 END AS qty_to_prepare
        FROM orders o JOIN products p ON p.id = o.product_id
        WHERE p.supplier_id = $1 AND o.status IN ('confirmed','assigned','picked_up','on_the_way','delivered','return_pending','returned')
        ORDER BY o.created_at DESC LIMIT 200`, [ctx.user.id])
  })));

  // =========================================================================
  // VENDEUR : ne voit jamais le fournisseur ni le prix fournisseur
  // =========================================================================
  const SEL = ['seller'];
  app.get('/api/seller/catalog', guard(SEL, async (ctx) => {
    const [{ call_fee, max_fee }] = await q(`SELECT (SELECT value FROM settings WHERE key='call_fee') AS call_fee, (SELECT max(fee) FROM delivery_rates WHERE active) AS max_fee`);
    return {
      products: await q(`SELECT p.id, p.name, p.description,
            (p.supplier_price + p.margin_unit) AS vendor_price,
            (p.supplier_price + p.margin_unit + $2 + $3 + (SELECT value FROM settings WHERE key = 'fee_unit')) AS min_price,
            (p.storage = 'wallindirain') AS can_prepay,
            GREATEST(p.stock_qty - p.reserved_qty, 0) AS available,
            sp.sale_price, COALESCE(ss.qty, 0) AS my_stock, COALESCE(ss.reserved_qty, 0) AS my_reserved, l.code AS link_code
          FROM products p
          LEFT JOIN seller_prices sp ON sp.product_id = p.id AND sp.seller_id = $1
          LEFT JOIN seller_stock ss ON ss.product_id = p.id AND ss.seller_id = $1
          LEFT JOIN seller_links l ON l.product_id = p.id AND l.seller_id = $1
          WHERE p.status = 'approved' AND p.deleted_at IS NULL ORDER BY p.name`, [ctx.user.id, call_fee, max_fee]),
      call_fee, max_delivery_fee: max_fee
    };
  }));

  app.post('/api/seller/prices', guard(SEL, async (ctx) => {
    await fn('fn_seller_set_price', ctx.user.id, v.uuid(ctx.body.product_id, 'Produit'), v.int(ctx.body.price, 'Prix', { min: 1, max: 1e10 }));
  }));
  app.post('/api/seller/links', guard(SEL, async (ctx) => ({ code: await fn('fn_seller_create_link', ctx.user.id, v.uuid(ctx.body.product_id, 'Produit')) })));
  app.post('/api/seller/stock', guard(SEL, async (ctx) =>
    fn('fn_seller_buy_stock', ctx.user.id, v.uuid(ctx.body.product_id, 'Produit'), v.int(ctx.body.qty, 'Quantité', { min: 1, max: 100000 }))));

  app.post('/api/seller/orders', guard(SEL, async (ctx) => {
    const b = ctx.body;
    const own = b.product_id == null || b.product_id === '';
    const r = await fn('fn_seller_create_order', ctx.user.id, own ? null : v.uuid(b.product_id, 'Produit'),
      own ? v.str(b.own_product_name, 'Nom du produit', { min: 2, max: 120 }) : null,
      b.unit_price == null || b.unit_price === '' ? null : v.int(b.unit_price, 'Prix unitaire', { min: 1, max: 1e10 }),
      v.int(b.qty, 'Quantité', { min: 1, max: 100 }), v.str(b.customer_name, 'Nom du client', { min: 2, max: 100 }), v.phone(b.customer_phone, 'Numéro du client'),
      v.str(b.commune, 'Quartier ou ville', { max: 60 }), v.str(b.address, 'Adresse', { min: 3, max: 300 }), v.optStr(b.note, 'Note', 300), b.already_confirmed === true);
    ctx.status = 201;
    return r;
  }));

  // ----- Import Google Sheet / CSV : une ligne = une commande (les lignes déjà importées sont ignorées) -----
  app.get('/api/seller/sheet', guard(SEL, async (ctx) => {
    const [s] = await q('SELECT sheet_id, gid FROM seller_sheets WHERE seller_id = $1', [ctx.user.id]);
    return { sheet: s ? { url: `https://docs.google.com/spreadsheets/d/${s.sheet_id}/edit#gid=${s.gid}` } : null };
  }));
  app.post('/api/seller/sheet', guard(SEL, async (ctx) => {
    if (!ctx.body.url) { await fn('fn_seller_set_sheet', ctx.user.id, null, null); return { sheet: null }; }
    const { id, gid } = parseSheetUrl(ctx.body.url);
    await fn('fn_seller_set_sheet', ctx.user.id, id, gid);
    return { sheet: { url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}` } };
  }));
  app.post('/api/seller/import', guard(SEL, async (ctx) => {
    limit(`import:${ctx.user.id}`, 10, 3600_000);
    let text;
    if (typeof ctx.body.csv === 'string' && ctx.body.csv.trim()) text = ctx.body.csv.slice(0, 1_000_000);
    else {
      const [s] = await q('SELECT sheet_id, gid FROM seller_sheets WHERE seller_id = $1', [ctx.user.id]);
      if (!s) throw new HttpError(400, 'invalid_input', 'Enregistrez d\'abord le lien de votre Google Sheet, ou collez votre tableau en CSV');
      text = await (app.fetchSheet || fetchSheetCsv)({ id: s.sheet_id, gid: s.gid });
    }
    const rows = mapRows(parseCsv(text));
    const catalog = await q(`SELECT p.id, lower(p.name) AS n FROM products p WHERE p.status = 'approved' AND p.deleted_at IS NULL`);
    const zones = await q('SELECT commune FROM delivery_rates WHERE active');
    const zoneOf = (z) => zones.find((x) => x.commune.toLowerCase() === z.toLowerCase())?.commune;
    const other = zones.find((x) => x.commune === 'Autre quartier / ville')?.commune;
    const out = { created: 0, duplicates: 0, errors: [] };
    for (const r of rows) {
      try {
        const phone = phone9(r.phone);
        if (!/^[0-9]{9}$/.test(phone)) throw new Error('Téléphone invalide (9 chiffres attendus)');
        let zone = zoneOf(r.zone), address = r.address;
        if (!zone) { if (!other) throw new Error(`Zone « ${r.zone || 'vide'} » non desservie`); zone = other; address = r.zone ? `${r.zone}, ${r.address}` : r.address; }
        const prod = catalog.find((c) => c.n === r.product.toLowerCase());
        const price = parsePrice(r.price);
        const qty = r.qty ? Number(r.qty.replace(/\D/g, '')) : 1;
        if (!prod && !price) throw new Error(`Produit « ${r.product} » absent du catalogue : indiquez un prix pour le traiter comme votre propre produit`);
        const res = await fn('fn_seller_import_order', ctx.user.id, rowHash(ctx.user.id, r), prod ? prod.id : null, prod ? null : r.product, price, qty,
          r.name, phone, zone, address.slice(0, 300), r.note ? r.note.slice(0, 300) : null, isYes(r.confirmed));
        if (res.duplicate) out.duplicates++; else out.created++;
      } catch (e) { out.errors.push({ line: r.line, message: e.message?.replace(/^[a-z_]+\|/, '') || 'Erreur' }); }
    }
    return out;
  }));

  const SELLER_ORDER_COLS = `o.id, o.ref, o.status, o.formula, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total,
      o.customer_name, o.customer_phone, o.commune, o.address, o.delivery_fee, o.call_fee, o.call_attempts, o.failure_reason, o.return_cause,
      o.created_at, o.delivered_at, o.track_token, o.risk_flag,
      (SELECT incidents FROM risky_customers r WHERE r.customer_phone = o.customer_phone) AS risk_incidents,
      (o.sale_total - o.delivery_fee - o.call_fee - o.qty_from_catalog * o.seller_unit_price) AS expected_gain,
      (o.status = 'new' AND o.call_attempts = 0 AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.order_id = o.id)) AS cancellable`;

  app.get('/api/seller/orders', guard(SEL, async (ctx) => {
    const { limit: l, offset } = page(ctx.query);
    const st = ctx.query.status ? v.str(ctx.query.status, 'Statut', { max: 20 }) : null;
    return { orders: await q(`SELECT ${SELLER_ORDER_COLS} FROM orders o LEFT JOIN products p ON p.id = o.product_id
        WHERE o.seller_id = $1 AND ($4::text IS NULL OR o.status::text = $4) ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`, [ctx.user.id, l, offset, st]) };
  }));

  // Tableau de bord du vendeur : résultats de ses commandes, gains par semaine, produits les plus rentables
  app.get('/api/seller/stats', guard(SEL, async (ctx) => {
    const days = [7, 30, 90, 365].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30;
    const [t] = await q(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
        count(*) FILTER (WHERE status IN ('failed','return_pending','returned','refused'))::int AS failed,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way'))::int AS in_progress,
        COALESCE(sum(sale_total) FILTER (WHERE status = 'delivered'), 0)::bigint AS sales
      FROM orders WHERE seller_id = $1 AND created_at >= now() - make_interval(days => $2)`, [ctx.user.id, days]);
    const done = t.delivered + t.failed;
    const weeks = await q(`SELECT to_char(date_trunc('week', w.created_at), 'YYYY-MM-DD') AS week, sum(w.amount)::bigint AS gain
        FROM wallet_entries w WHERE w.user_id = $1 AND w.kind = 'seller_gain' AND w.created_at >= date_trunc('week', now()) - interval '7 weeks'
        GROUP BY 1 ORDER BY 1`, [ctx.user.id]);
    const products = await q(`SELECT COALESCE(p.name, o.own_product_name) AS name, count(*)::int AS delivered, COALESCE(sum(w.amount), 0)::bigint AS gain
        FROM orders o LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN wallet_entries w ON w.order_id = o.id AND w.user_id = $1 AND w.kind = 'seller_gain'
        WHERE o.seller_id = $1 AND o.status = 'delivered' AND o.created_at >= now() - make_interval(days => $2)
        GROUP BY 1 ORDER BY gain DESC, delivered DESC LIMIT 5`, [ctx.user.id, days]);
    const failedByCause = await q(`SELECT COALESCE(return_cause::text, 'unknown') AS cause, count(*)::int AS n FROM orders
        WHERE seller_id = $1 AND status IN ('failed','return_pending','returned','refused') AND created_at >= now() - make_interval(days => $2) GROUP BY 1 ORDER BY n DESC`, [ctx.user.id, days]);
    return { days, ...t, delivery_rate: done ? Math.round((t.delivered * 1000) / done) / 10 : null, weeks, products, failed_by_cause: failedByCause };
  }));

  app.get('/api/seller/ranking', guard(SEL, async (ctx) => (await q('SELECT fn_seller_ranking($1) AS r', [ctx.user.id]))[0].r));
  app.post('/api/seller/ranking-visibility', guard(SEL, async (ctx) => { await fn('fn_set_ranking_visibility', ctx.user.id, ctx.body.hidden === true); }));
  // Liste « pour bien démarrer » du vendeur : ce qui est fait, ce qui reste à faire
  app.get('/api/seller/start', guard(SEL, async (ctx) => {
    const [r] = await q(`SELECT
        u.identity_verified AS identity, (u.payout_phone IS NOT NULL) AS payout,
        EXISTS (SELECT 1 FROM seller_prices p WHERE p.seller_id = u.id) AS price,
        EXISTS (SELECT 1 FROM seller_links l WHERE l.seller_id = u.id) AS link,
        EXISTS (SELECT 1 FROM orders o WHERE o.seller_id = u.id) AS order_done
      FROM users u WHERE u.id = $1`, [ctx.user.id]);
    return { steps: { identity: r.identity, payout: r.payout, price: r.price, link: r.link, order: r.order_done }, complete: Object.values(r).every(Boolean) };
  }));

  app.get('/api/me/referral', guard(['seller', 'supplier'], async (ctx) => (await q('SELECT fn_my_referral($1) AS r', [ctx.user.id]))[0].r));

  app.get('/api/seller/orders/:id', guard(SEL, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Commande');
    const [order] = await q(`SELECT ${SELLER_ORDER_COLS} FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = $1 AND o.seller_id = $2`, [id, ctx.user.id]);
    if (!order) throw new HttpError(404, 'not_found', 'Commande introuvable');
    return { order,
      // le nom de l'agent n'est jamais montré au vendeur (protection du personnel) : seulement le call center
      calls: await q('SELECT call_center, result, note, at FROM calls WHERE order_id = $1 ORDER BY id', [id]),
      history: await q('SELECT to_status, note, at FROM order_history WHERE order_id = $1 ORDER BY id', [id]) };
  }));

  app.post('/api/seller/orders/:id/cancel', guard(SEL, async (ctx) => { await fn('fn_seller_cancel_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));

  // =========================================================================
  // CALL CENTER (agent et chef) : ni gains ni prix fournisseur
  // =========================================================================
  const CALL = ['agent', 'call_chief'];
  const CALL_COLS = `o.id, o.ref, o.status, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total, o.customer_name, o.customer_phone,
      o.commune, o.address, o.note, o.risk_flag, o.call_attempts, o.escalated, o.created_at, o.locked_by,
      (SELECT incidents FROM risky_customers r WHERE r.customer_phone = o.customer_phone) AS risk_incidents,
      (SELECT last_reason FROM risky_customers r WHERE r.customer_phone = o.customer_phone) AS risk_reason`;

  app.get('/api/calls/queue', guard(CALL, async (ctx) => ({
    orders: await q(`SELECT ${CALL_COLS} FROM orders o LEFT JOIN products p ON p.id = o.product_id
        WHERE o.status = 'new' AND (NOT o.escalated OR $1 = 'call_chief') ORDER BY o.escalated DESC, o.created_at LIMIT 100`, [ctx.user.role])
  })));

  app.get('/api/calls/mine', guard(CALL, async (ctx) => {
    const orders = await q(`SELECT ${CALL_COLS} FROM orders o LEFT JOIN products p ON p.id = o.product_id
        WHERE o.status = 'in_call' AND o.locked_by = $1 ORDER BY o.locked_at`, [ctx.user.id]);
    for (const o of orders) o.calls = await q('SELECT agent_name, call_center, result, note, at FROM calls WHERE order_id = $1 ORDER BY id', [o.id]);
    return { orders };
  }));

  app.post('/api/calls/:id/take', guard(CALL, async (ctx) => { await fn('fn_agent_take_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/calls/:id/log', guard(CALL, async (ctx) =>
    fn('fn_agent_log_call', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.oneOf(ctx.body.result, ['confirmed', 'unreachable', 'refused'], 'Résultat'), v.optStr(ctx.body.note, 'Note', 300))));

  // Chef : affectation aux livreurs
  const CHIEF = ['call_chief', 'admin'];
  app.get('/api/chief/orders', guard(CHIEF, async () => ({
    pickup_alert_hours: await pickupHours(),
    orders: await q(`SELECT ${CALL_COLS}, o.courier_id, cu.full_name AS courier_name, o.failure_reason, o.confirmed_at, ${ASSIGNED_SINCE} AS assigned_since
        FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN users cu ON cu.id = o.courier_id
        WHERE o.status IN ('confirmed','assigned','picked_up','on_the_way','failed','return_pending') ORDER BY o.created_at LIMIT 300`),
    couriers: await q(`SELECT u.id, u.full_name, (SELECT count(*) FROM orders o WHERE o.courier_id = u.id AND o.status IN ('assigned','picked_up','on_the_way'))::int AS open_orders
        FROM users u WHERE u.role = 'courier' AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.full_name`)
  })));
  app.post('/api/chief/orders/:id/assign', guard(CHIEF, async (ctx) => { await fn('fn_chief_assign', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.uuid(ctx.body.courier_id, 'Livreur')); }));
  app.post('/api/chief/orders/:id/return', guard(CHIEF, async (ctx) => { await fn('fn_chief_return_to_warehouse', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/chief/orders/:id/cancel', guard(CHIEF, async (ctx) => { await fn('fn_staff_cancel_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 })); }));

  // =========================================================================
  // LIVREUR : ni prix fournisseur ni gains du vendeur
  // =========================================================================
  const COU = ['courier'];
  app.get('/api/courier/orders', guard(COU, async (ctx) => ({
    orders: await q(`SELECT o.id, o.ref, o.status, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total AS amount_to_collect,
          o.customer_name, o.customer_phone, o.commune, o.address, o.note, o.failure_reason, o.code_attempts, o.created_at,
          o.risk_flag, (SELECT incidents FROM risky_customers r WHERE r.customer_phone = o.customer_phone) AS risk_incidents,
          ${ASSIGNED_SINCE} AS assigned_since, op.method AS payment_method
        FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN order_payments op ON op.order_id = o.id
        WHERE o.courier_id = $1 AND o.status IN ('assigned','picked_up','on_the_way') ORDER BY o.created_at`, [ctx.user.id]),
    pickup_alert_hours: await pickupHours(),
    cash_to_hand_over: Number((await q('SELECT COALESCE(sum(amount),0)::bigint AS s FROM courier_cash_entries WHERE courier_id = $1 AND count_id IS NULL AND remittance_id IS NULL', [ctx.user.id]))[0].s),
    cash_pending_validation: Number((await q('SELECT COALESCE(sum(amount),0)::bigint AS s FROM courier_cash_entries WHERE courier_id = $1 AND count_id IS NULL AND remittance_id IS NOT NULL', [ctx.user.id]))[0].s),
    max_attempts: Number((await q(`SELECT value FROM settings WHERE key = 'code_max_attempts'`))[0].value),
    require_code: Number((await q(`SELECT value FROM settings WHERE key = 'require_delivery_code'`))[0].value) === 1
  })));
  app.post('/api/courier/orders/:id/pickup', guard(COU, async (ctx) => { await fn('fn_courier_pickup', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/courier/orders/:id/depart', guard(COU, async (ctx) => { await fn('fn_courier_depart', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/courier/orders/:id/deliver', guard(COU, async (ctx) => {
    limit(`deliver:${ctx.user.id}`, 30, 600_000);
    // le code n'est exigé que si le réglage « require_delivery_code » vaut 1 (la base refuse alors un code absent ou faux)
    const code = ctx.body.code == null || ctx.body.code === '' ? null : v.str(ctx.body.code, 'Code', { min: 4, max: 4 });
    const r = await fn('fn_courier_deliver', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), code);
    if (!r.ok) {
      throw new HttpError(r.locked ? 423 : 400, r.locked ? 'code_locked' : 'wrong_code',
        r.locked ? 'Trop d\'essais : la livraison est bloquée. Signalez un échec, le chef call center réaffectera la commande.' : `Code incorrect. Il vous reste ${r.remaining} essai(s).`);
    }
    return { ok: true };
  }));
  // Comment le client a payé : espèces, ou transfert avec capture d'écran
  app.post('/api/courier/orders/:id/payment', guard(COU, async (ctx) => {
    limit(`cpay:${ctx.user.id}`, 60, 3600_000);
    const b = ctx.body;
    const method = v.oneOf(b.method, ['cash', 'orange_money', 'mtn_momo'], 'Mode de paiement');
    await fn('fn_courier_declare_payment', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), method,
      method === 'cash' || b.proof_id == null ? null : v.uuid(b.proof_id, 'Capture'), v.optStr(b.reference, 'Référence', 100));
  }));

  // Reversement : encaissements en attente + historique des reversements par transfert
  app.get('/api/courier/cash', guard(COU, async (ctx) => ({
    entries: await q(`SELECT c.order_id, o.ref, c.amount, c.created_at, (c.remittance_id IS NOT NULL) AS in_remittance
        FROM courier_cash_entries c JOIN orders o ON o.id = c.order_id
        WHERE c.courier_id = $1 AND c.count_id IS NULL ORDER BY c.created_at`, [ctx.user.id]),
    remittances: await q(`SELECT id, method, amount, status, received, reference, proof_id, decision_note, created_at, decided_at
        FROM remittances WHERE courier_id = $1 ORDER BY created_at DESC LIMIT 30`, [ctx.user.id])
  })));
  app.post('/api/courier/remit', guard(COU, async (ctx) => {
    limit(`remit:${ctx.user.id}`, 20, 3600_000);
    const b = ctx.body;
    const orders = Array.isArray(b.orders) && b.orders.length ? b.orders.slice(0, 200).map((x) => v.uuid(x, 'Commande')) : null;
    const r = await fn('fn_courier_remit', ctx.user.id, v.oneOf(b.method, ['orange_money', 'mtn_momo'], 'Mode de paiement'),
      v.uuid(b.proof_id, 'Capture'), v.optStr(b.reference, 'Référence', 100), orders);
    ctx.status = 201;
    return r;
  }));

  app.post('/api/courier/orders/:id/fail', guard(COU, async (ctx) => {
    await fn('fn_courier_fail', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.oneOf(ctx.body.reason, ['customer_absent', 'customer_refusal', 'address_not_found', 'other'], 'Motif'));
  }));

  // =========================================================================
  // MAGASINIER : aucune donnée financière
  // =========================================================================
  const WH = ['warehouse', 'admin'];
  app.get('/api/warehouse/arrivals', guard(WH, async () => ({
    arrivals: await q(`SELECT a.id, p.name AS product_name, a.announced_qty, a.created_at FROM arrivals a JOIN products p ON p.id = a.product_id
        WHERE a.counted_qty IS NULL ORDER BY a.created_at`),
    returns: await q(`SELECT o.id, o.ref, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.failure_reason
        FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status = 'return_pending' ORDER BY o.created_at`)
  })));
  app.post('/api/warehouse/arrivals/:id/count', guard(WH, async (ctx) => { await fn('fn_warehouse_count_arrival', ctx.user.id, v.uuid(ctx.params.id, 'Arrivage'), v.int(ctx.body.counted, 'Quantité comptée', { min: 0, max: 1e6 })); }));
  app.post('/api/warehouse/returns/:id', guard(WH, async (ctx) => {
    await fn('fn_warehouse_receive_return', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.oneOf(ctx.body.cause, ['customer_refusal', 'defective', 'damaged_transport'], 'Cause'));
  }));

  // =========================================================================
  // ADMINISTRATEUR
  // =========================================================================
  const ADM = ['admin'];
  const MASKS = { delivery_code: /(Code de livraison : )\d{4}/, withdrawal_code: /(GNF : )\d{6}/, password_reset: /(est )\d{6}/, password_reset_email: /(est )\d{6}/, email_verify: /(est )\d{6}/, temp_password: /(temporaire est : )\S+/ };

  app.get('/api/admin/dashboard', guard(ADM, async () => {
    const [m] = await q(`SELECT
        (SELECT count(*) FROM users WHERE role = 'supplier' AND status = 'pending')::int AS suppliers_pending,
        (SELECT count(*) FROM products WHERE status = 'pending' AND deleted_at IS NULL)::int AS products_pending,
        (SELECT count(*) FROM arrivals WHERE counted_qty IS NULL)::int AS arrivals_pending,
        (SELECT count(*) FROM orders o WHERE o.status = 'assigned' AND (SELECT value::int FROM settings WHERE key = 'pickup_alert_hours') > 0 AND (SELECT max(h.at) FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned') < now() - make_interval(hours => (SELECT value::int FROM settings WHERE key = 'pickup_alert_hours')))::int AS pickups_late,
        (SELECT count(*) FROM withdrawals WHERE status = 'requested')::int AS withdrawals_pending,
        (SELECT count(*) FROM remittances WHERE status = 'pending')::int AS remittances_pending,
        (SELECT COALESCE(sum(amount),0)::bigint FROM courier_cash_entries WHERE count_id IS NULL) AS cash_outstanding,
        (SELECT count(*) FROM orders WHERE status = 'delivered' AND delivered_at::date = now()::date)::int AS delivered_today,
        (SELECT COALESCE(sum(sale_total),0)::bigint FROM orders WHERE status = 'delivered' AND delivered_at::date = now()::date) AS sales_today,
        (SELECT COALESCE(sum(amount),0)::bigint FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001') AS platform_result,
        (SELECT COALESCE(sum(amount),0)::bigint FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000002') AS prepaid_float,
        (SELECT count(*) FROM fn_ledger_check())::int AS ledger_problems`);
    const [dr] = await q(`SELECT count(*)::int AS n FROM data_requests WHERE status = 'open'`);
    const [sp] = await q(`SELECT count(*)::int AS n FROM support_threads WHERE status = 'open' AND unread_admin`);
    return { ...m, data_requests_open: dr.n, support_unread: sp.n, legal_missing: legalMissing(cfg), by_status: await q('SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status') };
  }));

  // Statistiques pour décider : produits, call centers, livreurs, causes de retour
  app.get('/api/admin/stats', guard(ADM, async (ctx) => {
    const days = [7, 30, 90, 365].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30;
    const since = [days];
    const rate = (a, b) => (a + b ? Math.round((a * 1000) / (a + b)) / 10 : null);
    const products = (await q(`SELECT COALESCE(p.name, o.own_product_name) AS name,
          count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          count(*) FILTER (WHERE o.status IN ('failed','return_pending','returned','refused'))::int AS failed,
          COALESCE(sum(o.sale_total) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS sales,
          COALESCE(sum(w.amount), 0)::bigint AS platform_revenue
        FROM orders o LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN wallet_entries w ON w.order_id = o.id AND w.kind = 'platform_revenue'
        WHERE o.created_at >= now() - make_interval(days => $1) GROUP BY 1
        HAVING count(*) FILTER (WHERE o.status IN ('delivered','failed','return_pending','returned','refused')) > 0
        ORDER BY platform_revenue DESC LIMIT 15`, since)).map((r) => ({ ...r, delivery_rate: rate(r.delivered, r.failed) }));
    const callCenters = (await q(`SELECT call_center AS name, count(*)::int AS calls,
          count(*) FILTER (WHERE result = 'confirmed')::int AS confirmed,
          count(*) FILTER (WHERE result = 'unreachable')::int AS unreachable,
          count(*) FILTER (WHERE result = 'refused')::int AS refused
        FROM calls WHERE at >= now() - make_interval(days => $1) GROUP BY 1 ORDER BY confirmed DESC`, since))
      .map((r) => ({ ...r, confirm_rate: r.calls ? Math.round((r.confirmed * 1000) / r.calls) / 10 : null }));
    const couriers = (await q(`SELECT u.full_name AS name,
          count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          count(*) FILTER (WHERE o.status IN ('failed','return_pending','returned','refused'))::int AS failed
        FROM orders o JOIN users u ON u.id = o.courier_id
        WHERE o.created_at >= now() - make_interval(days => $1) GROUP BY u.id, u.full_name ORDER BY delivered DESC LIMIT 20`, since))
      .map((r) => ({ ...r, delivery_rate: rate(r.delivered, r.failed) }));
    const returns = await q(`SELECT return_cause::text AS cause, count(*)::int AS n FROM orders
        WHERE return_cause IS NOT NULL AND created_at >= now() - make_interval(days => $1) GROUP BY 1 ORDER BY n DESC`, since);
    const [tot] = await q(`SELECT count(*)::int AS orders, count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
          COALESCE(sum(sale_total) FILTER (WHERE status = 'delivered'), 0)::bigint AS sales,
          (SELECT COALESCE(sum(amount), 0)::bigint FROM wallet_entries WHERE kind = 'platform_revenue' AND created_at >= now() - make_interval(days => $1)) AS platform_revenue
        FROM orders WHERE created_at >= now() - make_interval(days => $1)`, since);
    return { days, totals: tot, products, call_centers: callCenters, couriers, returns };
  }));

  app.get('/api/admin/users', guard(ADM, async (ctx) => {
    const { limit: l, offset } = page(ctx.query);
    return { users: await q(`SELECT id, role, status, full_name, phone, email, (email_verified_at IS NOT NULL) AS email_verified, team, identity_doc, identity_verified, payout_method, payout_phone, created_at,
          (SELECT d.status FROM identity_documents d WHERE d.user_id = users.id) AS kyc_status,
          EXISTS (SELECT 1 FROM identity_documents d WHERE d.user_id = users.id AND d.back_mime IS NOT NULL) AS kyc_back,
          CASE WHEN role IN ('seller','supplier','agent','call_chief','courier') THEN (SELECT COALESCE(sum(amount),0)::bigint FROM wallet_entries w WHERE w.user_id = users.id) END AS balance
        FROM users WHERE deleted_at IS NULL AND role <> 'system' AND ($1::text IS NULL OR role::text = $1) AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [ctx.query.role || null, ctx.query.status || null, l, offset]) };
  }));
  app.post('/api/admin/users', guard(ADM, async (ctx) => {
    const b = ctx.body;
    const pwErr = passwordProblem(b.password);
    if (pwErr) throw new HttpError(400, 'weak_password', pwErr);
    const id = await fn('fn_admin_create_staff', ctx.user.id, v.phone(b.phone), v.str(b.name, 'Nom', { min: 2, max: 100 }),
      v.oneOf(b.role, ['admin', 'agent', 'call_chief', 'courier', 'warehouse'], 'Rôle'), await hashPassword(b.password), v.optStr(b.team, 'Call center', 80));
    ctx.status = 201;
    return { id };
  }));
  app.get('/api/admin/data-requests', guard(ADM, async () => ({
    requests: await q(`SELECT id, kind, full_name, phone, message, status, note, created_at, handled_at FROM data_requests
        ORDER BY (status = 'open') DESC, created_at DESC LIMIT 200`) })));
  app.post('/api/admin/data-requests/:id/close', guard(ADM, async (ctx) => {
    await fn('fn_admin_close_data_request', ctx.user.id, v.uuid(ctx.params.id, 'Demande'), v.oneOf(ctx.body.status, ['done', 'rejected'], 'Statut'), v.str(ctx.body.note, 'Note', { min: 3, max: 500 }));
  }));
  app.post('/api/admin/users/:id/anonymize', guard(ADM, async (ctx) => { await fn('fn_admin_anonymize_user', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur')); }));
  app.post('/api/admin/users/:id/status', guard(ADM, async (ctx) => { await fn('fn_admin_set_user_status', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), v.oneOf(ctx.body.status, ['active', 'suspended', 'pending'], 'Statut')); }));
  app.post('/api/admin/users/:id/update', guard(ADM, async (ctx) => {
    const b = ctx.body;
    const hasPayout = b.payout_phone != null && b.payout_phone !== '';
    await fn('fn_admin_update_user', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), v.str(b.name, 'Nom', { min: 2, max: 100 }), v.optStr(b.team, 'Call center', 80),
      hasPayout ? v.oneOf(b.payout_method, ['orange_money', 'mtn_momo'], 'Opérateur de versement') : null, hasPayout ? v.phone(b.payout_phone, 'Numéro de versement') : null);
  }));
  // Mot de passe temporaire généré par le serveur, affiché une seule fois à l'administrateur
  app.post('/api/admin/users/:id/reset-password', guard(ADM, async (ctx) => {
    const temp = tempPassword();
    await fn('fn_admin_reset_password', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), await hashPassword(temp));
    return { temporary_password: temp };
  }));
  app.get('/api/admin/support', guard(ADM, async () => ({
    threads: await q(`SELECT t.id, t.full_name, t.phone, t.status, t.unread_admin, t.user_id, t.last_message_at,
        (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body
        FROM support_threads t ORDER BY (t.status = 'open') DESC, t.unread_admin DESC, t.last_message_at DESC LIMIT 100`) })));
  app.get('/api/admin/support/:id', guard(ADM, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Conversation');
    const [t] = await q('SELECT id, full_name, phone, status, user_id FROM support_threads WHERE id = $1', [id]);
    if (!t) throw new HttpError(404, 'not_found', 'Conversation introuvable');
    const [acct] = await q(`SELECT id, role, full_name FROM users WHERE phone = $1 AND deleted_at IS NULL AND role <> 'system'`, [t.phone]);
    return { thread: t, account: acct || null, messages: await q('SELECT id, sender, body, created_at FROM support_messages WHERE thread_id = $1 ORDER BY id', [id]) };
  }));
  app.post('/api/admin/support/:id/reply', guard(ADM, async (ctx) => { await fn('fn_support_reply', ctx.user.id, v.uuid(ctx.params.id, 'Conversation'), v.str(ctx.body.body, 'Réponse', { min: 1, max: 1000 })); }));
  app.post('/api/admin/support/:id/close', guard(ADM, async (ctx) => { await fn('fn_support_close', ctx.user.id, v.uuid(ctx.params.id, 'Conversation')); }));
  // mot de passe oublié : mot de passe temporaire envoyé par message au numéro du compte (jamais affiché dans la conversation)
  app.post('/api/admin/support/:id/temp-password', guard(ADM, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Conversation');
    const [t] = await q('SELECT phone FROM support_threads WHERE id = $1', [id]);
    if (!t) throw new HttpError(404, 'not_found', 'Conversation introuvable');
    const [acct] = await q(`SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL AND role <> 'system'`, [t.phone]);
    if (!acct) throw new HttpError(404, 'not_found', 'Aucun compte avec ce numéro');
    const temp = tempPassword();
    await fn('fn_admin_send_temp_password', ctx.user.id, acct.id, await hashPassword(temp), temp, id);
    return cfg.showTestCodes ? { temporary_password: temp } : { ok: true };
  }));
  // remise à zéro des activités : confirmation écrite + mot de passe de l'administrateur
  app.post('/api/admin/reset-activity', guard(ADM, async (ctx) => {
    limit(`reset:${ctx.user.id}`, 3, 3600_000);
    await requirePassword(ctx, ctx.body.password);
    return fn('fn_admin_reset_activity', ctx.user.id, typeof ctx.body.confirm === 'string' ? ctx.body.confirm : '');
  }));
  app.post('/api/admin/users/:id/unlock', guard(ADM, async (ctx) => { await fn('fn_admin_unlock_user', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur')); }));
  app.post('/api/admin/users/:id/reject-identity', guard(ADM, async (ctx) => { await fn('fn_admin_reject_identity', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 300 })); }));
  app.post('/api/admin/users/:id/verify', guard(ADM, async (ctx) => { await fn('fn_admin_verify_identity', ctx.user.id, v.uuid(ctx.params.id, 'Utilisateur'), v.bool(ctx.body.verified, 'Vérification')); }));

  app.get('/api/admin/products', guard(ADM, async (ctx) => ({
    products: await q(`SELECT p.id, p.name, p.description, p.supplier_price, p.margin_unit, p.storage, p.stock_qty, p.reserved_qty, p.status, p.created_at, u.full_name AS supplier_name
        FROM products p JOIN users u ON u.id = p.supplier_id WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.status::text = $1) ORDER BY p.created_at DESC LIMIT 300`, [ctx.query.status || null])
  })));
  app.post('/api/admin/products/:id/review', guard(ADM, async (ctx) => {
    await fn('fn_admin_review_product', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.bool(ctx.body.approve, 'Décision'),
      ctx.body.margin_bps == null ? null : v.int(ctx.body.margin_bps, 'Marge', { min: 0, max: 10000 }));
  }));
  app.post('/api/admin/products/:id/margin', guard(ADM, async (ctx) => { await fn('fn_admin_set_product_margin', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.int(ctx.body.margin_bps, 'Marge', { min: 0, max: 10000 })); }));

  app.get('/api/admin/orders', guard(ADM, async (ctx) => {
    const { limit: l, offset } = page(ctx.query);
    return { orders: await q(`SELECT o.id, o.ref, o.status, o.formula, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total, o.customer_name, o.customer_phone,
          o.commune, s.full_name AS seller_name, su.full_name AS supplier_name, cu.full_name AS courier_name, o.risk_flag, o.call_attempts, o.created_at, o.delivered_at
        FROM orders o LEFT JOIN products p ON p.id = o.product_id JOIN users s ON s.id = o.seller_id LEFT JOIN users su ON su.id = p.supplier_id LEFT JOIN users cu ON cu.id = o.courier_id
        WHERE ($3::text IS NULL OR o.status::text = $3) AND ($4::text IS NULL OR o.ref = $4 OR o.customer_phone = $4)
        ORDER BY o.created_at DESC LIMIT $1 OFFSET $2`, [l, offset, ctx.query.status || null, ctx.query.search || null]) };
  }));
  app.get('/api/admin/orders/:id', guard(ADM, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Commande');
    const [order] = await q(`SELECT o.id, o.ref, o.status, o.formula, o.qty, o.qty_from_seller, o.qty_from_catalog, o.sale_total, o.supplier_unit_price, o.margin_unit, o.seller_unit_price,
        o.delivery_fee, o.call_fee, o.agent_pay, o.courier_pay, o.customer_name, o.customer_phone, o.commune, o.address, o.note, o.failure_reason, o.return_cause, o.risk_flag,
        COALESCE(p.name, o.own_product_name) AS product_name, s.full_name AS seller_name, su.full_name AS supplier_name, cu.full_name AS courier_name, o.created_at, o.delivered_at
      FROM orders o LEFT JOIN products p ON p.id = o.product_id JOIN users s ON s.id = o.seller_id LEFT JOIN users su ON su.id = p.supplier_id LEFT JOIN users cu ON cu.id = o.courier_id WHERE o.id = $1`, [id]);
    if (!order) throw new HttpError(404, 'not_found', 'Commande introuvable');
    return { order,
      calls: await q('SELECT agent_name, call_center, result, note, at FROM calls WHERE order_id = $1 ORDER BY id', [id]),
      history: await q('SELECT h.to_status, h.note, h.at, u.full_name AS actor FROM order_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.order_id = $1 ORDER BY h.id', [id]),
      payment: (await q('SELECT method, proof_id, reference, created_at FROM order_payments WHERE order_id = $1', [id]))[0] || null,
      money: await q('SELECT w.kind, w.amount, u.full_name, w.available_at FROM wallet_entries w JOIN users u ON u.id = w.user_id WHERE w.order_id = $1 ORDER BY w.id', [id]) };
  }));
  app.post('/api/admin/orders/:id/cancel', guard(ADM, async (ctx) => { await fn('fn_staff_cancel_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 })); }));

  app.post('/api/admin/deposits', guard(ADM, async (ctx) => {
    await fn('fn_admin_deposit', ctx.user.id, v.uuid(ctx.body.user_id, 'Compte'), v.int(ctx.body.amount, 'Montant', { min: 1, max: 1e11 }), v.str(ctx.body.reference, 'Référence', { min: 2, max: 100 }));
  }));

  app.get('/api/admin/cash', guard(ADM, async () => ({
    couriers: await q(`SELECT u.id, u.full_name, COALESCE(sum(c.amount) FILTER (WHERE c.count_id IS NULL AND c.remittance_id IS NULL), 0)::bigint AS expected,
          count(c.id) FILTER (WHERE c.count_id IS NULL AND c.remittance_id IS NULL)::int AS orders,
          COALESCE(sum(c.amount) FILTER (WHERE c.count_id IS NULL AND c.remittance_id IS NOT NULL), 0)::bigint AS in_remittance
        FROM users u LEFT JOIN courier_cash_entries c ON c.courier_id = u.id WHERE u.role = 'courier' AND u.deleted_at IS NULL GROUP BY u.id ORDER BY u.full_name`),
    counts: await q(`SELECT cc.id, u.full_name AS courier, a.full_name AS admin, cc.expected, cc.counted, cc.shortage, cc.surplus, cc.at
        FROM cash_counts cc JOIN users u ON u.id = cc.courier_id JOIN users a ON a.id = cc.admin_id ORDER BY cc.at DESC LIMIT 50`)
  })));
  app.post('/api/admin/cash/:courierId', guard(ADM, async (ctx) => fn('fn_admin_count_cash', ctx.user.id, v.uuid(ctx.params.courierId, 'Livreur'), v.int(ctx.body.counted, 'Montant compté', { min: 0, max: 1e11 }))));

  // Reversements par transfert déclarés par les livreurs (capture d'écran à contrôler)
  app.get('/api/admin/remittances', guard(ADM, async (ctx) => ({
    remittances: await q(`SELECT r.id, r.method, r.amount, r.status, r.received, r.reference, r.proof_id, r.decision_note, r.created_at, r.decided_at, u.full_name AS courier_name, u.phone AS courier_phone
        FROM remittances r JOIN users u ON u.id = r.courier_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`, [ctx.query.status || null])
  })));
  app.post('/api/admin/remittances/:id/confirm', guard(ADM, async (ctx) =>
    fn('fn_admin_confirm_remittance', ctx.user.id, v.uuid(ctx.params.id, 'Reversement'), v.int(ctx.body.received, 'Montant reçu', { min: 0, max: 1e11 }))));
  app.post('/api/admin/remittances/:id/reject', guard(ADM, async (ctx) => { await fn('fn_admin_reject_remittance', ctx.user.id, v.uuid(ctx.params.id, 'Reversement'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 })); }));

  app.get('/api/admin/withdrawals', guard(ADM, async (ctx) => ({
    withdrawals: await q(`SELECT w.id, w.amount, w.method, w.account_number, w.status, w.payment_ref, w.proof_id, w.created_at, w.decided_at, u.full_name, u.phone, u.role, u.identity_verified
        FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE ($1::text IS NULL OR w.status::text = $1) AND w.status <> 'pending_code' ORDER BY w.created_at DESC LIMIT 200`, [ctx.query.status || null])
  })));
  app.post('/api/admin/withdrawals/:id/pay', guard(ADM, async (ctx) => {
    await fn('fn_admin_pay_withdrawal', ctx.user.id, v.uuid(ctx.params.id, 'Retrait'), v.str(ctx.body.payment_ref, 'Référence de paiement', { min: 3, max: 100 }),
      ctx.body.proof_id == null || ctx.body.proof_id === '' ? null : v.uuid(ctx.body.proof_id, 'Capture'));
  }));
  app.post('/api/admin/withdrawals/:id/reject', guard(ADM, async (ctx) => { await fn('fn_admin_reject_withdrawal', ctx.user.id, v.uuid(ctx.params.id, 'Retrait'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 })); }));

  app.get('/api/admin/subscriptions', guard(ADM, async () => ({
    settings: Object.fromEntries((await q(`SELECT key, value FROM settings WHERE key LIKE 'subscription\_%' OR key IN ('fee_order_bps','fee_unit','courier_share_bps')`)).map((r) => [r.key, Number(r.value)])),
    sellers: await q(`SELECT u.id, u.full_name, u.phone, u.created_at, s.paid_until,
        (COALESCE(s.paid_until, '-infinity') > now()) AS paid FROM users u LEFT JOIN seller_subscriptions s ON s.seller_id = u.id
        WHERE u.role = 'seller' AND u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 300`) })));
  app.post('/api/admin/subscriptions/charge', guard(ADM, async (ctx) => {
    const b = ctx.body;
    return { paid_until: await fn('fn_admin_charge_subscription', ctx.user.id, v.uuid(b.seller_id, 'Vendeur'), v.int(b.months, 'Durée', { min: 1, max: 12 }), v.oneOf(b.method, ['wallet', 'external'], 'Mode'), v.optStr(b.note, 'Note', 200)) };
  }));

  app.get('/api/admin/settings', guard(ADM, async () => ({
    settings: await q('SELECT key, value, label FROM settings ORDER BY key'), rates: await q('SELECT commune, fee, active FROM delivery_rates ORDER BY active DESC, commune') })));
  app.post('/api/admin/settings', guard(ADM, async (ctx) => { await fn('fn_admin_set_setting', ctx.user.id, v.str(ctx.body.key, 'Réglage', { max: 40 }), v.int(ctx.body.value, 'Valeur', { min: 0, max: 1e11 })); }));
  // Trophées : les six montants d'un coup, positifs et strictement croissants
  app.post('/api/admin/trophies', guard(ADM, async (ctx) => {
    const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'blue_diamond'];
    const vals = tiers.map((t) => v.int(ctx.body[t], `Trophée ${t}`, { min: 1, max: 1e11 }));
    for (let i = 1; i < vals.length; i++) if (vals[i] <= vals[i - 1]) throw new HttpError(400, 'invalid_input', 'Chaque trophée doit demander plus de ventes que le précédent');
    for (let i = 0; i < tiers.length; i++) await fn('fn_admin_set_setting', ctx.user.id, `trophy_${tiers[i]}`, vals[i]);
  }));
  app.post('/api/admin/rates', guard(ADM, async (ctx) => { await fn('fn_admin_set_delivery_rate', ctx.user.id, v.str(ctx.body.commune, 'Quartier ou ville', { min: 2, max: 60 }), v.int(ctx.body.fee, 'Tarif', { min: 0, max: 1e6 }), ctx.body.active !== false); }));

  app.get('/api/admin/audit', guard(ADM, async (ctx) => {
    const { limit: l, offset } = page(ctx.query);
    return { entries: await q(`SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.details, u.full_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($3::text IS NULL OR a.action = $3) ORDER BY a.id DESC LIMIT $1 OFFSET $2`, [l, offset, ctx.query.action || null]) };
  }));
  app.get('/api/admin/messages', guard(ADM, async (ctx) => {
    const { limit: l, offset } = page(ctx.query);
    const rows = await q('SELECT id, to_phone, to_email, channel, template, subject, body, status, error, created_at, sent_at FROM messages ORDER BY id DESC LIMIT $1 OFFSET $2', [l, offset]);
    // les codes ne sont jamais affichés, sauf en mode test (SHOW_TEST_CODES=1 avec messages simulés : rien n'est réellement envoyé)
    if (!cfg.showTestCodes) for (const m of rows) if (MASKS[m.template]) m.body = m.body.replace(MASKS[m.template], '$1••••');
    return { messages: rows, test_codes_visible: !!cfg.showTestCodes };
  }));
}
