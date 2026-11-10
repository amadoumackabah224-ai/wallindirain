// Outils Pro de Mes finances : export CSV, règles automatiques de catégorie, import de transactions (CSV).
import { h, ask, confirmBox, action, toast, errToast, empty, liveView } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { loadCats, catLabel, catOptions } from './pf-cats.js';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** Lit un texte CSV (séparateur ; , ou tabulation, guillemets) → tableau de lignes. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const sep = [';', '\t', ','].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const toIsoDate = (s) => {
  const t = String(s).trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/.exec(t))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
};
const toNumber = (s) => { const t = String(s).replace(/[\s ]/g, '').replace(/[A-Za-z]/g, ''); return Number((t.includes(',') && !t.includes('.') ? t.replace(',', '.') : t.replace(/,(?=\d{3}\b)/g, ''))); };
/** Colonnes reconnues : date, montant, type (facultatif), catégorie (facultatif), note/libellé (facultatif). Montant négatif = dépense. */
export function mapRows(rows, decimals) {
  if (rows.length < 2) return { items: [], problem: 'Le fichier est vide ou ne contient que des titres.' };
  const head = rows[0].map(norm);
  const find = (...names) => head.findIndex((c) => names.some((n) => c.includes(n)));
  const iDate = find('date'), iAmt = find('montant', 'amount', 'somme'), iType = find('type', 'sens'), iCat = find('categorie', 'category'), iNote = find('note', 'libelle', 'description', 'label');
  if (iDate < 0 || iAmt < 0) return { items: [], problem: 'Il faut au moins une colonne « Date » et une colonne « Montant » sur la première ligne.' };
  const items = rows.slice(1).map((r) => {
    const n = toNumber(r[iAmt] ?? ''); const t = iType >= 0 ? norm(r[iType] ?? '') : '';
    const expense = t ? /depense|sortie|debit|expense/.test(t) : n < 0;
    return { date: toIsoDate(r[iDate] ?? ''), kind: expense ? 'expense' : 'income', amount: Math.round(Math.abs(n) * 10 ** decimals), category: iCat >= 0 ? (r[iCat] || '').trim() : '', note: iNote >= 0 ? (r[iNote] || '').trim() : '' };
  });
  return { items, problem: '' };
}

