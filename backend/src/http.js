// Mini-framework HTTP : routage, JSON, erreurs homogènes, fichiers statiques.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { PgError } from './pg.js';
import { securityHeaders } from './security.js';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const STATUS_BY_CODE = {
  forbidden: 403, unauthorized: 401, not_found: 404, locked: 423, too_many: 429,
  already_taken: 409, duplicate_order: 409, invalid_state: 409, out_of_stock: 409, phone_taken: 409,
  too_late: 409, margin_locked: 409, insufficient_funds: 409, ledger_mismatch: 500, config: 500
};

/** Transforme une erreur SQL métier ("code|Message") en erreur HTTP. */
export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof PgError && e.code === 'WLD01') {
    const i = e.message.indexOf('|');
    const code = e.message.slice(0, i);
    return new HttpError(STATUS_BY_CODE[code] || 400, code, e.message.slice(i + 1));
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

export class App {
  constructor({ prod, staticDir, log }) {
    this.routes = []; this.prod = prod; this.staticDir = staticDir; this.log = log; this.hdr = securityHeaders(prod);
  }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      const data = isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(status, { ...this.hdr, 'Content-Type': isBuf || typeof body === 'string' ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': data.length, ...headers });
      res.end(data);
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = this.routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!route) {
          if (this.routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'method_not_allowed', 'Méthode non autorisée');
          throw new HttpError(404, 'not_found', 'Route inconnue');
        }
        const m = route.re.exec(url.pathname);
        let params;
        try { params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); }
        catch { throw new HttpError(400, 'bad_request', 'Adresse invalide'); }
        const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), headers: {}, cookies: [] };
        ctx.body = req.method === 'GET' ? {} : await readJson(req, route.opts.maxBody);
        const out = await route.handler(ctx);
        const headers = { 'Cache-Control': 'no-store', ...ctx.headers };
        if (ctx.cookies.length) headers['Set-Cookie'] = ctx.cookies;
        send(ctx.status || 200, out ?? { ok: true }, headers);
      } else {
        this.#static(url.pathname, req, send);
      }
    } catch (e) {
      const he = toHttpError(e);
      if (he) send(he.status, { error: he.code, message: he.message }, { 'Cache-Control': 'no-store' });
      else {
        this.log({ level: 'error', msg: 'erreur interne', path: url.pathname, err: String(e?.stack || e) });
        send(500, { error: 'internal', message: 'Erreur interne. Réessayez ou contactez le support.' }, { 'Cache-Control': 'no-store' });
      }
    }
    if (!url.pathname.startsWith('/api/') || this.prod) this.log({ level: 'info', m: req.method, p: url.pathname, s: res.statusCode, ms: Date.now() - started });
  }

  #static(pathname, req, send) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Méthode non autorisée');
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad_request', 'Chemin invalide'); }
    if (rel.includes('\0')) throw new HttpError(400, 'bad_request', 'Chemin invalide');
    let file = path.normalize(path.join(this.staticDir, rel));
    if (!file.startsWith(this.staticDir + path.sep) && file !== this.staticDir) throw new HttpError(403, 'forbidden', 'Accès refusé');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(this.staticDir, 'index.html');   // application mono-page
    const ext = path.extname(file);
    // pages, scripts et styles : le navigateur revalide à chaque fois (ETag), donc une mise à jour est visible tout de suite
    const revalidate = ['.html', '.js', '.css', '.webmanifest'].includes(ext);
    const body = fs.readFileSync(file);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"';
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag,
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400' };
    if (req.headers['if-none-match'] === etag) return send(304, Buffer.alloc(0), headers);
    send(200, body, headers);
  }
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > maxBytes) throw new HttpError(413, 'too_large', 'Requête trop volumineuse'); chunks.push(c); }
  if (!size) return {};
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'bad_content_type', 'JSON attendu');
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw new HttpError(400, 'bad_json', 'JSON invalide'); }
}

// --- validation d'entrées ---
export const v = {
  str(x, name, { min = 1, max = 300 } = {}) {
    if (typeof x !== 'string' || x.trim().length < min || x.length > max) throw new HttpError(400, 'invalid_input', `${name} invalide`);
    return x.trim();
  },
  optStr(x, name, max = 500) { return x == null || x === '' ? null : v.str(x, name, { min: 1, max }); },
  int(x, name, { min = 0, max = 1e12 } = {}) {
    const n = typeof x === 'string' && /^-?\d+$/.test(x) ? Number(x) : x;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_input', `${name} invalide`);
    return n;
  },
  uuid(x, name) {
    if (typeof x !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)) throw new HttpError(400, 'invalid_input', `${name} invalide`);
    return x.toLowerCase();
  },
  phone(x, name = 'Numéro') {
    const s = typeof x === 'string' ? x.replace(/[\s.-]/g, '').replace(/^(\+224|00224)/, '') : '';
    if (!/^[0-9]{9}$/.test(s)) throw new HttpError(400, 'invalid_input', `${name} invalide (9 chiffres, ex. 624390707)`);
    return s;
  },
  email(x, name = 'Adresse e-mail') {
    const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (s.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new HttpError(400, 'invalid_input', `${name} invalide (ex. nom@exemple.com)`);
    return s;
  },
  // numéro (9 chiffres) OU adresse e-mail : renvoie la forme normalisée
  identifier(x, name = 'Numéro ou adresse e-mail') {
    return typeof x === 'string' && x.includes('@') ? v.email(x, name) : v.phone(x, name);
  },
  oneOf(x, list, name) { if (!list.includes(x)) throw new HttpError(400, 'invalid_input', `${name} invalide`); return x; },
  bool(x, name) { if (typeof x !== 'boolean') throw new HttpError(400, 'invalid_input', `${name} invalide`); return x; }
};

export function page(query) {
  const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}
