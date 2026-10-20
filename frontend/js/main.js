// Point d'entrée de l'interface : routage, session, navigation par rôle.
import { h, ROLE_LABEL, toast, spinner, avatar, legalLinks } from './ui.js';
import { get, post, setUnauthorizedHandler } from './api.js';
import { loginView, registerView, forgotView, clientOrderView, dataRequestView } from './views/auth.js';
import { profileView } from './views/profile.js';
import { helpButton } from './views/support.js';
import { walletView } from './views/wallet.js';
import { sellerOrders, sellerCatalog, sellerNewOrder } from './views/seller.js';
import { supplierProducts, supplierOrders } from './views/supplier.js';
import { callQueue, myCalls, chiefAssign } from './views/calls.js';
import { courierOrders, courierCash } from './views/courier.js';
import { warehouseView } from './views/warehouse.js';
import { adminDashboard, adminUsers, adminProducts, adminOrders, adminCash, adminRemittances, adminSupport, adminData, adminWithdrawals, adminDeposit, adminSettings, adminAudit } from './views/admin.js';

const app = document.getElementById('app');
let user = null;
let contact = '624390707';
const fmtPhoneLocal = (p) => (p || '').replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');

// Onglets par rôle : [clé, icône, libellé, fonction de vue]
const TABS = {
  seller: [['orders', '📦', 'Commandes', () => sellerOrders()], ['new', '➕', 'Nouvelle', (c) => sellerNewOrder(c)], ['catalog', '🛍️', 'Catalogue', () => sellerCatalog()], ['wallet', '💰', 'Portefeuille', () => walletView()]],
  supplier: [['products', '📦', 'Produits', () => supplierProducts()], ['orders', '🚚', 'Colis', () => supplierOrders()], ['wallet', '💰', 'Portefeuille', () => walletView()]],
  agent: [['queue', '📞', 'File d\'appel', (c) => callQueue({ onTaken: () => c.goTo('mine') })], ['mine', '☎️', 'Mes appels', () => myCalls()], ['wallet', '💰', 'Gains', () => walletView()]],
  call_chief: [['queue', '📞', 'File d\'appel', (c) => callQueue({ onTaken: () => c.goTo('mine') })], ['mine', '☎️', 'Mes appels', () => myCalls()], ['assign', '🏍️', 'Affectation', () => chiefAssign()], ['wallet', '💰', 'Gains', () => walletView()]],
  courier: [['orders', '🏍️', 'Livraisons', () => courierOrders()], ['cash', '💵', 'Caisse', () => courierCash()], ['wallet', '💰', 'Gains', () => walletView()]],
  warehouse: [['stock', '🏬', 'Entrepôt', () => warehouseView()]],
  admin: [['dash', '📊', 'Tableau', (c) => adminDashboard(c)], ['orders', '📦', 'Commandes', () => adminOrders()], ['users', '👥', 'Utilisateurs', () => adminUsers()], ['products', '🛍️', 'Produits', () => adminProducts()],
    ['cash', '🏦', 'Caisses', () => adminCash()], ['remit', '📲', 'Reversements', () => adminRemittances()], ['withdrawals', '💸', 'Retraits', () => adminWithdrawals()], ['deposit', '➕', 'Dépôts', () => adminDeposit()], ['settings', '⚙️', 'Réglages', () => adminSettings()], ['audit', '📜', 'Journal', () => adminAudit()]]
};

const PROFILE_TAB = ['profile', '👤', 'Profil', (c) => profileView({ onChanged: () => { c.refreshUser(); } })];
for (const r of Object.keys(TABS)) TABS[r].push(PROFILE_TAB);
TABS.admin.splice(TABS.admin.length - 1, 0, ['support', '💬', 'Messages', () => adminSupport()], ['data', '🗂️', 'Données', () => adminData()]);

function render(node) { app.replaceChildren(node); window.scrollTo(0, 0); }

function appShell(tabKey) {
  const tabs = TABS[user.role];
  const current = tabs.find((t) => t[0] === tabKey) || tabs[0];
  const goTo = (k) => { location.hash = `#/app/${k}`; };
  const refreshUser = async () => { try { user = (await get('/auth/me')).user; } catch { /* inchangé */ } const w = document.querySelector('.who-name'); if (w) w.textContent = user.name; const old = document.querySelector('.topbar .avatar'); if (old) old.replaceWith(avatar(user, 34, Date.now())); };
  const main = h('main', { class: 'shell', id: 'contenu' }, current[3]({ goTo, refreshUser }));
  return h('div', {},
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' }),
      avatar(user, 34, 'top'), h('div', { class: 'who' }, h('b', { class: 'who-name' }, user.name), h('span', {}, ROLE_LABEL[user.role])),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: logout }, 'Quitter'))),
    h('nav', { class: 'tabs', 'aria-label': 'Navigation' }, tabs.map((t) => h('button', { class: 'tab', 'aria-current': t[0] === current[0] ? 'page' : null, onclick: () => goTo(t[0]) }, h('span', { class: 'ico', 'aria-hidden': 'true' }, t[1]), t[2]))),
    main, h('footer', { class: 'app-foot' }, legalLinks()), helpButton({ user, contact: fmtPhoneLocal(contact) }));
}

async function logout() { try { await post('/auth/logout'); } catch { /* déjà déconnecté */ } user = null; location.hash = '#/login'; }

async function route() {
  const [, a, b] = location.hash.split('/');
  const pub = (node) => render(h('div', {}, node, helpButton({ user: null, contact: fmtPhoneLocal(contact) })));
  if (a === 'c' && b) return pub(clientOrderView(b));          // page publique du client
  if (a === 'demande-donnees') return pub(dataRequestView());
  if (!user) { try { user = (await get('/auth/me')).user; } catch { user = null; } }
  if (!user) {
    if (a === 'register') return pub(registerView());
    if (a === 'forgot') return pub(forgotView());
    return pub(loginView({ contact, onLogin: (u) => { user = u; location.hash = '#/app/'; } }));
  }
  if (a === 'app') return render(appShell(b));
  location.hash = '#/app/';
}

setUnauthorizedHandler(() => { if (user) { user = null; toast('Session expirée : reconnectez-vous.', 'bad'); location.hash = '#/login'; route(); } });
window.addEventListener('hashchange', route);
render(spinner());
get('/public/info').then((i) => { contact = i.contact_phone; }).catch(() => {}).finally(route);
