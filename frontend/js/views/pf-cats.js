// « Mes finances » : profil et catégories (migration 054). Arbre système + catégories de la personne, modifiables.
import { h, ask, action } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

let state = { profile: null, items: [], by: {} };
const PROFILE_LABEL = { personal: 'Personnel', business: 'Commerce / petite entreprise', both: 'Les deux' };
const ICONS = ['🛍️', '📦', '🛠️', '💼', '🏢', '👥', '🧾', '🏦', '💰', '📈', '🍽️', '🚗', '🏠', '📱', '❤️', '👪', '🛒', '🐖', '🎓', '✈️', '⚡', '🔒', '📣', '💻', '🚚', '🛡️', '🏛️', '🎁', '🔧', '➕', '➖'];

/** Charge l'arbre (une fois par visite ; `force` après une modification). */
export async function loadCats(force = false) {
  if (!force && state.items.length) return state;
  const d = await get('/pf/categories');
  if (d.enabled === false) return state;
  state = { profile: d.profile, items: d.items, by: Object.fromEntries(d.items.map((i) => [i.key, i])) };
  return state;
}
export const profile = () => state.profile;
/** Selon le profil, les catégories qui le concernent passent d'abord (Commerce : l'arbre professionnel avant les catégories du quotidien). */
const byProfile = (list) => {
  const p = state.profile;
  if (p !== 'business' && p !== 'personal') return list;
  const rank = (c) => (!c.system || c.profile === p ? 0 : c.profile === 'both' ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b));
};
const childrenOf = (key, kind) => state.items.filter((i) => i.parent === key && i.kind === kind);

/** Nom lisible d'une clé : « Groupe › Sous-catégorie », avec l'icône. Les clés inconnues (anciennes) restent lisibles. */
export function catLabel(key, { withIcon = false, short = false } = {}) {
  if (key === 'transfer') return 'Virement';
  const c = state.by[key];
  if (!c) return key;
  const p = c.parent && !short ? state.by[c.parent] : null;
  const name = p ? `${p.label} › ${c.label}` : c.label;
  return withIcon && c.icon ? `${c.icon} ${name}` : name;
}

const shownFor = (c) => {
  const p = state.profile ?? 'personal';
  return p === 'both' || !c.system || c.profile === 'both' || c.profile === p;
};
/** Liste [clé, libellé] à proposer pour un type (revenu/dépense), selon le profil ; la catégorie en cours reste proposée même masquée. */
export function catOptions(kind, current) {
  const out = [];
  const walk = (parent, depth) => {
    for (const c of byProfile(state.items.filter((i) => i.parent === parent && i.kind === kind))) {
      if ((!c.hidden && shownFor(c)) || c.key === current) out.push([c.key, `${depth ? '  '.repeat(depth) : ''}${c.icon ? `${c.icon} ` : ''}${depth ? c.label : catLabel(c.key)}`]);
      walk(c.key, depth + 1);
    }
  };
  walk(null, 0);
  if (current && !out.some((o) => o[0] === current)) out.push([current, catLabel(current)]);
  return out;
}

/** Carte « Quel est votre profil ? » : une seule fois, modifiable ensuite dans les paramètres. */
export function profileChooser(onDone) {
  const pick = (p) => action(async () => { await post('/pf/profile', { profile: p }); await loadCats(true); }, { ok: 'Profil enregistré', refresh: onDone });
  return h('section', { class: 'pf-card pf-profile' }, h('div', { class: 'pf-card-head' }, h('h2', {}, 'Adapter Mes finances à vous')),
    h('p', { class: 'muted' }, 'Vous gérez surtout quoi ? Nous affichons seulement les catégories utiles. Vous pourrez changer plus tard.'),
    ['personal', 'business', 'both'].map((p) => h('button', { class: 'pf-btn ghost block', type: 'button', onclick: pick(p) }, PROFILE_LABEL[p])));
}