export function toolsScreen({ go, head, card, st }) {
  const needPro = st.tier !== 'pro';
  return liveView(async () => { await loadCats().catch(() => null); const [a, r] = await Promise.all([get('/pf/accounts'), get('/pf/rules')]); return { accounts: a.accounts.filter((x) => !x.archived_at), rules: r.rules || [] }; }, (d, refresh) => {
    const accOpts = d.accounts.filter((a) => !a.auto).map((a) => h('option', { value: a.id }, a.currency && a.currency !== 'GNF' ? `${a.name} · ${a.currency}` : a.name));
    const sel = (opts, all) => h('select', { class: 'pf-entry-sel pf-tools-sel' }, all && h('option', { value: '' }, all), opts);
    const lock = needPro && h('p', { class: 'pf-note' }, 'Ces outils font partie de la formule Pro.');

    // --- Export ---
    const from = h('input', { type: 'date', class: 'pf-entry-sel', value: monthStart(), 'aria-label': 'Du' }), to = h('input', { type: 'date', class: 'pf-entry-sel', value: today(), 'aria-label': 'Au' });
    const exAcc = sel(accOpts, 'Tous les comptes');
    const exportCsv = action(async () => {
      const qs = new URLSearchParams({ ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}), ...(exAcc.value ? { account: exAcc.value } : {}) });
      const res = await fetch(`/api/pf/export?${qs}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Export impossible.'); }
      const url = URL.createObjectURL(await res.blob()); const link = h('a', { href: url, download: `mes-finances-${today()}.csv` }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, { ok: 'Fichier téléchargé' });

    // --- Règles ---
    const addRule = action(async () => {
      await loadCats().catch(() => null);
      const v = await ask({ title: 'Nouvelle règle', text: 'Quand la note d\'une transaction contient ce mot, la catégorie choisie est proposée automatiquement (et utilisée à l\'import).', submit: 'Créer la règle', fields: [
        { name: 'contains', label: 'Mot à repérer (ex. orange)', maxlength: 40 },
        { name: 'kind', label: 'Pour', type: 'select', options: [['', 'Revenus et dépenses'], ['expense', 'Dépenses seulement'], ['income', 'Revenus seulement']], value: 'expense' },
        { name: 'category', label: 'Catégorie', type: 'select', options: [...catOptions('expense'), ...catOptions('income')], value: catOptions('expense')[0]?.[0] }] });
      if (!v) return;
      await post('/pf/rules', { contains: v.contains, kind: v.kind || null, category: v.category });
    }, { ok: 'Règle créée', refresh });
    const delRule = (r) => action(async () => { if (await confirmBox('Supprimer cette règle ?', 'Les transactions déjà enregistrées ne changent pas.', 'Supprimer', true)) await post(`/pf/rules/${r.id}/remove`); }, { ok: 'Règle supprimée', refresh });

    // --- Import ---
    const imAcc = sel(accOpts); const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv', class: 'pf-file', 'aria-label': 'Fichier CSV' });
    const preview = h('p', { class: 'pf-note' }); let pending = [];
    const readFile = async () => {
      pending = []; preview.textContent = ''; if (!file.files[0]) return;
      const acc = d.accounts.find((a) => a.id === imAcc.value); const dec = Number(acc?.decimals || 0);
      const { items, problem } = mapRows(parseCsv(await file.files[0].text()), dec);
      if (problem) { preview.textContent = problem; return; }
      pending = items.slice(0, 500);
      const bad = pending.filter((i) => !i.date || !(i.amount > 0)).length;
      preview.textContent = `${pending.length} ligne(s) lues${items.length > 500 ? ` (seules les 500 premières seront importées)` : ''}${bad ? ` · ${bad} semble(nt) invalide(s) et sera(ont) ignorée(s)` : ''}.`;
    };
    file.addEventListener('change', readFile); imAcc.addEventListener('change', readFile);
    const doImport = action(async () => {
      if (!pending.length) { toast('Choisissez d\'abord un fichier CSV.', 'bad'); return; }
      const r = await post('/pf/import', { account_id: imAcc.value, rows: pending });
      pending = []; file.value = '';
      preview.textContent = `${r.added} transaction(s) ajoutée(s)${r.skipped ? `, ${r.skipped} ignorée(s)` : ''}.${r.errors?.length ? ` ${r.errors.join(' · ')}` : ''}`;
    }, { ok: 'Import terminé' });

    return h('div', {}, head('Outils Pro', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' }, lock,
      card('Exporter en CSV', h('p', { class: 'pf-note' }, 'Un fichier à ouvrir dans Excel ou à donner à votre comptable.'),
        h('div', { class: 'pf-entry-list' }, h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Du'), from), h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Au'), to), h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Compte'), exAcc)),
        h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: exportCsv }, 'Télécharger le fichier')),
      card('Règles automatiques', d.rules.length ? h('section', { class: 'pf-card flush' }, d.rules.map((r) => h('div', { class: 'pf-row' }, h('span', { class: 'pf-row-main' }, h('b', {}, `« ${r.contains} »`), h('small', {}, `${r.kind === 'income' ? 'Revenus' : r.kind === 'expense' ? 'Dépenses' : 'Tout'} → ${catLabel(r.category)}`)), h('button', { class: 'pf-mini', type: 'button', onclick: delRule(r) }, 'Supprimer')))) : h('p', { class: 'pf-note' }, 'Aucune règle. Exemple : « orange » → Téléphone et internet.'),
        h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: addRule }, 'Ajouter une règle')),
      card('Importer des transactions', h('p', { class: 'pf-note' }, 'Fichier CSV avec une première ligne de titres : Date, Montant (négatif = dépense), et si vous voulez Type, Catégorie, Note. Les lignes sans catégorie utilisent vos règles, sinon « Autre dépense » ou « Revenus non affectés ».'),
        d.accounts.length ? [h('div', { class: 'pf-entry-list' }, h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Compte'), imAcc)), file, preview, h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: doImport }, 'Importer')] : empty('bank', 'Créez d\'abord un compte.'))));
  });
}
