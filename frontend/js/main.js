// Point d'entrée de l'interface : routage, session, navigation par rôle.
import { h, ROLE_LABEL, toast, spinner, avatar, legalLinks, setLegalAudience, AUDIENCE_OF_ROLE } from './ui.js';
import { get, post, setUnauthorizedHandler } from './api.js';
import { loginView, registerView, forgotView, clientOrderView, dataRequestView, flags } from './views/auth.js';
import { profileView } from './views/profile.js';
import { helpButton } from './views/support.js';
import { walletView } from './views/wallet.js';
import { sellerStats, adminStats, trackView } from './views/stats.js';
import { sellerOrders, sellerCatalog, sellerNewOrder } from './views/seller.js';
import { sellerDashboard } from './views/dashboard.js';
import { notificationsView, adminAnnounce, bellCount } from './views/notifications.js';
import { adminCouriers } from './views/couriers.js';
import { icon } from './icons.js';
import { supplierProducts, supplierOrders } from './views/supplier.js';
import { callQueue, myCalls, chiefAssign } from './views/calls.js';
import { courierOrders, courierCash } from './views/courier.js';
import { warehouseView } from './views/warehouse.js';
import { adminDashboard, adminUsers, adminProducts, adminOrders, adminCash, adminRemittances, adminSupport, adminData, adminWithdrawals, adminDeposit, adminSettings, adminAudit } from './views/admin.js';

const app = document.getElementById('app');
let user = null;
let contact = '624390707';

// Onglets par rôle : [clé, icône, libellé, fonction de vue, groupe du menu latéral]
const TABS = {
  seller: [['dash', 'dashboard', 'Accueil', (c) => sellerDashboard(c), 'Vue d\'ensemble'], ['orders', 'package', 'Commandes', (c) => sellerOrders(c), 'Ventes'], ['new', 'plus', 'Nouvelle', (c) => sellerNewOrder(c), 'Ventes'], ['catalog', 'bag', 'Catalogue', () => sellerCatalog(), 'Ventes'],
    ['stats', 'chart', 'Mes chiffres', () => sellerStats(), 'Mon activité'], ['wallet', 'wallet', 'Portefeuille', () => walletView(), 'Mon activité']],
  supplier: [['products', 'package', 'Produits', () => supplierProducts(), ''], ['orders', 'truck', 'Colis', () => supplierOrders(), ''], ['wallet', 'wallet', 'Portefeuille', () => walletView(), '']],
  agent: [['queue', 'inbox', 'File d\'appel', (c) => callQueue({ onTaken: () => c.goTo('mine') }), ''], ['mine', 'phone', 'Mes appels', () => myCalls(), ''], ['wallet', 'wallet', 'Gains', () => walletView(), '']],
  call_chief: [['queue', 'inbox', 'File d\'appel', (c) => callQueue({ onTaken: () => c.goTo('mine') }), ''], ['mine', 'phone', 'Mes appels', () => myCalls(), ''], ['assign', 'bike', 'Affectation', () => chiefAssign(), ''], ['wallet', 'wallet', 'Gains', () => walletView(), '']],
  courier: [['orders', 'bike', 'Livraisons', () => courierOrders(), ''], ['cash', 'banknote', 'Caisse', () => courierCash(), ''], ['wallet', 'wallet', 'Gains', () => walletView(), '']],
  warehouse: [['stock', 'warehouse', 'Entrepôt', () => warehouseView(), '']],
  admin: [['dash', 'dashboard', 'Tableau', (c) => adminDashboard(c), 'Pilotage'], ['stats', 'trend', 'Statistiques', () => adminStats(), 'Pilotage'], ['orders', 'package', 'Commandes', () => adminOrders(), 'Opérations'], ['users', 'users', 'Utilisateurs', () => adminUsers(), 'Opérations'], ['couriers', 'bike', 'Livreurs', () => adminCouriers(), 'Opérations'], ['products', 'bag', 'Produits', () => adminProducts(), 'Opérations'],
    ['cash', 'bank', 'Caisses', () => adminCash(), 'Finances'], ['remit', 'phoneMoney', 'Reversements', () => adminRemittances(), 'Finances'], ['withdrawals', 'banknote', 'Retraits', () => adminWithdrawals(), 'Finances'], ['deposit', 'plus', 'Dépôts', () => adminDeposit(), 'Finances'],
    ['support', 'message', 'Messages', () => adminSupport(), 'Système'], ['announce', 'megaphone', 'Annonces', () => adminAnnounce(), 'Système'], ['data', 'database', 'Données', () => adminData(), 'Système'], ['settings', 'sliders', 'Réglages', () => adminSettings(), 'Système'], ['audit', 'scroll', 'Journal', () => adminAudit(), 'Système']]
};
// Barre du bas sur téléphone : les onglets principaux ; le reste se trouve sous « Plus » (rien n'est retiré).
const MOBILE_PRIMARY = { seller: ['dash', 'orders', 'new', 'wallet'], admin: ['dash', 'orders', 'users', 'withdrawals'] };

