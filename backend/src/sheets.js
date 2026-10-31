// Import des commandes d'un vendeur depuis un Google Sheet (partagé en lecture) ou un fichier CSV collé.
// Sécurité : on ne télécharge JAMAIS une adresse donnée par l'utilisateur ; on n'en extrait que l'identifiant du classeur
// et on reconstruit nous-mêmes l'adresse docs.google.com (pas d'accès à des adresses internes).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { HttpError } from './http.js';

export const MAX_ROWS = 300;
const MAX_BYTES = 1_000_000;

export function parseSheetUrl(url) {
  // tolère les espaces, l'absence de « https:// » et les liens copiés avec plusieurs comptes Google (/u/0/)
  let raw = String(url || '').trim();
  if (/^docs\.google\.com\//i.test(raw)) raw = `https://${raw}`;
  if (/^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\//.test(raw)) throw new HttpError(400, 'invalid_input', 'Ce lien est un lien « Publier sur le Web ». Ouvrez votre Google Sheet, puis copiez le lien du bouton Partager (il contient /d/ suivi d\'un long code puis /edit).');
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/[0-9]{1,2}\/)?d\/([A-Za-z0-9_-]{20,120})(?:[/?#].*)?$/.exec(raw);
  if (!m) throw new HttpError(400, 'invalid_input', 'Collez le lien complet de votre Google Sheet (https://docs.google.com/spreadsheets/d/…)');
  const gid = /[?#&]gid=([0-9]{1,12})/.exec(raw)?.[1] || '0';
  return { id: m[1], gid };
}

// Google redirige l'export vers un domaine à lui : on suit au plus 3 redirections, et seulement vers du https Google
const googleHost = (h) => h === 'google.com' || h.endsWith('.google.com') || h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com');

async function getGoogle(start, fetchFn) {
  let url = start, res;
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
  return { res, text, host: new URL(url).hostname };
}
const unusable = (r) => !r.res.ok || /^\s*<(!doctype|html)/i.test(r.text);

/** Lit le Google Sheet en CSV : d'abord l'export classique, puis (si Google le refuse) le point d'accès « gviz », qui marche aussi pour certains fichiers. */
export async function fetchSheetCsv({ id, gid }, fetchFn = fetch) {
  const first = await getGoogle(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, fetchFn);
  if (!unusable(first)) return first.text;
  const second = await getGoogle(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`, fetchFn).catch(() => null);
  if (second && !unusable(second)) return second.text;
  const st = first.res.status;
  if (st === 404) throw new HttpError(400, 'sheet_not_found', 'Google ne trouve pas ce Sheet (code 404). Vérifiez que le lien est complet et que le fichier n\'a pas été supprimé.');
  if (st === 400 && !/accounts\.google\.com/.test(first.host)) throw new HttpError(400, 'sheet_unsupported', 'Google ne peut pas exporter ce fichier (code 400). S\'il s\'agit d\'un fichier Excel, ouvrez-le dans Google Sheets puis faites Fichier → « Enregistrer en tant que Google Sheets », et collez le lien du nouveau fichier.');
  const login = /accounts\.google\.com/.test(first.host) || /ServiceLogin|accounts\.google\.com/.test(first.text.slice(0, 5000));
  throw new HttpError(400, 'sheet_private', `Ce Google Sheet n'est pas lisible depuis Wallindirain (${login ? 'Google demande une connexion' : `code Google : ${st}`}). Dans Google Sheets : Partager → Accès général → « Toute personne disposant du lien » → rôle « Lecteur », puis réessayez. Un compte professionnel (Workspace) peut bloquer ce partage : utilisez alors un compte Gmail personnel, ou collez le tableau en CSV.`);
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

// ---------- Fichier Excel (.xlsx) : lecture minimale sans dépendance (zip + XML), première feuille uniquement ----------
const XML_MAX = 5_000_000;
const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const badXlsx = () => new HttpError(400, 'invalid_input', 'Fichier Excel illisible : enregistrez-le au format .xlsx (ou en CSV) puis réessayez');
export function xlsxToRows(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) throw badXlsx();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw badXlsx();
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw badXlsx();
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    entries[buf.toString('utf8', p + 46, p + 46 + nlen)] = { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), lho: buf.readUInt32LE(p + 42) };
    p += 46 + nlen + elen + clen;
  }
  const read = (name) => {
    const e = entries[name]; if (!e) return null;
    if (e.usize > XML_MAX) throw new HttpError(413, 'too_large', 'Fichier Excel trop volumineux');
    if (e.lho + 30 > buf.length || buf.readUInt32LE(e.lho) !== 0x04034b50) throw badXlsx();
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    const raw = buf.subarray(start, start + e.csize);
    try { return (e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: XML_MAX }) : null)?.toString('utf8') ?? null; } catch { throw badXlsx(); }
  };
  const sheetName = Object.keys(entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]))[0];
  const xml = sheetName && read(sheetName);
  if (!xml) throw badXlsx();
  const shared = [];
  const ss = read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unxml([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cm[1]); if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(cm[1])?.[1];
      const body = cm[2] || '';
      let val = '';
      if (type === 'inlineStr') val = unxml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else { const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''; val = type === 's' ? (shared[Number(v)] ?? '') : unxml(v); }
      const c = colIdx(ref[1]); if (c > 60) continue;
      while (row.length < c) row.push('');
      row[c] = val;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
