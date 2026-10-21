// Import des commandes d'un vendeur depuis un Google Sheet (partagé en lecture) ou un fichier CSV collé.
// Sécurité : on ne télécharge JAMAIS une adresse donnée par l'utilisateur ; on n'en extrait que l'identifiant du classeur
// et on reconstruit nous-mêmes l'adresse docs.google.com (pas d'accès à des adresses internes).
import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const MAX_ROWS = 300;
const MAX_BYTES = 1_000_000;

export function parseSheetUrl(url) {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:[/?#].*)?$/.exec(String(url || '').trim());
  if (!m) throw new HttpError(400, 'invalid_input', 'Collez le lien complet de votre Google Sheet (https://docs.google.com/spreadsheets/d/…)');
  const gid = /[?#&]gid=([0-9]{1,12})/.exec(String(url))?.[1] || '0';
  return { id: m[1], gid };
}

// Google redirige l'export vers un domaine à lui : on suit au plus 3 redirections, et seulement vers du https Google
const googleHost = (h) => h === 'google.com' || h.endsWith('.google.com') || h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com');

export async function fetchSheetCsv({ id, gid }, fetchFn = fetch) {
  let url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  let res;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/csv' } });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = new URL(res.headers.get('location') || '', url);
      if (next.protocol !== 'https:' || !googleHost(next.hostname) || hop === 3) throw new Error('redirection refusée');
      url = next.href;
    }
  } catch { throw new HttpError(502, 'sheet_unreachable', 'Impossible de joindre Google Sheets. Réessayez, ou collez le contenu en CSV.'); }
  const text = (await res.text()).slice(0, MAX_BYTES + 1);
  if (text.length > MAX_BYTES) throw new HttpError(413, 'too_large', 'Tableau trop volumineux');
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new HttpError(400, 'sheet_private', 'Ce Google Sheet n\'est pas lisible : partagez-le avec « Toute personne disposant du lien » en lecture seule, puis réessayez.');
  }
  return text;
}

/** CSV simple (guillemets, virgules ou points-virgules, retours à la ligne dans les champs). */
export function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') && !first.includes(',') ? '\t' : ',');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES = {
  name: ['nom', 'nom du client', 'client', 'name', 'customer'],
  phone: ['telephone', 'tel', 'numero', 'phone', 'telephone du client', 'numero du client'],
  zone: ['zone', 'quartier', 'ville', 'quartier ou ville', 'quartier ville', 'commune', 'lieu'],
  address: ['adresse', 'adresse de livraison', 'address', 'repere'],
  product: ['produit', 'article', 'product'],
  qty: ['quantite', 'qte', 'qty', 'quantity'],
  price: ['prix', 'prix unitaire', 'price', 'prix de vente'],
  confirmed: ['confirme', 'deja confirme', 'client confirme', 'confirmed', 'deja appele'],
  note: ['note', 'remarque', 'commentaire']
};

/** Transforme le tableau en lignes normalisées + erreurs de colonnes. */
export function mapRows(rows) {
  if (rows.length < 2) throw new HttpError(400, 'invalid_input', 'Le tableau doit contenir une ligne d\'en-têtes puis au moins une commande');
  const head = rows[0].map(norm);
  const idx = {};
  for (const [key, names] of Object.entries(ALIASES)) idx[key] = head.findIndex((h) => names.includes(h));
  const missing = ['name', 'phone', 'address', 'product'].filter((k) => idx[k] < 0);
  if (missing.length) throw new HttpError(400, 'invalid_input', `Colonnes manquantes : ${missing.map((k) => ({ name: 'nom', phone: 'téléphone', address: 'adresse', product: 'produit' }[k])).join(', ')}. En-têtes attendus : nom, téléphone, quartier ou ville, adresse, produit, quantité, prix, confirmé.`);
  if (rows.length - 1 > MAX_ROWS) throw new HttpError(413, 'too_large', `Trop de lignes (${MAX_ROWS} maximum à la fois)`);
  const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
  return rows.slice(1).map((r, i) => ({
    line: i + 2, name: get(r, 'name'), phone: get(r, 'phone'), zone: get(r, 'zone'), address: get(r, 'address'), product: get(r, 'product'),
    qty: get(r, 'qty'), price: get(r, 'price'), confirmed: get(r, 'confirmed'), note: get(r, 'note')
  }));
}

export const phone9 = (s) => { const d = String(s).replace(/\D/g, ''); return (d.length === 12 && d.startsWith('224') ? d.slice(3) : d); };
export const isYes = (s) => ['oui', 'o', 'yes', 'y', '1', 'x', 'vrai', 'true', 'ok', 'confirme'].includes(norm(s));
export const parsePrice = (s) => { const d = String(s).replace(/[^\d]/g, ''); return d ? Number(d) : null; };
export const rowHash = (sellerId, r) => crypto.createHash('sha256').update(JSON.stringify([sellerId, r.name.toLowerCase(), phone9(r.phone), norm(r.zone), norm(r.address), norm(r.product), r.qty || '1', parsePrice(r.price)])).digest('hex');