// Le profil n'est plus un onglet : on y accède en touchant la photo ou le nom, en haut de l'écran.
const PROFILE_TAB = ['profile', 'user', 'Profil', (c) => profileView({ onChanged: () => { c.refreshUser(); } })];

// Notifications : page ouverte par la cloche (pas un onglet du menu)
const NOTIF_TAB = ['notifications', 'bell', 'Notifications', (c) => notificationsView(c)];
let bellTimer = null;

function render(node) { app.replaceChildren(node); window.scrollTo(0, 0); }

function appShell(tabKey) {
  const tabs = TABS[user.role];
  const current = tabKey === 'profile' ? PROFILE_TAB : tabKey === 'notifications' ? NOTIF_TAB : (tabs.find((t) => t[0] === tabKey) || tabs[0]);
  const goTo = (k) => { location.hash = `#/app/${k}`; };
  const refreshUser = async () => { try { user = (await get('/auth/me')).user; } catch { /* inchangé */ } document.querySelectorAll('.who-name').forEach((w) => { w.textContent = user.name; }); document.querySelectorAll('.topbar .avatar').forEach((old) => old.replaceWith(avatar(user, 34, Date.now()))); };
  document.title = `${current[2]} · Wallindirain`;
  const main = h('main', { class: 'shell', id: 'contenu' }, current[3]({ goTo, refreshUser, user }));

  const navItem = (t, cls) => h('button', { class: `${cls}${t[0] === current[0] ? ' on' : ''}`, type: 'button', 'aria-current': t[0] === current[0] ? 'page' : null, onclick: () => goTo(t[0]) }, icon(t[1], 22), h('span', { class: 'nav-label' }, t[2]));
  // menu latéral (ordinateur et tablette) : groupes
  const groups = []; for (const t of tabs) { const g = groups.find((x) => x.name === t[4]); if (g) g.items.push(t); else groups.push({ name: t[4], items: [t] }); }
  const side = h('aside', { class: 'side' },
    h('a', { class: 'side-brand', href: '#/app/', 'aria-label': 'Wallindirain : accueil' }, h('img', { class: 'brand-full', src: '/assets/logo-gold.png', alt: 'Wallindirain' }), h('img', { class: 'brand-mark', src: '/assets/w-gold.png', alt: '' })),
    h('nav', { class: 'side-nav', 'aria-label': 'Navigation' }, groups.map((g) => h('div', { class: 'nav-group' }, g.name && h('p', { class: 'nav-title' }, g.name), g.items.map((t) => navItem(t, 'nav-item'))))),
    h('div', { class: 'side-foot' }, h('button', { class: 'nav-item', type: 'button', onclick: logout }, icon('logout', 22), h('span', { class: 'nav-label' }, 'Quitter'))));

  // barre du bas (téléphone)
  const primary = tabs.length <= 5 ? tabs : (MOBILE_PRIMARY[user.role] || []).map((k) => tabs.find((t) => t[0] === k)).filter(Boolean);
  const rest = tabs.filter((t) => !primary.includes(t));
  const openMore = () => {
    const close = () => overlay.remove();
    const row = (ico, label, fn, tone = '') => h('button', { class: `more-row ${tone}`, type: 'button', onclick: () => { close(); fn(); } }, icon(ico, 22), h('span', { class: 'grow' }, label), icon('chevronRight', 18));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, h('div', { class: 'modal sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Plus' },
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      h('div', { class: 'sheet-who' }, avatar(user, 44, 'top'), h('div', { class: 'grow' }, h('b', { class: 'who-name' }, user.name), h('span', {}, ROLE_LABEL[user.role]))),
      h('div', { class: 'more-list' }, rest.map((t) => row(t[1], t[2], () => goTo(t[0]))), row('user', 'Mon profil', () => goTo('profile')), row('logout', 'Quitter', logout, 'bad')),
      h('button', { class: 'btn btn-ghost btn-block mt', type: 'button', onclick: close }, 'Fermer')));
    document.body.append(overlay);
  };
  const bnav = h('nav', { class: 'bnav', 'aria-label': 'Navigation' }, primary.map((t) => navItem(t, `bnav-item${t[0] === 'new' && user.role === 'seller' ? ' accent' : ''}`)),
    h('button', { class: `bnav-item${rest.includes(current) || current === PROFILE_TAB ? ' on' : ''}`, type: 'button', onclick: openMore }, icon('more', 22), h('span', { class: 'nav-label' }, 'Plus')));

  // cloche : nombre de notifications non lues (mis à jour toutes les 60 s et dès qu'on en lit)
  const bell = bellCount({ onOpen: () => goTo('notifications'), active: current === NOTIF_TAB });
  clearInterval(bellTimer); bellTimer = setInterval(() => { if (document.visibilityState === 'visible') bell.refresh(); }, 60000);

  return h('div', { class: 'app' }, side,
    h('div', { class: 'main-col' },
      h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' }, h('img', { class: 'topbar-logo', src: '/assets/logo-gold.png', alt: 'Wallindirain' }), h('span', { class: 'topbar-title' }, current[2]), h('span', { class: 'grow' }), bell,
        h('button', { class: 'who-link', type: 'button', 'aria-label': `Mon profil : ${user.name}`, 'aria-current': current === PROFILE_TAB ? 'page' : null, onclick: () => goTo('profile') },
          avatar(user, 34, 'top'), h('div', { class: 'who' }, h('b', { class: 'who-name' }, user.name), h('span', {}, ROLE_LABEL[user.role]))),
        h('button', { class: 'icon-btn topbar-out', type: 'button', 'aria-label': 'Quitter', onclick: logout }, icon('logout', 20)))),
      main, h('footer', { class: 'app-foot' }, legalLinks('user'))),
    bnav, helpButton({ user }));
}