async function editCat(c) {
  const v = await ask({ title: c.system ? 'Modifier la catégorie' : 'Modifier ma catégorie', text: c.system && c.default_label !== c.label ? `Nom d'origine : ${c.default_label}` : undefined, submit: 'Enregistrer', fields: [
    { name: 'label', label: 'Nom', value: c.label, maxlength: 40, required: !c.system, ...(c.system ? { placeholder: c.default_label } : {}) },
    { name: 'icon', label: 'Icône', type: 'select', options: [['', 'Aucune'], ...ICONS.map((i) => [i, i])], value: c.icon || '' },
    { name: 'hidden', label: 'Masquer cette catégorie (l\'historique reste)', type: 'checkbox', value: c.hidden }] });
  if (!v) return false;
  await post(`/pf/categories/${c.key}`, { label: v.label === c.default_label ? '' : v.label, icon: v.icon || undefined, hidden: !!v.hidden });
  await loadCats(true);
  return true;
}
async function addCat(parent, kind) {
  const v = await ask({ title: parent ? `Ajouter sous « ${catLabel(parent.key, { short: true })} »` : 'Nouveau groupe', submit: 'Ajouter', fields: [
    { name: 'label', label: parent && parent.key === 'employees' ? 'Nom (ex. un employé)' : 'Nom', maxlength: 40 },
    { name: 'icon', label: 'Icône', type: 'select', options: [['', 'Aucune'], ...ICONS.map((i) => [i, i])], value: '' }] });
  if (!v) return false;
  await post('/pf/categories', { parent: parent?.key, kind, label: v.label, icon: v.icon || undefined });
  await loadCats(true);
  return true;
}

/** Écran « Catégories » : arbre par type, ajouter, renommer, changer l'icône, masquer. */
export function categoriesScreen({ go, head, card, st }) {
  let kind = 'expense';
  const root = h('div', {});
  const render = () => {
    const rowFor = (c, depth) => {
      const kids = childrenOf(c.key, kind);
      return [h('div', { class: `pf-cat${c.hidden ? ' off' : ''}${depth ? ' sub' : ''}` },
        h('button', { class: 'pf-cat-main', type: 'button', onclick: action(async () => { await editCat(c); }, { ok: 'Catégorie enregistrée', refresh: () => render() }) },
          h('span', { class: 'pf-cat-ico', 'aria-hidden': 'true' }, c.icon || '•'), h('span', { class: 'grow' }, c.label, c.hidden && h('small', {}, ' · masquée'), !c.operating && h('small', {}, ' · hors exploitation'))),
        depth < 2 && h('button', { class: 'pf-cat-add', type: 'button', 'aria-label': `Ajouter sous ${c.label}`, onclick: action(async () => { await addCat(c, kind); }, { ok: 'Catégorie ajoutée', refresh: () => render() }) }, icon('plus', 18))),
        ...kids.flatMap((k) => rowFor(k, depth + 1))];
    };
    const roots = byProfile(state.items.filter((i) => !i.parent && i.kind === kind && shownFor(i)));
    root.replaceChildren(
      h('div', { class: 'wallet-tabs', role: 'group' }, [['expense', 'Dépenses'], ['income', 'Revenus']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(kind === k), onclick: () => { kind = k; render(); } }, l))),
      h('p', { class: 'pf-note' }, `Profil : ${PROFILE_LABEL[state.profile ?? 'personal']}. Touchez une catégorie pour la renommer, changer l'icône ou la masquer ; « + » ajoute une sous-catégorie. Rien n'est supprimé : vos anciennes transactions gardent leur catégorie.`),
      h('section', { class: 'pf-card flush pf-cats' }, roots.flatMap((c) => rowFor(c, 0))),
      h('button', { class: 'pf-btn block', type: 'button', onclick: action(async () => { await addCat(null, kind); }, { ok: 'Groupe ajouté', refresh: () => render() }) }, 'Nouveau groupe'),
      h('h3', { class: 'pf-sub' }, 'Profil'),
      h('div', { class: 'pf-profile-row' }, ['personal', 'business', 'both'].map((p) => h('button', { class: 'pf-chip', 'aria-pressed': String(state.profile === p), type: 'button', onclick: action(async () => { await post('/pf/profile', { profile: p }); await loadCats(true); render(); }, { ok: 'Profil enregistré', refresh: () => render() }) }, PROFILE_LABEL[p]))));
  };
  render();
  return h('div', {}, head('Catégories', { back: ['Paramètres', () => go('settings')] }), h('div', { class: 'pf-pad' }, root));
}
