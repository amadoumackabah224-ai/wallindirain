// Client PostgreSQL minimal, sans dépendance (protocole v3, requêtes étendues, SCRAM-SHA-256).
// Pourquoi : zéro dépendance npm = pas de risque de chaîne d'approvisionnement.
// Toutes les valeurs passent en paramètres liés ($1, $2…) : aucune injection SQL possible.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const OID = { BOOL: 16, BYTEA: 17, INT8: 20, INT2: 21, INT4: 23, OID: 26, JSON: 114, NUMERIC: 1700, JSONB: 3802 };

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Erreur PostgreSQL');
    this.code = fields.C;
    this.detail = fields.D;
    this.fields = fields;
  }
}

function parseValue(oid, text) {
  if (text === null) return null;
  switch (oid) {
    case OID.INT2: case OID.INT4: case OID.OID: return Number(text);
    case OID.INT8: case OID.NUMERIC: {
      const n = Number(text);
      if (!Number.isSafeInteger(n) && Number.isInteger(n)) throw new Error('Entier trop grand : ' + text);
      return n;
    }
    case OID.BOOL: return text === 't';
    case OID.BYTEA: return Buffer.from(text.startsWith('\\x') ? text.slice(2) : '', 'hex');
    case OID.JSON: case OID.JSONB: return JSON.parse(text);
    default: return text;
  }
}

function encodeParam(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');            // octets (bytea), en hexadécimal
  // tableau JavaScript -> tableau PostgreSQL ({"a","b"}) ; un objet reste du JSON
  if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Writer {
  constructor() { this.parts = []; }
  byte(b) { this.parts.push(Buffer.from([b])); return this; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.parts.push(b); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  cstr(s) { this.parts.push(Buffer.from(s + '\0', 'utf8')); return this; }
  raw(buf) { this.parts.push(buf); return this; }
  build() { return Buffer.concat(this.parts); }
}

function message(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function readFields(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length && buf[i] !== 0) {
    const key = String.fromCharCode(buf[i]);
    const end = buf.indexOf(0, i + 1);
    out[key] = buf.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return out;
}

const xor = (a, b) => { const r = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) r[i] = a[i] ^ b[i]; return r; };
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

export class Connection {
  constructor(opts) {
    this.opts = opts;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.queue = [];
    this.closed = false;
    this.params = {};
  }

  async connect() {
    const { host, port, ssl } = this.opts;
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      if (host.startsWith('/')) this.sock = net.connect({ path: `${host}/.s.PGSQL.${port}` });
      else this.sock = net.connect({ host, port });
      this.sock.once('error', onErr);
      this.sock.once('connect', () => { this.sock.off('error', onErr); resolve(); });
    });
    if (ssl) await this.#upgradeTls();
    this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.#pump(); });
    this.sock.on('error', (e) => this.#fail(e));
    this.sock.on('close', () => this.#fail(new Error('Connexion PostgreSQL fermée')));
    await this.#startup();
  }

  async #upgradeTls() {
    const req = Buffer.alloc(8); req.writeInt32BE(8); req.writeInt32BE(80877103, 4);
    this.sock.write(req);
    const ans = await new Promise((res, rej) => { this.sock.once('data', res); this.sock.once('error', rej); });
    if (ans.toString('latin1', 0, 1) !== 'S') throw new Error('Le serveur PostgreSQL refuse TLS');
    this.sock = tls.connect({ socket: this.sock, servername: this.opts.host, rejectUnauthorized: this.opts.ssl !== 'insecure' });
    await new Promise((res, rej) => { this.sock.once('secureConnect', res); this.sock.once('error', rej); });
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); }
    for (const q of this.queue) q.reject?.(err);
    this.queue = [];
  }

  #pump() {
    for (;;) {
      if (this.buf.length < 5) return;
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (msg.type === 'S') { // ParameterStatus
        const [k, v] = msg.body.toString('utf8').split('\0'); this.params[k] = v; continue;
      }
      if (msg.type === 'N' || msg.type === 'A') continue; // notices
      if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(msg); } else this.queue.push(msg);
    }
  }

  #next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async #startup() {
    const w = new Writer().int32(196608).cstr('user').cstr(this.opts.user).cstr('database').cstr(this.opts.database)
      .cstr('client_encoding').cstr('UTF8').cstr('application_name').cstr('wallindirain').byte(0).build();
    const head = Buffer.alloc(4); head.writeInt32BE(w.length + 4);
    this.sock.write(Buffer.concat([head, w]));
    for (;;) {
      const m = await this.#next();
      if (m.type === 'E') throw new PgError(readFields(m.body));
      if (m.type === 'R') await this.#auth(m.body);
      else if (m.type === 'K') continue;
      else if (m.type === 'Z') return;
    }
  }

  async #auth(body) {
    const kind = body.readInt32BE(0);
    if (kind === 0) return;
    if (kind === 3) { this.sock.write(message('p', Buffer.from(this.opts.password + '\0'))); return; }
    if (kind === 5) {
      const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
      const h = 'md5' + md5(Buffer.concat([Buffer.from(md5(this.opts.password + this.opts.user)), body.subarray(4, 8)]));
      this.sock.write(message('p', Buffer.from(h + '\0'))); return;
    }
    if (kind === 10) return this.#scram(body);
    throw new Error('Méthode d\'authentification PostgreSQL non prise en charge : ' + kind);
  }

  async #scram(body) {
    if (!body.toString('utf8', 4).includes('SCRAM-SHA-256')) throw new Error('SCRAM-SHA-256 non proposé');
    const nonce = crypto.randomBytes(18).toString('base64');
    const first = `n=,r=${nonce}`;
    const init = new Writer().cstr('SCRAM-SHA-256').int32(Buffer.byteLength('n,,' + first)).raw(Buffer.from('n,,' + first)).build();
    this.sock.write(message('p', init));
    let m = await this.#next();
    if (m.type === 'E') throw new PgError(readFields(m.body));
    const serverFirst = m.body.subarray(4).toString('utf8');
    const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
    if (!attrs.r.startsWith(nonce)) throw new Error('Nonce SCRAM invalide');
    const salt = Buffer.from(attrs.s, 'base64');
    const salted = crypto.pbkdf2Sync(Buffer.from(String(this.opts.password).normalize('NFKC')), salt, Number(attrs.i), 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const withoutProof = `c=biws,r=${attrs.r}`;
    const authMsg = `${first},${serverFirst},${withoutProof}`;
    const proof = xor(clientKey, hmac(sha256(clientKey), authMsg)).toString('base64');
    this.sock.write(message('p', Buffer.from(`${withoutProof},p=${proof}`)));
    m = await this.#next();
    if (m.type === 'E') throw new PgError(readFields(m.body));
    const serverFinal = m.body.subarray(4).toString('utf8');
    const expected = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
    if (serverFinal !== `v=${expected}`) throw new Error('Signature serveur SCRAM invalide');
  }

  /** Exécute une requête paramétrée. Renvoie { rows, rowCount }. */
  async query(text, params = []) {
    if (this.closed) throw this.error || new Error('Connexion fermée');
    const parse = message('P', new Writer().cstr('').cstr(text).int16(0).build());
    const bw = new Writer().cstr('').cstr('').int16(0).int16(params.length);
    for (const p of params) {
      const e = encodeParam(p);
      if (e === null) bw.int32(-1);
      else { const b = Buffer.from(e, 'utf8'); bw.int32(b.length).raw(b); }
    }
    bw.int16(0);
    const bind = message('B', bw.build());
    const describe = message('D', new Writer().byte(0x50).cstr('').build());
    const exec = message('E', new Writer().cstr('').int32(0).build());
    const sync = message('S', Buffer.alloc(0));
    this.sock.write(Buffer.concat([parse, bind, describe, exec, sync]));

    let fields = [];
    const rows = [];
    let rowCount = 0;
    let err = null;
    for (;;) {
      const m = await this.#next();
      if (m.type === 'T') {
        fields = [];
        let o = 2;
        const n = m.body.readInt16BE(0);
        for (let i = 0; i < n; i++) {
          const end = m.body.indexOf(0, o);
          const name = m.body.toString('utf8', o, end);
          o = end + 1;
          const oid = m.body.readInt32BE(o + 6);
          fields.push({ name, oid });
          o += 18;
        }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0);
        let o = 2;
        const row = {};
        for (let i = 0; i < n; i++) {
          const len = m.body.readInt32BE(o); o += 4;
          let val = null;
          if (len >= 0) { val = m.body.toString('utf8', o, o + len); o += len; }
          row[fields[i].name] = parseValue(fields[i].oid, val);
        }
        rows.push(row);
      } else if (m.type === 'C') {
        const tag = m.body.toString('utf8').replace(/\0$/, '');
        rowCount = Number(tag.split(' ').pop()) || 0;
      } else if (m.type === 'E') {
        err = new PgError(readFields(m.body));
      } else if (m.type === 'Z') {
        this.txStatus = String.fromCharCode(m.body[0]);
        if (err) throw err;
        return { rows, rowCount };
      }
    }
  }

  close() {
    if (this.closed) return;
    try { this.sock.write(message('X', Buffer.alloc(0))); } catch { /* déjà fermée */ }
    this.sock.end();
    this.closed = true;
  }
}

