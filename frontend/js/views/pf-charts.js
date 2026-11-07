// Jauge à aiguille et courbe d'évolution de « Mes finances », dessinées en SVG par le code (aucun style écrit dans la page : la politique de sécurité les interdit).
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const rad = (deg) => (deg * Math.PI) / 180;
const pt = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];

/** Arc de cercle entre deux angles (degrés, 0 = droite, sens horaire). */
function arc(cx, cy, r, from, to) {
  const [x1, y1] = pt(cx, cy, r, from), [x2, y2] = pt(cx, cy, r, to);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Jauge de 270° : rouge, orange, vert. `position` va de 0 (rouge) à 1 (vert).
 */
export function gaugeSvg(position, size = 120) {
  const p = Math.max(0, Math.min(1, Number(position) || 0));
  const cx = 100, cy = 100, r = 74, start = 135, sweep = 270;
  const svg = el('svg', { viewBox: '0 0 200 200', width: size, height: size, role: 'img', 'aria-label': `Jauge à ${Math.round(p * 100)} %`, class: 'pf-gauge' });
  svg.append(el('circle', { cx, cy, r: 96, class: 'pf-g-bezel' }), el('circle', { cx, cy, r: 84, class: 'pf-g-face' }));
  const seg = (a, b, cls) => svg.append(el('path', { d: arc(cx, cy, r, start + a * sweep, start + b * sweep), class: `pf-g-arc ${cls}`, fill: 'none' }));
  seg(0, 0.32, 'red'); seg(0.34, 0.66, 'orange'); seg(0.68, 1, 'green');
  const ang = start + p * sweep;
  const [tx, ty] = pt(cx, cy, 70, ang), [l1x, l1y] = pt(cx, cy, 9, ang + 90), [l2x, l2y] = pt(cx, cy, 9, ang - 90);
  svg.append(el('polygon', { points: `${tx.toFixed(1)},${ty.toFixed(1)} ${l1x.toFixed(1)},${l1y.toFixed(1)} ${l2x.toFixed(1)},${l2y.toFixed(1)}`, class: 'pf-g-needle' }), el('circle', { cx, cy, r: 12, class: 'pf-g-hub' }));
  return svg;
}

/** Courbe de solde en aire : valeurs = nombres, jours = dates ISO (mêmes longueurs). */
export function areaChart(values, days = [], { width = 320, height = 150 } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height + 18}`, class: 'pf-area', role: 'img', 'aria-label': 'Évolution du solde' });
  if (!values.length) return svg;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1, padL = 4, padR = 4, top = 8;
  const x = (i) => padL + (values.length === 1 ? (width - padL - padR) / 2 : (i * (width - padL - padR)) / (values.length - 1));
  const y = (v) => top + (1 - (v - min) / span) * (height - top - 6);
  for (let i = 0; i < 4; i++) svg.append(el('line', { x1: 0, x2: width, y1: top + (i * (height - top - 6)) / 3, y2: top + (i * (height - top - 6)) / 3, class: 'pf-a-grid' }));
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  svg.append(el('polygon', { points: `${x(0).toFixed(1)},${height} ${line} ${x(values.length - 1).toFixed(1)},${height}`, class: 'pf-a-fill' }), el('polyline', { points: line, class: 'pf-a-line', fill: 'none' }));
  svg.append(el('circle', { cx: x(values.length - 1).toFixed(1), cy: y(values[values.length - 1]).toFixed(1), r: 4, class: 'pf-a-dot' }));
  const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  if (days.length > 1) {
    const a = el('text', { x: 2, y: height + 14, class: 'pf-a-lbl' }); a.textContent = fmt(days[0]);
    const b = el('text', { x: width - 2, y: height + 14, class: 'pf-a-lbl', 'text-anchor': 'end' }); b.textContent = fmt(days[days.length - 1]);
    svg.append(a, b);
  }
  return svg;
}