let gateOpen = false;
// Accord sur les textes du rôle : demandé à la première connexion et à chaque nouvelle version
async function askLegal() {
  gateOpen = true;
  const { legalGate } = await import('./views/legal.js');
  legalGate({ onAccepted: () => { gateOpen = false; if (user) user.legal_pending = false; }, onQuit: () => { gateOpen = false; logout(); } });
}

async function logout() { try { await post('/auth/logout'); } catch { /* déjà déconnecté */ } user = null; location.hash = '#/login'; }

async function route() {
  const [, a, b] = location.hash.split('/');
  const pub = (node) => render(h('div', {}, node));
  if (a === 'c' && b) return pub(clientOrderView(b));          // page publique du client
  if (a === 'suivi' && b) return pub(trackView(b));              // suivi de commande pour le client
  if (a === 'demande-donnees') return pub(dataRequestView());
  if (!user) { try { user = (await get('/auth/me')).user; } catch { user = null; } }
  if (!user) {
    if (a === 'register') return pub(registerView({ ref: b }));
    if (a === 'forgot') return pub(forgotView());
    return pub(loginView({ contact, onLogin: (u) => { user = u; location.hash = '#/app/'; } }));
  }
  if (a === 'app') { setLegalAudience(AUDIENCE_OF_ROLE[user.role]); render(appShell(b)); if (user.legal_pending && !gateOpen) askLegal(); return; }
  location.hash = '#/app/';
}

setUnauthorizedHandler(() => { if (user) { user = null; toast('Session expirée : reconnectez-vous.', 'bad'); location.hash = '#/login'; route(); } });
window.addEventListener('hashchange', route);
render(spinner());
get('/public/info').then((i) => { contact = i.contact_phone; flags.email = !!i.email_enabled; }).catch(() => {}).finally(route);
