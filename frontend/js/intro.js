// Écran d'ouverture animé : le logo W se décompose en morceaux qui se recollent, puis le nom apparaît lettre par lettre.
// Une seule fois par session, ignoré si l'utilisateur réduit les animations, fermable d'un toucher.
export function playIntro() {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (sessionStorage.getItem('intro_seen')) return;
    sessionStorage.setItem('intro_seen', '1');
  } catch { /* stockage indisponible : on joue l'animation quand même */ }
  const mk = (cls) => { const d = document.createElement('div'); d.className = `ip ${cls}`; return d; };
  const logo = document.createElement('div'); logo.className = 'intro-logo'; logo.setAttribute('role', 'img'); logo.setAttribute('aria-label', 'Wallindirain');
  for (let i = 1; i <= 6; i++) logo.append(mk(`ip-w${i}`));
  for (let i = 1; i <= 12; i++) logo.append(mk(`ip-l${i}`));
  const box = document.createElement('div'); box.className = 'intro'; box.append(logo);
  let closed = false;
  const close = () => { if (closed) return; closed = true; box.classList.add('out'); setTimeout(() => box.remove(), 700); };
  box.addEventListener('click', close);
  document.body.append(box);
  setTimeout(close, 3300);
}
