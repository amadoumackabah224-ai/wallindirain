// Application installable : enregistrement du service worker, bandeau « hors connexion », dernière page ouverte, carte « Installer ».
import { h, toast } from './ui.js';
import { icon } from './icons.js';

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible : sans gravité */ } }
};
let installEvent = null;

export function startPwa() {
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // bandeau quand le réseau coupe
  const bar = h('div', { class: 'offline-bar hidden', role: 'status' }, 'Vous êtes hors connexion : vous ne pouvez rien envoyer tant que le réseau n\'est pas revenu.');
  document.body.append(bar);
  const sync = () => bar.classList.toggle('hidden', navigator.onLine !== false);
  window.addEventListener('online', () => { sync(); toast('Connexion rétablie', 'ok'); });
  window.addEventListener('offline', sync); sync();
  // bouton d'installation proposé par Chrome / Android
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; toast('Application installée', 'ok'); });
  // application installée : on rouvre la dernière page où l'on était (sans jamais sortir de la zone connectée)
  if (standalone() && (location.hash === '' || location.hash === '#/app/' || location.hash === '#/app')) {
    const last = store.get('wld:last');
    if (last && /^#\/app\/[a-z]{2,20}$/.test(last)) location.hash = last;
  }
  window.addEventListener('hashchange', () => { if (/^#\/app\/[a-z]{2,20}$/.test(location.hash)) store.set('wld:last', location.hash); });
}

/** Carte « Installer l'application » du profil : masquée si l'application est déjà installée. */
export function installCard() {
  if (standalone()) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const box = h('div', { class: 'card install' }, h('h2', {}, 'Installer l\'application'),
    h('p', { class: 'small muted' }, 'Une icône Wallindirain sur votre écran d\'accueil : ouverture plein écran, plus rapide, sans passer par le navigateur.'));
  const render = () => {
    box.querySelector('.install-act')?.remove();
    box.append(installEvent
      ? h('button', { class: 'btn btn-gold install-act', type: 'button', onclick: async () => { installEvent.prompt(); try { await installEvent.userChoice; } catch { /* refusé */ } installEvent = null; render(); } }, icon('plus', 18), 'Installer sur ce téléphone')
      : h('p', { class: 'small install-act' }, ios ? 'Sur iPhone : touchez le bouton Partager de Safari, puis « Sur l\'écran d\'accueil ».' : 'Sur Android : ouvrez le menu du navigateur (trois points), puis « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».'));
  };
  render(); window.addEventListener('beforeinstallprompt', () => setTimeout(render, 0));
  return box;
}

/** Écran affiché quand le réseau est coupé à l'ouverture : on ne fait pas croire que la personne est déconnectée. */
export function offlineScreen(retry) {
  return h('main', { class: 'auth', id: 'contenu' }, h('div', { class: 'auth-card' },
    h('img', { class: 'auth-logo', src: '/assets/logo-gold.png', alt: 'Wallindirain' }),
    h('div', { class: 'card' }, h('h1', {}, 'Pas de connexion'),
      h('p', {}, 'Wallindirain ne peut pas joindre Internet. Vous n\'êtes pas déconnecté : vérifiez votre réseau, puis réessayez.'),
      h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: retry }, 'Réessayer'))));
}
