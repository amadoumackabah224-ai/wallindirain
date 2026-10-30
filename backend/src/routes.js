// Toutes les routes de l'API. Règle d'or : chaque route vérifie le rôle côté serveur,
// et chaque requête de lecture nomme explicitement les colonnes visibles pour ce rôle
// (cloisonnement : le fournisseur ne voit jamais le vendeur/client, et inversement).
import { HttpError, v, page } from './http.js';
import crypto from 'node:crypto';
import { parseImage, MAX_PROOF_BODY } from './proofs.js';
import { legalMissing, createLegal, docsFor, canRead, audienceOf, SUMMARY, AUDIENCE_LABEL, OPEN_AUDIENCES } from './legal.js';
import { answer, suggestions, topic, topics } from './assistant.js';
import { parseSheetUrl, fetchSheetCsv, parseCsv, mapRows, phone9, isYes, parsePrice, rowHash } from './sheets.js';
import { simulate as simulatePay } from './pay-sim.js';
import { hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, newToken, tokenHash, RateLimiter, parseCookies } from './security.js';

const COOKIE = 'wld_session';
const WALLET_ROLES = ['seller', 'supplier', 'agent', 'call_chief', 'courier'];

export function registerRoutes(app, { db, cfg }) {
  const limiter = new RateLimiter();
  const fn = async (name, ...args) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(',');
    return (await db.query(`SELECT ${name}(${ph}) AS r`, args)).rows[0].r;
  };
  // Refus du garde-fou de paie : la transaction est annulée, donc on le journalise après coup, dans une transaction à part.
  // Au mieux : si cet enregistrement échoue, la commande reste refusée et l'erreur d'origine est renvoyée telle quelle.
  const refusalLogged = async (source, actor, commune, run) => {
    try { return await run(); } catch (e) {
      if (e?.code === 'WLD01' && String(e.message).startsWith('courier_pay_exceeds_fee|')) {
        await fn('fn_audit_guard_refusal', actor, source, commune).catch(() => {});
      }
      throw e;
    }
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
    communes: await q('SELECT commune, fee, kind, parent, pickup_point FROM delivery_rates WHERE active ORDER BY commune')
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
      v.optStr(b.identity_doc, 'Pièce d\'identité', 60),   // aucune pièce à l'inscription : demandée au premier retrait
      payMethod, payPhone, cfg.legal.version);
    if (b.email) await fn('fn_register_email', id, v.email(b.email));   // code de vérification envoyé par e-mail
    let referral = null;
    if (role === 'seller' && typeof b.referral_code === 'string' && b.referral_code.trim()) referral = await fn('fn_register_referral', id, v.str(b.referral_code, 'Code de parrainage', { min: 4, max: 12 }));
    ctx.status = 201;
    return { id, pending_validation: role === 'supplier', email_pending: !!b.email, referral_applied: referral,
      message: role === 'supplier' ? 'Compte créé. Il sera activé après validation par l\'administration.' : 'Compte créé. Vous pouvez vous connecter.' };
  });

  const legalPending = async (user) => user.role !== 'admin' && (await q('SELECT fn_legal_status($1, $2) AS s', [user.id, cfg.legal.version]))[0].s.pending;
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
    return { user: { id: u.id, role: u.role, name: u.full_name, legal_pending: await legalPending(u) } };
  });

  app.post('/api/auth/logout', async (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (token) await fn('fn_session_revoke', tokenHash(token));
    setCookie(ctx, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', guard(null, async (ctx) => ({ user: { id: ctx.user.id, role: ctx.user.role, name: ctx.user.full_name,
    phone: ctx.user.phone, email: ctx.user.email, email_verified: ctx.user.email_verified, team: ctx.user.team, identity_verified: ctx.user.identity_verified,
    has_avatar: (await q('SELECT 1 FROM avatars WHERE user_id = $1', [ctx.user.id])).length > 0, legal_pending: await legalPending(ctx.user) } })));

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
    const rows = await q(`SELECT p.name, p.description, sp.sale_price AS unit_price, (p.stock_qty - p.reserved_qty) AS available,
        EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id) AS has_photo
        FROM seller_links l JOIN products p ON p.id = l.product_id AND p.status = 'approved' AND p.deleted_at IS NULL
        JOIN users u ON u.id = l.seller_id AND u.status = 'active'
        JOIN seller_prices sp ON sp.seller_id = l.seller_id AND sp.product_id = l.product_id
        WHERE l.code = $1`, [ctx.params.code]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Ce lien n\'est plus valable');
    return { product: rows[0], communes: await q('SELECT commune, fee, kind, parent, pickup_point FROM delivery_rates WHERE active ORDER BY commune'), contact_phone: cfg.contactPhone, orders_open: !cfg.closePublicOrders };
  });

  app.get('/api/public/link/:code/photo', async (ctx) => {
    limit(`linkphoto:${clientIp(ctx.req)}`, 240, 60_000);
    const rows = await q('SELECT * FROM fn_public_product_photo($1)', [typeof ctx.params.code === 'string' ? ctx.params.code.slice(0, 40) : '']);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Pas de photo');
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'public, max-age=300';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  });

  app.post('/api/public/link/:code/order', async (ctx) => {
    if (cfg.closePublicOrders) throw new HttpError(403, 'orders_closed', 'La commande se fait auprès du vendeur : contactez la personne qui vous a envoyé ce lien');
    limit(`pub-order:${clientIp(ctx.req)}`, 10, 600_000);
    const b = ctx.body;
    if (b.accepted !== true) throw new HttpError(400, 'consent_required', 'Vous devez accepter la politique de confidentialité pour commander');
    const custPhone = v.phone(b.phone, 'Votre numéro');
    const key = v.requestKey(b.request_key);
    const commune = v.str(b.commune, 'Commune', { max: 60 });
    const r = await refusalLogged('lien', null, commune, () => fn('fn_public_order_once', ctx.params.code, key, v.int(b.qty, 'Quantité', { min: 1, max: 100 }),
      v.str(b.name, 'Nom', { min: 2, max: 100 }), custPhone, commune, v.str(b.address, 'Adresse', { min: 3, max: 300 }), cfg.legal.version));
    ctx.status = r.replayed ? 200 : 201;
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
  // Visiteur connecté ou non : le public (client, vendeur…) détermine les textes proposés
  const viewerOf = async (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (!token) return null;
    return (await q('SELECT * FROM fn_session_user($1)', [tokenHash(token)]))[0] || null;
  };
  const viewerAudience = async (ctx) => {
    const viewer = await viewerOf(ctx);
    const own = viewer ? audienceOf(viewer.role) : null;
    const asked = String(ctx.query.audience || '');
    if (!viewer) return OPEN_AUDIENCES.includes(asked) ? asked : null;      // avant l'inscription ou la commande
    if (own === 'all') return ['client', 'seller', 'supplier', 'courier', 'team'].includes(asked) ? asked : 'all';
    return own;                                                             // un connecté ne voit que les textes de son rôle
  };
  app.get('/api/public/legal', async (ctx) => {
    const aud = await viewerAudience(ctx);
    return { audience: aud, label: AUDIENCE_LABEL[aud] || null, pages: docsFor(aud).map(({ slug, title, audience }) => ({ slug, title, audience })), version: cfg.legal.version };
  });
  app.get('/api/public/legal/:slug', async (ctx) => {
    const slug = /^[a-z-]+$/.test(ctx.params.slug) ? ctx.params.slug : '';
    const viewer = await viewerOf(ctx);
    const page = canRead(slug, viewer ? audienceOf(viewer.role) : null) ? legalPages.content(slug) : null;
    if (!page) throw new HttpError(404, 'not_found', 'Page introuvable');
    return page;
  });
  // Accord de la personne connectée sur les textes de son rôle (administrateur : pas d'accord demandé)
  app.get('/api/me/legal', guard(ANY_ROLE, async (ctx) => {
    const aud = audienceOf(ctx.user.role);
    const st = (await q('SELECT fn_legal_status($1, $2) AS s', [ctx.user.id, cfg.legal.version]))[0].s;
    return { audience: aud, label: AUDIENCE_LABEL[aud] || 'Administrateur', summary: SUMMARY[aud] || null, version: cfg.legal.version, accepted_version: st.accepted_version, accepted_at: st.accepted_at,
      pending: ctx.user.role !== 'admin' && st.pending, pages: docsFor(aud).map(({ slug, title, audience }) => ({ slug, title, audience })) };
  }));
  app.post('/api/me/legal/accept', guard(ANY_ROLE, async (ctx) => {
    if (ctx.body.accept !== true) throw new HttpError(400, 'consent_required', 'Vous devez accepter pour continuer');
    await fn('fn_legal_accept', ctx.user.id, cfg.legal.version);
    return { ok: true };
  }));
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
    categories: await q('SELECT id, name FROM product_categories WHERE active ORDER BY position, name'),
    products: await q(`SELECT id, name, description, category_id, supplier_price, storage, stock_qty, reserved_qty, status, created_at, pickup_detail,
        (SELECT COALESCE(jsonb_agg(pi.id ORDER BY pi.position), '[]'::jsonb) FROM product_images pi WHERE pi.product_id = products.id) AS image_ids
        FROM products WHERE supplier_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [ctx.user.id]),
    arrivals: await q(`SELECT a.id, p.name AS product_name, a.announced_qty, a.counted_qty, a.created_at, a.counted_at
        FROM arrivals a JOIN products p ON p.id = a.product_id WHERE p.supplier_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [ctx.user.id])
  })));

  app.post('/api/supplier/products', guard(SUP, async (ctx) => {
    const b = ctx.body;
    const id = await fn('fn_supplier_add_product', ctx.user.id, v.str(b.name, 'Nom du produit', { min: 2, max: 120 }), v.optStr(b.description, 'Description', 1000),
      v.int(b.supplier_price, 'Prix fournisseur', { min: 1, max: 1e9 }), v.oneOf(b.storage, ['wallindirain', 'supplier'], 'Stockage'),
      b.storage === 'supplier' ? v.int(b.stock_qty ?? 0, 'Quantité', { min: 0, max: 1e6 }) : 0, b.category_id == null || b.category_id === '' ? null : v.uuid(b.category_id, 'Rayon'));
    if (b.storage === 'supplier' && b.pickup_detail != null && String(b.pickup_detail).trim() !== '') await fn('fn_supplier_set_pickup', ctx.user.id, id, v.str(b.pickup_detail, 'Adresse de récupération', { min: 3, max: 200 }));
    ctx.status = 201;
    return { id, message: 'Produit proposé. Il sera visible des vendeurs après validation.' };
  }));

  app.post('/api/supplier/products/:id/category', guard(SUP, async (ctx) => { await fn('fn_set_product_category', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.uuid(ctx.body.category_id, 'Rayon')); }));

  // Photos du produit (jusqu'à 4) : ajout, suppression ; lecture contrôlée par rôle
  app.post('/api/supplier/products/:id/images', guard(SUP, async (ctx) => {
    limit(`prodimg:${ctx.user.id}`, 60, 3600_000);
    const { mime, buf } = parseImage(ctx.body.image);
    if (buf.length > 450_000) throw new HttpError(413, 'too_large', 'Photo trop lourde : choisissez une photo plus petite');
    ctx.status = 201;
    return { id: await fn('fn_supplier_add_product_image', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), mime, buf) };
  }), { maxBody: MAX_PROOF_BODY });
  app.post('/api/supplier/images/:id/delete', guard(SUP, async (ctx) => { await fn('fn_supplier_delete_product_image', ctx.user.id, v.uuid(ctx.params.id, 'Photo')); return { ok: true }; }));
  app.get('/api/product-images/:id', guard(ANY_ROLE, async (ctx) => {
    const rows = await q('SELECT * FROM fn_product_image_get($1, $2)', [ctx.user.id, v.uuid(ctx.params.id, 'Photo')]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Photo introuvable');
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'private, max-age=3600';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  }));

  app.post('/api/supplier/products/:id/pickup', guard(SUP, async (ctx) => {
    const d = ctx.body.detail;
    await fn('fn_supplier_set_pickup', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), d == null || String(d).trim() === '' ? null : v.str(d, 'Adresse de récupération', { min: 3, max: 200 }));
    return { ok: true };
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
      categories: await q('SELECT id, name FROM product_categories WHERE active ORDER BY position, name'),
      products: await q(`SELECT p.id, p.name, p.description, p.category_id,
            (p.supplier_price + p.margin_unit) AS vendor_price,
            (p.supplier_price + p.margin_unit + $2 + $3 + (SELECT value FROM settings WHERE key = 'fee_unit')) AS min_price,
            (p.storage = 'wallindirain') AS can_prepay,
            GREATEST(p.stock_qty - p.reserved_qty, 0) AS available,
            (SELECT COALESCE(jsonb_agg(pi.id ORDER BY pi.position), '[]'::jsonb) FROM product_images pi WHERE pi.product_id = p.id) AS image_ids,
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
    const pickup = own ? v.str(b.pickup_detail, 'Où récupérer le colis', { min: 3, max: 200 }) : null;   // produit du vendeur : l'adresse de récupération est obligatoire
    const r = await refusalLogged('vendeur', ctx.user.id, typeof b.commune === 'string' ? b.commune : '', () => fn('fn_seller_create_order_once', ctx.user.id, v.requestKey(b.request_key), own ? null : v.uuid(b.product_id, 'Produit'),
      own ? v.str(b.own_product_name, 'Nom du produit', { min: 2, max: 120 }) : null,
      b.unit_price == null || b.unit_price === '' ? null : v.int(b.unit_price, 'Prix unitaire', { min: 1, max: 1e10 }),
      v.int(b.qty, 'Quantité', { min: 1, max: 100 }), v.str(b.customer_name, 'Nom du client', { min: 2, max: 100 }), v.phone(b.customer_phone, 'Numéro du client'),
      v.str(b.commune, 'Quartier ou ville', { max: 60 }), v.str(b.address, 'Adresse', { min: 3, max: 300 }), v.optStr(b.note, 'Note', 300), b.already_confirmed === true));
    if (own && !r.replayed) await fn('fn_seller_set_pickup', ctx.user.id, r.id, pickup);
    ctx.status = r.replayed ? 200 : 201;
    return r;
  }));

  app.post('/api/seller/orders/:id/pickup', guard(SEL, async (ctx) => {
    await fn('fn_seller_set_pickup', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.str(ctx.body.detail, 'Où récupérer le colis', { min: 3, max: 200 }));
    return { ok: true };
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
        const res = await refusalLogged('import', ctx.user.id, zone, () => fn('fn_seller_import_order', ctx.user.id, rowHash(ctx.user.id, r), prod ? prod.id : null, prod ? null : r.product, price, qty,
          r.name, phone, zone, address.slice(0, 300), r.note ? r.note.slice(0, 300) : null, isYes(r.confirmed)));
        if (res.duplicate) out.duplicates++; else out.created++;
      } catch (e) { out.errors.push({ line: r.line, message: e.message?.replace(/^[a-z_]+\|/, '') || 'Erreur' }); }
    }
    return out;
  }));


  // Où récupérer le colis : entrepôt, fournisseur (adresse indiquée par lui) ou vendeur (propre produit). L'adresse du fournisseur n'est donnée qu'à l'équipe et au livreur.
  const PICKUP_PLACE = `CASE WHEN o.product_id IS NULL THEN 'seller' WHEN p.storage = 'supplier' THEN 'supplier' ELSE 'warehouse' END`;
  const PICKUP_DETAIL = `CASE WHEN o.product_id IS NULL THEN o.pickup_detail WHEN p.storage = 'supplier' THEN p.pickup_detail ELSE NULL END`;
  const SELLER_ORDER_COLS = `o.id, o.ref, o.status, o.formula, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total,
      o.customer_name, o.customer_phone, o.commune, o.address, o.delivery_fee, o.call_fee, o.call_attempts, o.failure_reason, o.return_cause,
      o.created_at, o.delivered_at, o.track_token, o.risk_flag, ${PICKUP_PLACE} AS pickup_place, CASE WHEN o.product_id IS NULL THEN o.pickup_detail END AS pickup_detail, (o.product_id IS NULL AND o.pickup_detail IS NULL) AS pickup_missing,
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

  // ----- Notifications (cloche) et annonces de l'administration -----
  app.get('/api/notifications', guard(ANY_ROLE, async (ctx) => await fn('fn_my_notifications', ctx.user.id, Math.min(100, Math.max(1, Number(ctx.query.limit) || 50)))));
  app.get('/api/notifications/unread', guard(ANY_ROLE, async (ctx) => ({ unread: await fn('fn_notifications_unread', ctx.user.id) })));
  app.post('/api/notifications/read', guard(ANY_ROLE, async (ctx) => {
    const ids = ctx.body.ids === undefined ? null : (Array.isArray(ctx.body.ids) && ctx.body.ids.length <= 100 ? ctx.body.ids.map((x) => v.int(x, 'Notification', { min: 1 })) : (() => { throw new HttpError(400, 'invalid_input', 'Notifications invalides'); })());
    return { marked: await fn('fn_notifications_read', ctx.user.id, ids) };
  }));
  app.get('/api/admin/announcements', guard(['admin'], async (ctx) => ({ announcements: await fn('fn_admin_announcements', ctx.user.id) })));
  app.post('/api/admin/announcements', guard(['admin'], async (ctx) => {
    limit(`announce:${ctx.user.id}`, 10, 3600_000);
    const b = ctx.body;
    ctx.status = 201;
    return await fn('fn_admin_announce', ctx.user.id, v.str(b.audience, 'Destinataires', { max: 20 }), v.str(b.title, 'Titre', { min: 3, max: 120 }), v.str(b.body, 'Message', { min: 3, max: 600 }));
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
  // paie affichée d'une commande : versée si livrée, sinon celle du barème retenu à l'affectation, sinon la paie figée à la commande (même règle que le calcul en base)
  const PAY_SHOWN = `COALESCE(o.courier_pay_paid, CASE WHEN o.courier_scale_id IS NOT NULL THEN LEAST((SELECT s.per_delivery FROM courier_pay_scales s WHERE s.id = o.courier_scale_id), o.delivery_fee) ELSE o.courier_pay END)`;
  const KIND_OF = (col) => `COALESCE((SELECT k.kind FROM courier_kind_log k WHERE k.courier_id = ${col} AND k.effective_from <= now() ORDER BY k.id DESC LIMIT 1), 'independent')`;
  app.get('/api/chief/orders', guard(CHIEF, async () => ({
    pickup_alert_hours: await pickupHours(),
    orders: await q(`SELECT ${CALL_COLS}, o.delivery_fee, ${PAY_SHOWN} AS courier_pay, o.courier_kind, ${PICKUP_PLACE} AS pickup_place, ${PICKUP_DETAIL} AS pickup_detail, (${PICKUP_PLACE} <> 'warehouse' AND ${PICKUP_DETAIL} IS NULL) AS pickup_missing, o.courier_id, cu.full_name AS courier_name, o.failure_reason, o.confirmed_at, ${ASSIGNED_SINCE} AS assigned_since
        FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN users cu ON cu.id = o.courier_id
        WHERE o.status IN ('confirmed','assigned','picked_up','on_the_way','failed','return_pending') ORDER BY o.created_at LIMIT 300`),
    couriers: await q(`SELECT u.id, u.full_name, (SELECT count(*) FROM orders o WHERE o.courier_id = u.id AND o.status IN ('assigned','picked_up','on_the_way'))::int AS open_orders,
        COALESCE((SELECT k.kind FROM courier_kind_log k WHERE k.courier_id = u.id AND k.effective_from <= now() ORDER BY k.id DESC LIMIT 1), 'independent') AS kind,
        COALESCE(p.availability, 'available') AS availability, p.vehicle,
        COALESCE((SELECT jsonb_agg(z.commune ORDER BY z.commune) FROM courier_zones z WHERE z.courier_id = u.id), '[]'::jsonb) AS zones
        FROM users u LEFT JOIN courier_profiles p ON p.courier_id = u.id
        WHERE u.role = 'courier' AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.full_name`)
  })));
  app.get('/api/chief/offers', guard(CHIEF, async (ctx) => fn('fn_chief_offers', ctx.user.id)));
  app.post('/api/chief/orders/:id/offer', guard(CHIEF, async (ctx) => {
    ctx.status = 201;
    return fn('fn_chief_offer_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.uuid(ctx.body.courier_id, 'Livreur'));
  }));
  app.post('/api/chief/offers/:id/cancel', guard(CHIEF, async (ctx) => { await fn('fn_chief_cancel_offer', ctx.user.id, v.uuid(ctx.params.id, 'Proposition')); }));
  // Tournées groupées : plusieurs commandes pour un même livreur, chacune suivie séparément
  app.get('/api/chief/tours', guard(CHIEF, async (ctx) => ({ tours: await fn('fn_chief_tours', ctx.user.id) })));
  app.post('/api/chief/tours', guard(CHIEF, async (ctx) => {
    const b = ctx.body;
    if (!Array.isArray(b.order_ids) || b.order_ids.length > 200) throw new HttpError(400, 'invalid_input', 'Liste de commandes invalide');
    const id = await fn('fn_chief_create_tour', ctx.user.id, v.uuid(b.courier_id, 'Livreur'), b.order_ids.map((x) => v.uuid(x, 'Commande')), v.optStr(b.note, 'Note', 200),
      v.optStr(b.mode, 'Mode de paie', 20) ?? 'normal');
    ctx.status = 201;
    return { id };
  }));
  app.post('/api/chief/tours/:id/reorder', guard(CHIEF, async (ctx) => {
    const ids = Array.isArray(ctx.body.order_ids) ? ctx.body.order_ids.slice(0, 200).map((x) => v.uuid(x, 'Commande')) : null;
    if (!ids || !ids.length) throw new HttpError(400, 'invalid_input', 'Indiquez les commandes dans l\'ordre de passage');
    await fn('fn_chief_reorder_tour', ctx.user.id, v.uuid(ctx.params.id, 'Tournée'), ids);
    return { ok: true };
  }));
  app.post('/api/chief/tours/:id/cancel', guard(CHIEF, async (ctx) => { await fn('fn_chief_cancel_tour', ctx.user.id, v.uuid(ctx.params.id, 'Tournée')); }));
  app.post('/api/chief/tours/:id/cost', guard(CHIEF, async (ctx) => {
    const c = ctx.body.cost;
    await fn('fn_chief_set_tour_cost', ctx.user.id, v.uuid(ctx.params.id, 'Tournée'), c == null || c === '' ? null : v.int(c, 'Coût', { min: 0, max: 100000000 }));
  }));
  app.post('/api/chief/orders/:id/assign', guard(CHIEF, async (ctx) => { await fn('fn_chief_assign', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.uuid(ctx.body.courier_id, 'Livreur')); }));
  app.post('/api/chief/orders/:id/return', guard(CHIEF, async (ctx) => { await fn('fn_chief_return_to_warehouse', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/chief/orders/:id/cancel', guard(CHIEF, async (ctx) => { await fn('fn_staff_cancel_order', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 })); }));

  // =========================================================================
  // LIVREUR : ni prix fournisseur ni gains du vendeur
  // =========================================================================
  const COU = ['courier'];
  app.get('/api/courier/orders', guard(COU, async (ctx) => ({
    orders: await q(`SELECT o.id, o.ref, o.status, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.sale_total AS amount_to_collect,
          o.customer_name, o.customer_phone, o.commune, o.address, o.note, o.failure_reason, o.code_attempts, o.created_at, ${PICKUP_PLACE} AS pickup_place, ${PICKUP_DETAIL} AS pickup_detail, (${PICKUP_PLACE} <> 'warehouse' AND ${PICKUP_DETAIL} IS NULL) AS pickup_missing,
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
  app.post('/api/courier/tours/:id/accept', guard(COU, async (ctx) => { await fn('fn_courier_accept_tour', ctx.user.id, v.uuid(ctx.params.id, 'Tournée')); return { ok: true }; }));
  app.post('/api/courier/tours/:id/refuse', guard(COU, async (ctx) => { await fn('fn_courier_refuse_tour', ctx.user.id, v.uuid(ctx.params.id, 'Tournée')); return { ok: true }; }));
  app.get('/api/courier/tours', guard(COU, async (ctx) => ({ tours: await fn('fn_courier_tours', ctx.user.id) })));
  app.get('/api/courier/offers', guard(COU, async (ctx) => ({ offers: await fn('fn_courier_offers', ctx.user.id) })));
  app.post('/api/courier/offers/:id/accept', guard(COU, async (ctx) => { await fn('fn_courier_accept_offer', ctx.user.id, v.uuid(ctx.params.id, 'Proposition')); }));
  app.post('/api/courier/offers/:id/refuse', guard(COU, async (ctx) => {
    const r = ctx.body.reason;
    await fn('fn_courier_refuse_offer', ctx.user.id, v.uuid(ctx.params.id, 'Proposition'), r == null || r === '' ? null : v.oneOf(r, ['too_far', 'busy', 'vehicle', 'other'], 'Motif'));
  }));
  app.get('/api/courier/profile', guard(COU, async (ctx) => fn('fn_courier_profile', ctx.user.id)));
  app.post('/api/courier/availability', guard(COU, async (ctx) => {
    if (typeof ctx.body.available !== 'boolean') throw new HttpError(400, 'invalid_input', 'Disponibilité invalide');
    await fn('fn_courier_set_availability', ctx.user.id, ctx.body.available);
  }));
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
    remittances: await q(`SELECT id, method, amount, status, received, reference, proof_id, handed_to, decision_note, created_at, decided_at
        FROM remittances WHERE courier_id = $1 ORDER BY created_at DESC LIMIT 30`, [ctx.user.id])
  })));
  app.post('/api/courier/remit', guard(COU, async (ctx) => {
    limit(`remit:${ctx.user.id}`, 20, 3600_000);
    const b = ctx.body;
    const orders = Array.isArray(b.orders) && b.orders.length ? b.orders.slice(0, 200).map((x) => v.uuid(x, 'Commande')) : null;
    const method = v.oneOf(b.method, ['orange_money', 'mtn_momo', 'cash'], 'Mode de paiement');
    const r = await fn('fn_courier_remit', ctx.user.id, method,
      method === 'cash' ? null : v.uuid(b.proof_id, 'Capture'), v.optStr(b.reference, 'Référence', 100), orders,
      method === 'cash' ? v.str(b.handed_to, 'Personne à qui vous avez remis l\'argent', { min: 2, max: 100 }) : null);
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
  const IMG_IDS = (pid) => `(SELECT COALESCE(jsonb_agg(pi.id ORDER BY pi.position), '[]'::jsonb) FROM product_images pi WHERE pi.product_id = ${pid})`;
  // « À faire » : arrivages à compter, colis à remettre aux livreurs, retours à réceptionner (aucune donnée client ni financière)
  app.get('/api/warehouse/arrivals', guard(WH, async () => ({
    arrivals: await q(`SELECT a.id, p.name AS product_name, u.full_name AS supplier_name, a.announced_qty, a.created_at, ${IMG_IDS('p.id')} AS image_ids
        FROM arrivals a JOIN products p ON p.id = a.product_id JOIN users u ON u.id = p.supplier_id
        WHERE a.counted_qty IS NULL ORDER BY a.created_at`),
    handovers: await q(`SELECT o.id, o.ref, p.name AS product_name, o.qty, o.commune, c.full_name AS courier_name, c.phone AS courier_phone,
          (SELECT max(h.at) FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned') AS assigned_at,
          hv.handed_at, ${IMG_IDS('p.id')} AS image_ids
        FROM orders o JOIN products p ON p.id = o.product_id AND p.storage = 'wallindirain' JOIN users c ON c.id = o.courier_id
        LEFT JOIN order_handovers hv ON hv.order_id = o.id AND hv.courier_id = o.courier_id
        WHERE o.status = 'assigned' ORDER BY (hv.handed_at IS NOT NULL), assigned_at`),
    returns: await q(`SELECT o.id, o.ref, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.failure_reason, o.created_at,
          (SELECT n.note FROM return_notes n WHERE n.order_id = o.id) AS note,
          (SELECT COALESCE(jsonb_agg(rp.id ORDER BY rp.created_at), '[]'::jsonb) FROM return_photos rp WHERE rp.order_id = o.id) AS photo_ids
        FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status = 'return_pending' ORDER BY o.created_at`)
  })));
  // Stock détenu par l'entrepôt : quantité vendable, réservée, libre
  app.get('/api/warehouse/stock', guard(WH, async (ctx) => {
    const [{ low }] = await q(`SELECT value::int AS low FROM settings WHERE key = 'alert_low_stock_qty'`);
    const exp = new Map((await q('SELECT * FROM fn_warehouse_expected($1)', [ctx.user.id])).map((e) => [e.product_id, e]));
    const products = await q(`SELECT p.id, p.name, u.full_name AS supplier_name, p.stock_qty, p.reserved_qty, (p.stock_qty - p.reserved_qty) AS free_qty,
          (SELECT max(a.counted_at) FROM arrivals a WHERE a.product_id = p.id) AS last_arrival, ${IMG_IDS('p.id')} AS image_ids
        FROM products p JOIN users u ON u.id = p.supplier_id
        WHERE p.storage = 'wallindirain' AND p.status = 'approved' AND p.deleted_at IS NULL ORDER BY (p.stock_qty - p.reserved_qty), p.name`);
    return { low_threshold: low, products: products.map((p) => ({ ...p, expected_shelf: exp.get(p.id)?.expected ?? null, count_pending: !!exp.get(p.id)?.pending })) };
  }));
  // Historique : arrivages comptés, retours réceptionnés, remises, casses (60 derniers de chaque)
  app.get('/api/warehouse/history', guard(WH, async () => ({
    arrivals: await q(`SELECT a.id, p.name AS product_name, u.full_name AS supplier_name, a.announced_qty, a.counted_qty, a.count_note, a.counted_at, w.full_name AS by_name
        FROM arrivals a JOIN products p ON p.id = a.product_id JOIN users u ON u.id = p.supplier_id LEFT JOIN users w ON w.id = a.counted_by
        WHERE a.counted_qty IS NOT NULL ORDER BY a.counted_at DESC LIMIT 60`),
    returns: await q(`SELECT o.id, o.ref, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.return_cause, o.closed_at,
          (SELECT n.note FROM return_notes n WHERE n.order_id = o.id) AS note,
          (SELECT COALESCE(jsonb_agg(rp.id ORDER BY rp.created_at), '[]'::jsonb) FROM return_photos rp WHERE rp.order_id = o.id) AS photo_ids
        FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status = 'returned' ORDER BY o.closed_at DESC NULLS LAST LIMIT 60`),
    handovers: await q(`SELECT o.ref, p.name AS product_name, o.qty, c.full_name AS courier_name, hv.handed_at, w.full_name AS by_name
        FROM order_handovers hv JOIN orders o ON o.id = hv.order_id JOIN products p ON p.id = o.product_id JOIN users c ON c.id = hv.courier_id LEFT JOIN users w ON w.id = hv.handed_by
        ORDER BY hv.handed_at DESC LIMIT 60`),
    counts: await q(`SELECT c.id, p.name AS product_name, c.expected_qty, c.counted_qty, c.delta, c.note, c.status, c.review_note, c.counted_at, c.reviewed_at, w.full_name AS by_name
        FROM stock_counts c JOIN products p ON p.id = c.product_id LEFT JOIN users w ON w.id = c.counted_by ORDER BY c.counted_at DESC LIMIT 60`),
    losses: await q(`SELECT l.id, p.name AS product_name, l.qty, l.reason, l.note, l.created_at, w.full_name AS by_name
        FROM stock_losses l JOIN products p ON p.id = l.product_id LEFT JOIN users w ON w.id = l.declared_by ORDER BY l.created_at DESC LIMIT 60`)
  })));
  app.post('/api/warehouse/arrivals/:id/count', guard(WH, async (ctx) => {
    await fn('fn_warehouse_count_arrival', ctx.user.id, v.uuid(ctx.params.id, 'Arrivage'), v.int(ctx.body.counted, 'Quantité comptée', { min: 0, max: 1e6 }), v.optStr(ctx.body.note, 'Explication', 300));
  }));
  app.post('/api/warehouse/stock/:id/count', guard(WH, async (ctx) => {
    ctx.status = 201;
    return { id: await fn('fn_warehouse_count_stock', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.int(ctx.body.counted, 'Quantité comptée', { min: 0, max: 1e6 }), v.optStr(ctx.body.note, 'Explication', 300)) };
  }));
  app.post('/api/warehouse/handovers/:id', guard(WH, async (ctx) => { await fn('fn_warehouse_handover', ctx.user.id, v.uuid(ctx.params.id, 'Commande')); }));
  app.post('/api/warehouse/losses', guard(WH, async (ctx) => {
    ctx.status = 201;
    return { id: await fn('fn_warehouse_declare_loss', ctx.user.id, v.uuid(ctx.body.product_id, 'Produit'), v.int(ctx.body.qty, 'Quantité', { min: 1, max: 100000 }),
      v.oneOf(ctx.body.reason, ['damaged', 'lost', 'expired', 'other'], 'Motif'), v.str(ctx.body.note, 'Explication', { min: 3, max: 300 })) };
  }));
  app.post('/api/warehouse/returns/:id/photos', guard(WH, async (ctx) => {
    limit(`retimg:${ctx.user.id}`, 60, 3600_000);
    const { mime, buf } = parseImage(ctx.body.image);
    if (buf.length > 450_000) throw new HttpError(413, 'too_large', 'Photo trop lourde : choisissez une photo plus petite');
    ctx.status = 201;
    return { id: await fn('fn_warehouse_add_return_photo', ctx.user.id, v.uuid(ctx.params.id, 'Commande'), mime, buf) };
  }), { maxBody: MAX_PROOF_BODY });
  app.get('/api/return-photos/:id', guard(['admin', 'warehouse', 'supplier'], async (ctx) => {
    const rows = await q('SELECT * FROM fn_return_photo_get($1, $2)', [ctx.user.id, v.uuid(ctx.params.id, 'Photo')]);
    if (!rows.length) throw new HttpError(404, 'not_found', 'Photo introuvable');
    ctx.headers['Content-Type'] = rows[0].mime;
    ctx.headers['Cache-Control'] = 'private, max-age=3600';
    ctx.headers['Content-Disposition'] = 'inline';
    return rows[0].data;
  }));
  app.post('/api/warehouse/returns/:id', guard(WH, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Commande');
    const cause = v.oneOf(ctx.body.cause, ['customer_refusal', 'defective', 'damaged_transport'], 'Cause');
    const note = v.optStr(ctx.body.note, 'Note', 300);
    if (note) await fn('fn_warehouse_return_note', ctx.user.id, id, note);   // avant la réception : un retour déjà clos n'accepte plus de note
    await fn('fn_warehouse_receive_return', ctx.user.id, id, cause);
  }));

  // =========================================================================
  // FACTURES ET DOCUMENTS NUMÉROTÉS : émis à la demande, figés ; chacun ne voit que les siens (l'administrateur voit tout)
  // =========================================================================
  const INV_ALL = ['seller', 'supplier', 'agent', 'call_chief', 'courier', 'admin'];
  const KINDS = ['delivery', 'seller_services', 'supplier_statement', 'withdrawal_receipt'];
  const isoDate = (x, name) => { if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw new HttpError(400, 'invalid_input', `${name} invalide`); return x; };
  const optDate = (x, name) => (x == null || x === '' ? null : isoDate(x, name));
  app.get('/api/invoices', guard(INV_ALL, async (ctx) => ({
    invoices: await q('SELECT * FROM fn_invoice_list($1, $2, $3, $4, $5, $6)', [ctx.user.id, ctx.query.kind ? v.oneOf(ctx.query.kind, KINDS, 'Type') : null, optDate(ctx.query.from, 'Date de début'), optDate(ctx.query.to, 'Date de fin'),
      ctx.query.q ? v.str(ctx.query.q, 'Recherche', { min: 1, max: 60 }) : null, ctx.query.limit ? v.int(ctx.query.limit, 'Limite', { min: 1, max: 500 }) : 100])
  })));
  app.get('/api/invoices/:id', guard(INV_ALL, async (ctx) => ({ invoice: await fn('fn_invoice_get', ctx.user.id, v.uuid(ctx.params.id, 'Document')) })));
  app.post('/api/invoices/delivery', guard(['seller', 'admin'], async (ctx) => {
    limit(`inv:${ctx.user.id}`, 120, 3600_000);
    let order = ctx.body.order_id;
    if (!order && ctx.user.role === 'admin' && ctx.body.ref) order = (await q('SELECT id FROM orders WHERE ref = $1', [v.str(ctx.body.ref, 'Référence', { min: 3, max: 20 }).toUpperCase()]))[0]?.id;
    if (!order) throw new HttpError(404, 'not_found', 'Commande introuvable');
    return { id: await fn('fn_invoice_issue_delivery', ctx.user.id, v.uuid(order, 'Commande')) };
  }));
  app.post('/api/invoices/statement', guard(['seller', 'supplier', 'admin'], async (ctx) => {
    limit(`inv:${ctx.user.id}`, 120, 3600_000);
    return { id: await fn('fn_invoice_issue_statement', ctx.user.id, ctx.body.user_id ? v.uuid(ctx.body.user_id, 'Compte') : null, isoDate(ctx.body.period_from, 'Date de début'), isoDate(ctx.body.period_to, 'Date de fin')) };
  }));
  app.post('/api/invoices/withdrawal', guard(['seller', 'supplier', 'agent', 'call_chief', 'courier', 'admin'], async (ctx) => {
    limit(`inv:${ctx.user.id}`, 120, 3600_000);
    return { id: await fn('fn_invoice_issue_withdrawal', ctx.user.id, v.uuid(ctx.body.withdrawal_id, 'Retrait')) };
  }));
  // Commandes livrées du vendeur, avec le numéro de facture si elle a déjà été émise
  app.get('/api/seller/delivered-orders', guard(['seller'], async (ctx) => ({
    orders: await q(`SELECT o.id, o.ref, COALESCE(p.name, o.own_product_name) AS product_name, o.qty, o.customer_name, o.sale_total, o.delivered_at, i.id AS invoice_id, i.number AS invoice_number
        FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN invoices i ON i.order_id = o.id
        WHERE o.seller_id = $1 AND o.status = 'delivered' ORDER BY o.delivered_at DESC LIMIT 100`, [ctx.user.id])
  })));

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
          CASE WHEN role IN ('seller','supplier','agent','call_chief','courier') THEN (SELECT COALESCE(sum(amount),0)::bigint FROM wallet_entries w WHERE w.user_id = users.id) END AS balance,
          CASE WHEN role = 'courier' THEN COALESCE((SELECT availability FROM courier_profiles cp WHERE cp.courier_id = users.id), 'available') END AS availability,
          CASE WHEN role = 'courier' THEN (SELECT vehicle FROM courier_profiles cp WHERE cp.courier_id = users.id) END AS vehicle,
          CASE WHEN role = 'courier' THEN COALESCE((SELECT jsonb_agg(z.commune ORDER BY z.commune) FROM courier_zones z WHERE z.courier_id = users.id), '[]'::jsonb) END AS zones
        FROM users WHERE deleted_at IS NULL AND role <> 'system' AND ($1::text IS NULL OR role::text = $1) AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [ctx.query.role || null, ctx.query.status || null, l, offset]) };
  }));
  // Livreurs : profil, véhicule, disponibilité et zones couvertes
  app.get('/api/admin/couriers', guard(ADM, async () => ({
    couriers: await q(`SELECT u.id, u.full_name, u.phone, u.status, ${KIND_OF('u.id')} AS kind, u.identity_verified, (SELECT d.status FROM identity_documents d WHERE d.user_id = u.id) AS kyc_status,
        (SELECT count(*) FROM orders o WHERE o.courier_id = u.id AND o.status = 'delivered' AND o.delivered_at >= now() - interval '30 days')::int AS delivered_30,
        (SELECT COALESCE(sum(w.amount), 0) FROM wallet_entries w WHERE w.user_id = u.id AND w.kind IN ('team_pay', 'tour_bonus', 'tour_adjust', 'courier_prime', 'failed_trip') AND w.created_at >= now() - interval '30 days')::bigint AS pay_30,
        (SELECT COALESCE(sum(c.amount), 0) FROM courier_cash_entries c WHERE c.courier_id = u.id AND c.count_id IS NULL)::bigint AS cash_pending,
        (SELECT COALESCE(sum(e.amount), 0) FROM courier_expenses e WHERE e.courier_id = u.id AND e.voided_at IS NULL AND e.spent_on >= current_date - 30)::bigint AS expenses_30,
        COALESCE(p.availability, 'available') AS availability, p.vehicle,
        COALESCE((SELECT jsonb_agg(z.commune ORDER BY z.commune) FROM courier_zones z WHERE z.courier_id = u.id), '[]'::jsonb) AS zones,
        (SELECT count(*) FROM orders o WHERE o.courier_id = u.id AND o.status IN ('assigned','picked_up','on_the_way'))::int AS open_orders
        FROM users u LEFT JOIN courier_profiles p ON p.courier_id = u.id
        WHERE u.role = 'courier' AND u.deleted_at IS NULL ORDER BY u.full_name`),
    zones: await q('SELECT commune FROM delivery_rates ORDER BY commune') })));
  // Fiche d'un livreur : catégorie et historique, missions, paies, reversements, charges de la moto
  app.get('/api/admin/couriers/:id/file', guard(ADM, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Livreur');
    const [c] = await q(`SELECT u.id, u.full_name, u.phone, u.status, u.identity_verified, u.payout_method, u.payout_phone, u.created_at, ${KIND_OF('u.id')} AS kind,
        (SELECT d.status FROM identity_documents d WHERE d.user_id = u.id) AS kyc_status, (SELECT p.vehicle FROM courier_profiles p WHERE p.courier_id = u.id) AS vehicle
        FROM users u WHERE u.id = $1 AND u.role = 'courier' AND u.deleted_at IS NULL`, [id]);
    if (!c) throw new HttpError(404, 'not_found', 'Livreur introuvable');
    return {
      courier: c,
      kind_history: await q(`SELECT k.kind, k.effective_from, k.note, a.full_name AS set_by_name FROM courier_kind_log k LEFT JOIN users a ON a.id = k.set_by WHERE k.courier_id = $1 ORDER BY k.id DESC LIMIT 20`, [id]),
      orders: await q(`SELECT o.id, o.ref, o.status, o.commune, o.delivery_fee, o.courier_kind, o.courier_scale_id IS NOT NULL AS scale_applied, ${PAY_SHOWN} AS pay, o.delivered_at, o.created_at
          FROM orders o WHERE o.courier_id = $1 ORDER BY o.created_at DESC LIMIT 25`, [id]),
      pay: await q(`SELECT w.kind, w.amount, w.description, w.created_at FROM wallet_entries w WHERE w.user_id = $1 AND w.kind IN ('team_pay', 'tour_bonus', 'tour_adjust', 'courier_prime', 'failed_trip', 'cash_shortage', 'withdrawal') ORDER BY w.id DESC LIMIT 30`, [id]),
      balance: Number((await q('SELECT COALESCE(sum(amount), 0)::bigint AS s FROM wallet_entries WHERE user_id = $1', [id]))[0].s),
      cash_pending: Number((await q('SELECT COALESCE(sum(amount), 0)::bigint AS s FROM courier_cash_entries WHERE courier_id = $1 AND count_id IS NULL', [id]))[0].s),
      remittances: await q(`SELECT r.id, r.method, r.amount, r.received, r.status, r.created_at, r.decided_at FROM remittances r WHERE r.courier_id = $1 ORDER BY r.created_at DESC LIMIT 15`, [id]),
      expenses: await q(`SELECT e.id, e.kind, e.amount, e.spent_on, e.note, e.voided_at, e.void_reason FROM courier_expenses e WHERE e.courier_id = $1 ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 30`, [id]),
      expenses_total: Number((await q('SELECT COALESCE(sum(amount), 0)::bigint AS s FROM courier_expenses WHERE courier_id = $1 AND voided_at IS NULL', [id]))[0].s)
    };
  }));
  app.post('/api/admin/couriers/:id/kind', guard(ADM, async (ctx) => {
    await fn('fn_admin_set_courier_kind', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), v.oneOf(ctx.body.kind, ['independent', 'company'], 'Catégorie'), v.optStr(ctx.body.note, 'Note', 200));
  }));
  const EXPENSE_KINDS = ['fuel', 'maintenance', 'repair', 'insurance', 'other'];
  app.post('/api/admin/couriers/:id/expenses', guard(ADM, async (ctx) => {
    const b = ctx.body;
    const day = b.spent_on == null || b.spent_on === '' ? null : (/^\d{4}-\d{2}-\d{2}$/.test(String(b.spent_on)) ? String(b.spent_on) : (() => { throw new HttpError(400, 'invalid_input', 'Date invalide'); })());
    ctx.status = 201;
    return { id: await fn('fn_admin_add_courier_expense', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), v.oneOf(b.kind, EXPENSE_KINDS, 'Type de charge'), v.int(b.amount, 'Montant', { min: 1, max: 1e9 }), day, v.optStr(b.note, 'Note', 200)) };
  }));
  app.post('/api/admin/expenses/:id/void', guard(ADM, async (ctx) => {
    await fn('fn_admin_void_courier_expense', ctx.user.id, v.uuid(ctx.params.id, 'Charge'), v.str(ctx.body.reason, 'Motif', { min: 3, max: 200 }));
  }));
  // Barèmes : règles communes des indépendants (lecture : ce sont les réglages existants) + barème des livreurs de Wallindirain (versions datées, historique conservé)
  app.get('/api/admin/courier-scales', guard(ADM, async () => {
    const keys = ['courier_share_bps', 'courier_pay', 'tour_share_bps', 'tour_extra_share_bps', 'tour_bonus_per_extra_order'];
    const settings = Object.fromEntries((await q('SELECT key, value::bigint AS value FROM settings WHERE key = ANY($1)', [keys])).map((r) => [r.key, Number(r.value)]));
    return {
      independent: settings,
      scales: await q(`SELECT s.id, s.per_delivery, s.tour_extra, s.failed_trip, s.prime_threshold, s.prime_amount, s.effective_from, s.note, s.created_at, a.full_name AS created_by_name,
          (s.effective_from <= now() AND s.id = (SELECT x.id FROM courier_pay_scales x WHERE x.courier_id IS NULL AND x.effective_from <= now() ORDER BY x.effective_from DESC, x.created_at DESC LIMIT 1)) AS in_force
          FROM courier_pay_scales s LEFT JOIN users a ON a.id = s.created_by WHERE s.courier_id IS NULL ORDER BY s.effective_from DESC, s.created_at DESC LIMIT 50`),
      min_zone_fee: Number((await q('SELECT COALESCE(min(fee), 0)::bigint AS f FROM delivery_rates WHERE active'))[0].f),
      avg_zone_fee: Number((await q('SELECT COALESCE(round(avg(fee)), 0)::bigint AS f FROM delivery_rates WHERE active AND fee > 0'))[0].f)
    };
  }));
  const scaleBody = (b) => ({
    per: v.int(b.per_delivery, 'Paie par livraison', { min: 0, max: 1e7 }), extra: v.int(b.tour_extra ?? 0, 'Supplément de tournée', { min: 0, max: 1e7 }), failed: v.int(b.failed_trip ?? 0, 'Déplacement à vide', { min: 0, max: 1e7 }),
    thr: v.int(b.prime_threshold ?? 0, 'Seuil de prime', { min: 0, max: 50 }), prime: v.int(b.prime_amount ?? 0, 'Prime', { min: 0, max: 1e7 })
  });
  app.post('/api/admin/courier-scales', guard(ADM, async (ctx) => {
    const b = ctx.body; const x = scaleBody(b);
    const eff = b.effective_from == null || b.effective_from === '' ? null : (Number.isNaN(Date.parse(b.effective_from)) ? (() => { throw new HttpError(400, 'invalid_input', 'Date d\'entrée en vigueur invalide'); })() : new Date(b.effective_from).toISOString());
    ctx.status = 201;
    return { id: await fn('fn_admin_set_company_scale', ctx.user.id, x.per, x.extra, x.failed, x.thr, x.prime, eff, v.optStr(b.note, 'Note', 200)) };
  }));
  // Accords individuels : conditions de rémunération propres à un compte, conclues avec la personne puis activées ici (datées, jamais rétroactives, historique conservé)
  const effDate = (x) => (x == null || x === '' ? null : (Number.isNaN(Date.parse(x)) ? (() => { throw new HttpError(400, 'invalid_input', 'Date d\'entrée en vigueur invalide'); })() : new Date(x).toISOString()));
  app.get('/api/admin/agreements/:id', guard(ADM, async (ctx) => {
    const id = v.uuid(ctx.params.id, 'Compte');
    const [u] = await q('SELECT id, full_name, role FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!u) throw new HttpError(404, 'not_found', 'Compte introuvable');
    if (u.role === 'courier') {
      const [{ kind }] = await q(`SELECT ${KIND_OF('$1::uuid')} AS kind`, [id]);
      const terms = await q(`SELECT s.id, s.per_delivery, s.tour_extra, s.failed_trip, s.prime_threshold, s.prime_amount, s.effective_from, s.note, s.created_at, a.full_name AS created_by_name
          FROM courier_pay_scales s LEFT JOIN users a ON a.id = s.created_by WHERE s.courier_id = $1 ORDER BY s.effective_from DESC, s.created_at DESC LIMIT 30`, [id]);
      const cur = terms.find((t) => new Date(t.effective_from) <= new Date());
      return { user: u, kind: 'courier', courier_kind: kind, terms, in_force: cur && Number(cur.per_delivery) > 0 ? cur : null, min_zone_fee: Number((await q('SELECT COALESCE(min(fee), 0)::bigint AS f FROM delivery_rates WHERE active'))[0].f) };
    }
    if (u.role === 'agent' || u.role === 'call_chief') {
      const terms = await q(`SELECT t.id, t.pay_per_order, t.effective_from, t.note, t.created_at, a.full_name AS created_by_name FROM agent_terms t LEFT JOIN users a ON a.id = t.created_by
          WHERE t.agent_id = $1 ORDER BY t.effective_from DESC, t.created_at DESC LIMIT 30`, [id]);
      const cur = terms.find((t) => new Date(t.effective_from) <= new Date());
      const [{ v: common }] = await q(`SELECT value AS v FROM settings WHERE key = 'agent_pay'`);
      return { user: u, kind: 'agent', terms, in_force: cur && cur.pay_per_order != null ? cur : null, common_pay: Number(common) };
    }
    throw new HttpError(400, 'invalid_input', 'Les accords individuels concernent les livreurs, les agents et les chefs d\'équipe');
  }));
  app.post('/api/admin/agreements/:id/courier', guard(ADM, async (ctx) => {
    const b = ctx.body; const x = scaleBody(b); ctx.status = 201;
    return { id: await fn('fn_admin_set_courier_agreement', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), x.per, x.extra, x.failed, x.thr, x.prime, effDate(b.effective_from), v.optStr(b.note, 'Note', 200)) };
  }));
  app.post('/api/admin/agreements/:id/courier/end', guard(ADM, async (ctx) => ({ id: await fn('fn_admin_end_courier_agreement', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), v.optStr(ctx.body.note, 'Note', 200)) })));
  app.post('/api/admin/agreements/:id/agent', guard(ADM, async (ctx) => {
    ctx.status = 201;
    return { id: await fn('fn_admin_set_agent_agreement', ctx.user.id, v.uuid(ctx.params.id, 'Agent'), v.int(ctx.body.pay, 'Rémunération', { min: 0, max: 1e6 }), effDate(ctx.body.effective_from), v.optStr(ctx.body.note, 'Note', 200)) };
  }));
  app.post('/api/admin/agreements/:id/agent/end', guard(ADM, async (ctx) => ({ id: await fn('fn_admin_end_agent_agreement', ctx.user.id, v.uuid(ctx.params.id, 'Agent'), v.optStr(ctx.body.note, 'Note', 200)) })));
  // Simulation avant activation : aucun effet, seulement un calcul (un seul endroit de calcul, côté serveur)
  app.post('/api/admin/courier-scales/simulate', guard(ADM, async (ctx) => {
    const b = ctx.body; const x = scaleBody(b.scale || {});
    const set = Object.fromEntries((await q(`SELECT key, value::bigint AS value FROM settings WHERE key IN ('courier_share_bps', 'courier_pay', 'tour_share_bps', 'tour_extra_share_bps')`)).map((r) => [r.key, Number(r.value)]));
    try {
      return simulatePay({ fee: b.fee, independent: { share_bps: set.courier_share_bps, fixed_pay: set.courier_pay, tour_share_bps: set.tour_share_bps, tour_extra_share_bps: set.tour_extra_share_bps },
        scale: { per_delivery: x.per, tour_extra: x.extra, failed_trip: x.failed, prime_threshold: x.thr, prime_amount: x.prime }, moto: b.moto, scenarios: b.scenarios });
    } catch (e) { if (e.code === 'invalid_input') throw new HttpError(400, 'invalid_input', e.message); throw e; }
  }));
  app.post('/api/admin/couriers/:id/profile', guard(ADM, async (ctx) => {
    const veh = ctx.body.vehicle;
    await fn('fn_admin_set_courier_profile', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), veh == null || veh === '' ? null : v.oneOf(veh, ['moto', 'velo', 'voiture', 'pied'], 'Véhicule'));
  }));
  app.post('/api/admin/couriers/:id/zones', guard(ADM, async (ctx) => {
    const list = ctx.body.communes;
    if (!Array.isArray(list) || list.length > 50 || !list.every((c) => typeof c === 'string' && c.length <= 60)) throw new HttpError(400, 'invalid_input', 'Liste de zones invalide');
    return fn('fn_admin_set_courier_zones', ctx.user.id, v.uuid(ctx.params.id, 'Livreur'), list);
  }));
  app.post('/api/admin/users', guard(ADM, async (ctx) => {
    const b = ctx.body;
    const pwErr = passwordProblem(b.password);
    if (pwErr) throw new HttpError(400, 'weak_password', pwErr);
    const role = v.oneOf(b.role, ['admin', 'agent', 'call_chief', 'courier', 'warehouse'], 'Rôle');
    // livreur : véhicule et zones réglés dès la création (contrôlés AVANT de créer le compte, pour ne pas laisser un compte à moitié configuré)
    let vehicle = null, communes = [];
    if (role === 'courier') {
      vehicle = b.vehicle == null || b.vehicle === '' ? null : v.oneOf(b.vehicle, ['moto', 'velo', 'voiture', 'pied'], 'Véhicule');
      communes = b.communes == null ? [] : b.communes;
      if (!Array.isArray(communes) || communes.length > 50 || !communes.every((c) => typeof c === 'string' && c.length <= 60)) throw new HttpError(400, 'invalid_input', 'Liste de zones invalide');
      const known = new Set((await q('SELECT commune FROM delivery_rates')).map((r) => r.commune));
      const bad = communes.find((c) => !known.has(c.trim()));
      if (bad !== undefined) throw new HttpError(400, 'invalid_input', `Zone inconnue : ${bad.slice(0, 60)}`);
    }
    const courierKind = role === 'courier' ? (b.courier_kind == null || b.courier_kind === '' ? 'independent' : v.oneOf(b.courier_kind, ['independent', 'company'], 'Catégorie du livreur')) : null;
    // numéro de versement (facultatif, les deux champs ensemble) : contrôlé avant de créer le compte
    const hasPayout = role === 'courier' && b.payout_phone != null && b.payout_phone !== '';
    const payoutMethod = hasPayout ? v.oneOf(b.payout_method, ['orange_money', 'mtn_momo'], 'Opérateur de versement') : null;
    const payoutPhone = hasPayout ? v.phone(b.payout_phone, 'Numéro de versement') : null;
    const name = v.str(b.name, 'Nom', { min: 2, max: 100 });
    const id = await fn('fn_admin_create_staff', ctx.user.id, v.phone(b.phone), name,
      role, await hashPassword(b.password), v.optStr(b.team, 'Call center', 80));
    if (hasPayout) await fn('fn_admin_update_user', ctx.user.id, id, name, null, payoutMethod, payoutPhone);
    if (role === 'courier') {
      if (courierKind === 'company') await fn('fn_admin_set_courier_kind', ctx.user.id, id, 'company', 'Catégorie choisie à la création');
      if (vehicle) await fn('fn_admin_set_courier_profile', ctx.user.id, id, vehicle);
      if (communes.length) await fn('fn_admin_set_courier_zones', ctx.user.id, id, communes);
    }
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
    categories: await q('SELECT id, name FROM product_categories WHERE active ORDER BY position, name'),
    products: await q(`SELECT p.id, p.name, p.description, p.category_id, p.supplier_price, p.margin_unit, p.storage, p.stock_qty, p.reserved_qty, p.status, p.created_at, u.full_name AS supplier_name,
        (SELECT COALESCE(jsonb_agg(pi.id ORDER BY pi.position), '[]'::jsonb) FROM product_images pi WHERE pi.product_id = p.id) AS image_ids
        FROM products p JOIN users u ON u.id = p.supplier_id WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.status::text = $1) ORDER BY p.created_at DESC LIMIT 300`, [ctx.query.status || null])
  })));
  // Finance : vue d'ensemble, informations de l'entreprise (en-tête des documents), export
  app.get('/api/admin/finance', guard(ADM, async (ctx) => {
    const today = new Date().toISOString().slice(0, 10), first = `${today.slice(0, 8)}01`;
    return { summary: await fn('fn_admin_finance_summary', ctx.user.id, optDate(ctx.query.from, 'Date de début') || first, optDate(ctx.query.to, 'Date de fin') || today) };
  }));
  app.get('/api/admin/company', guard(ADM, async (ctx) => ({ company: await fn('fn_company_get', ctx.user.id) })));
  app.post('/api/admin/company', guard(ADM, async (ctx) => {
    const b = ctx.body;
    await fn('fn_admin_set_company', ctx.user.id, v.str(b.legal_name, 'Nom de l\'entreprise', { min: 2, max: 150 }), v.optStr(b.address, 'Adresse', 250), v.optStr(b.phone, 'Téléphone', 40), v.optStr(b.email, 'E-mail', 120), v.optStr(b.nif, 'NIF', 60), v.optStr(b.rccm, 'RCCM', 60), v.optStr(b.footer_note, 'Mention de bas de page', 400));
    return { ok: true };
  }));
  app.get('/api/admin/invoices/export', guard(ADM, async (ctx) => {
    const rows = await q('SELECT * FROM fn_invoice_list($1, $2, $3, $4, NULL, 500)', [ctx.user.id, ctx.query.kind ? v.oneOf(ctx.query.kind, KINDS, 'Type') : null, optDate(ctx.query.from, 'Date de début'), optDate(ctx.query.to, 'Date de fin')]);
    const KIND_FR = { delivery: 'Facture de livraison', seller_services: 'Facture de services', supplier_statement: 'Relevé fournisseur', withdrawal_receipt: 'Reçu de retrait' };
    const cell = (x) => { const t = String(x ?? ''); return /^[=+\-@]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };   // pas d'injection de formule dans un tableur
    const csv = ['Numéro;Type;Date d\'émission;Titulaire;Commande;Début de période;Fin de période;Total (GNF)', ...rows.map((r) => [r.number, KIND_FR[r.kind], new Date(r.issued_at).toISOString().slice(0, 10), r.user_name, r.order_ref || '', r.period_from ? String(r.period_from).slice(0, 10) : '', r.period_to ? String(r.period_to).slice(0, 10) : '', r.total].map(cell).join(';'))].join('\r\n');
    ctx.headers['Content-Type'] = 'text/csv; charset=utf-8';
    ctx.headers['Content-Disposition'] = 'attachment; filename="journal-factures.csv"';
    ctx.headers['Cache-Control'] = 'no-store';
    return Buffer.from('﻿' + csv, 'utf8');
  }));

  // Inventaires du magasinier : décision de l'administrateur avant toute correction du stock
  app.get('/api/admin/stock-counts', guard(ADM, async () => ({
    counts: await q(`SELECT c.id, p.name AS product_name, u.full_name AS supplier_name, p.stock_qty, p.reserved_qty, c.expected_qty, c.counted_qty, c.delta, c.note, c.status, c.review_note, c.counted_at, c.reviewed_at, w.full_name AS by_name
        FROM stock_counts c JOIN products p ON p.id = c.product_id JOIN users u ON u.id = p.supplier_id LEFT JOIN users w ON w.id = c.counted_by
        WHERE c.status <> 'matched' ORDER BY (c.status = 'pending') DESC, c.counted_at DESC LIMIT 40`)
  })));
  app.post('/api/admin/stock-counts/:id/review', guard(ADM, async (ctx) => {
    await fn('fn_admin_review_stock_count', ctx.user.id, v.uuid(ctx.params.id, 'Inventaire'), ctx.body.approve === true, v.optStr(ctx.body.note, 'Note', 300));
  }));
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
    remittances: await q(`SELECT r.id, r.method, r.amount, r.status, r.received, r.reference, r.proof_id, r.handed_to, r.decision_note, r.created_at, r.decided_at, u.full_name AS courier_name, u.phone AS courier_phone
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
    settings: await q('SELECT key, value, label FROM settings ORDER BY key'), rates: await q('SELECT commune, fee, active, kind, parent, pickup_point FROM delivery_rates ORDER BY active DESC, commune'),
    categories: await q('SELECT c.id, c.name, c.position, c.active, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS products FROM product_categories c ORDER BY c.position, c.name') })));
  app.post('/api/admin/categories', guard(ADM, async (ctx) => ({ id: await fn('fn_admin_set_category', ctx.user.id, ctx.body.id ? v.uuid(ctx.body.id, 'Rayon') : null, v.str(ctx.body.name, 'Nom du rayon', { min: 2, max: 40 }), v.int(ctx.body.position ?? 50, 'Ordre', { min: 0, max: 999 }), ctx.body.active !== false) })));
  app.post('/api/admin/products/:id/category', guard(ADM, async (ctx) => { await fn('fn_set_product_category', ctx.user.id, v.uuid(ctx.params.id, 'Produit'), v.uuid(ctx.body.category_id, 'Rayon')); }));
  app.post('/api/admin/zones/classify', guard(ADM, async (ctx) => { const b = ctx.body; await fn('fn_admin_classify_zone', ctx.user.id, v.str(b.zone, 'Zone', { max: 60 }), v.oneOf(b.kind, ['commune', 'quartier', 'ville', 'autre'], 'Nature'), b.parent ? v.str(b.parent, 'Commune', { max: 60 }) : null, v.optStr(b.pickup_point, 'Gare voiture', 120)); }));
  app.post('/api/admin/zones/use-commune-fee', guard(ADM, async (ctx) => ({ activated: await fn('fn_admin_zones_use_commune_fee', ctx.user.id, v.str(ctx.body.commune, 'Commune', { max: 60 })) })));
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
