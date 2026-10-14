// Mots de passe (PBKDF2), jetons de session, limitation de débit, cookies, en-têtes de sécurité.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);
const ITERATIONS = 210_000;   // recommandation OWASP pour PBKDF2-HMAC-SHA512

// ---------- Mots de passe ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await pbkdf2(String(password).normalize('NFKC'), salt, ITERATIONS, 64, 'sha512');
  return `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  if (!Number.isInteger(iter) || iter < 1000 || iter > 5_000_000) return false;
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  if (!expected.length) return false;
  const dk = await pbkdf2(String(password).normalize('NFKC'), salt, iter, expected.length, 'sha512');
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

/** Hash valide mais inconnu de tous : vérifier un numéro inexistant coûte le même temps qu'un vrai. */
export const DUMMY_HASH = `pbkdf2$${ITERATIONS}$${Buffer.alloc(16, 7).toString('base64')}$${Buffer.alloc(64, 9).toString('base64')}`;

/** Renvoie un message d'erreur, ou null si le mot de passe est acceptable. */
export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
  if (p.length > 128) return 'Mot de passe trop long (128 caractères maximum)';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Le mot de passe doit contenir des lettres et des chiffres';
  if (/^(.)\1+$/.test(p) || /^(motdepasse|password|azerty|qwerty)/i.test(p)) return 'Mot de passe trop simple';
  return null;
}

// ---------- Sessions ----------
export const newToken = () => crypto.randomBytes(32).toString('base64url');
/** Seule l'empreinte du jeton est stockée : une fuite de la base ne donne aucune session valide. */
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ---------- Limitation de débit (en mémoire, par processus) ----------
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    }, 60_000);
    this.timer.unref();
  }
  /** Renvoie false quand la limite est dépassée. */
  allow(key, max, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count += 1;
    return b.count <= max;
  }
  reset() { this.buckets.clear(); }
}

// ---------- Cookies ----------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie illisible : ignoré */ }
  }
  return out;
}

// ---------- En-têtes de sécurité ----------
export function securityHeaders(prod) {
  const h = {
    // aucune ressource externe, aucun script ni style en ligne
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
      + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (prod) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}
