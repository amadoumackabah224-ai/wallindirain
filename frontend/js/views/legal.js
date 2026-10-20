// Lecture des textes légaux (conditions, confidentialité, cookies, retours, mentions) DANS l'application, sans quitter la page :
// on peut les lire en pleine inscription sans perdre ce qu'on a saisi.
import { h, spinner, errToast } from '../ui.js';
import { get } from '../api.js';

const cache = new Map();

export function openLegal(slug = 'confidentialite') {
  const opener = document.activeElement;
  let current = slug;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); opener?.isConnected && opener.focus?.(); };
  const onKey = (e) => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Tab') return;
    const f = [...overlay.querySelectorAll('button, a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  const doc = h('article', { class: 'legal-doc legal-main', tabindex: '0', 'aria-labelledby': 'legal-title' });
  const nav = h('div', { class: 'chat-tabs legal-tabs', role: 'group', 'aria-label': 'Textes légaux' });
  let pages = [];

  // les liens à l'intérieur des textes restent dans l'application
  doc.addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return;
    const href = a.getAttribute('href') || '';
    const m = /^\/legal\/([a-z-]+)\/?$/.exec(href);
    if (m) { e.preventDefault(); show(m[1]); return; }
    if (href.startsWith('/#/') || href.startsWith('#/')) { e.preventDefault(); close(); location.hash = href.replace(/^\/?#/, '#'); return; }
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
  });

  async function show(s) {
    current = s;
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.slug === s)));
    doc.replaceChildren(spinner());
    try {
      if (!cache.has(s)) cache.set(s, await get(`/public/legal/${s}`));
      const p = cache.get(s);
      const parsed = new DOMParser().parseFromString(p.html, 'text/html');
      doc.replaceChildren(h('p', { class: 'small muted', id: 'legal-title' }, `${p.title} · version du ${p.version}`), ...parsed.body.childNodes);
      doc.scrollTop = 0; doc.focus({ preventScroll: true });
    } catch (e) { doc.replaceChildren(h('div', { class: 'notice bad' }, e.message)); errToast(e); }
  }

  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal wide legal-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Informations légales' },
      h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Informations légales'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: close, 'aria-label': 'Fermer les informations légales' }, '✕')),
      nav, doc));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  get('/public/legal').then((r) => {
    pages = r.pages;
    nav.replaceChildren(...pages.map((p) => h('button', { class: 'tab', type: 'button', 'data-slug': p.slug, 'aria-pressed': String(p.slug === current), onclick: () => show(p.slug) }, p.title)));
  }).catch(() => {});
  show(slug);
  return { close };
}