/** Pool de connexions avec transactions. */
export class Pool {
  constructor(opts) {
    this.opts = { host: '127.0.0.1', port: 5432, max: 10, ...opts };
    this.idle = [];
    this.total = 0;
    this.waiting = [];
  }

  async #acquire() {
    while (this.idle.length) {
      const c = this.idle.pop();
      if (!c.closed) return c;
      this.total--;
    }
    if (this.total < this.opts.max) {
      this.total++;
      const c = new Connection(this.opts);
      try { await c.connect(); } catch (e) { this.total--; throw e; }
      return c;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  #release(c) {
    if (c.closed) { this.total--; if (this.waiting.length && this.total < this.opts.max) this.#acquire().then(this.waiting.shift()); return; }
    if (this.waiting.length) this.waiting.shift()(c); else this.idle.push(c);
  }

  async query(text, params) {
    const c = await this.#acquire();
    try { return await c.query(text, params); } finally { this.#release(c); }
  }

  /** Exécute fn(client) dans une transaction ; annule tout en cas d'erreur. */
  async tx(fn) {
    const c = await this.#acquire();
    try {
      await c.query('BEGIN');
      try {
        const r = await fn({ query: (t, p) => c.query(t, p) });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        if (!c.closed) { try { await c.query('ROLLBACK'); } catch { c.close(); } }
        throw e;
      }
    } finally { this.#release(c); }
  }

  async end() {
    for (const c of this.idle) c.close();
    this.idle = [];
  }
}
