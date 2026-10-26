// Graphiques légers faits de blocs HTML/CSS (aucune bibliothèque). Les hauteurs et largeurs sont posées par le style DOM
// (la politique de sécurité interdit seulement les attributs style écrits dans la page).
import { h } from './ui.js';

/** Histogramme : items = [{ label, value }]. `fmt` met en forme les montants. */
export function columnChart(items, fmt = (n) => String(n), { height = 150 } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const cols = items.map((i) => {
    const bar = h('span', { class: `col-bar${i.value > 0 ? '' : ' zero'}` });
    bar.style.height = `${Math.max(i.value > 0 ? 6 : 2, Math.round((i.value * 100) / max))}%`;
    return h('div', { class: 'col', role: 'listitem', 'aria-label': `${i.label} : ${fmt(i.value)}` }, h('span', { class: 'col-val' }, i.value > 0 ? fmt(i.value) : ''), h('span', { class: 'col-track' }, bar), h('span', { class: 'col-lab' }, i.label));
  });
  const root = h('div', { class: 'cols', role: 'list' }, cols);
  root.style.setProperty('--chart-h', `${height}px`);
  return root;
}

/** Barre segmentée : segments = [{ label, value, tone }] ; tone = classe de couleur (ok, info, warn, bad, gold, grey). */
export function segmentBar(segments, total = segments.reduce((a, s) => a + s.value, 0)) {
  const live = segments.filter((s) => s.value > 0);
  const bar = h('div', { class: 'seg', role: 'img', 'aria-label': live.map((s) => `${s.label} : ${s.value}`).join(', ') || 'Aucune commande' },
    live.map((s) => { const el = h('span', { class: `seg-i ${s.tone}` }); el.style.width = `${(s.value * 100) / Math.max(1, total)}%`; return el; }));
  const legend = h('ul', { class: 'seg-legend' }, segments.map((s) => h('li', {}, h('span', { class: `dot ${s.tone}` }), `${s.label} `, h('b', {}, String(s.value)))));
  return h('div', {}, bar, legend);
}
