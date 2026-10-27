// Notifications : cloche du haut de l'écran, liste, et annonces de l'administration.
import { h, liveView, empty, pageHead, action, confirmBox, fmtDate, toast } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const KIND_ICON = { order: 'package', money: 'wallet', account: 'shield', product: 'package', support: 'message', announcement: 'megaphone' };
const KIND_TONE = { order: 'info', money: 'ok', account: 'warn', product: 'info', support: 'info', announcement: 'gold' };
const AUDIENCES = [['all', 'Tout le monde'], ['seller', 'Les vendeurs'], ['supplier', 'Les fournisseurs'], ['courier', 'Les livreurs'], ['agent', 'Les agents du call center'], ['call_chief', 'Les chefs d\'équipe'], ['warehouse', 'Le magasin']];
const AUDIENCE_LABEL = Object.fromEntries(AUDIENCES);

/** Cloche avec pastille : le nombre se met à jour avec .refresh(), et automatiquement après chaque lecture (événement « wld:notif »). */
export function bellCount({ onOpen, active }) {
  const dot = h('span', { class: 'bell-dot hidden', 'aria-hidden': 'true' });
  const btn = h('button', { class: `icon-btn topbar-bell${active ? ' on' : ''}`, type: 'button', 'aria-label': 'Notifications', 'aria-current': active ? 'page' : null, onclick: onOpen }, icon('bell', 22), dot);
  const set = (n) => { dot.textContent = n > 99 ? '99+' : String(n); dot.classList.toggle('hidden', !(n > 0)); btn.setAttribute('aria-label', n > 0 ? `Notifications : ${n} non lue(s)` : 'Notifications'); };
  btn.refresh = () => get('/notifications/unread').then((r) => set(r.unread)).catch(() => {});
  const onChange = (e) => { if (!btn.isConnected) { window.removeEventListener('wld:notif', onChange); return; } if (typeof e.detail === 'number') set(e.detail); else btn.refresh(); };
  window.addEventListener('wld:notif', onChange);
  btn.refresh();
  return btn;
}

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'à l\'instant'; if (s < 3600) return `il y a ${Math.floor(s / 60)} min`; if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return fmtDate(iso);
};

/** Liste des notifications de la personne connectée. */
export function notificationsView({ goTo }) {
  return liveView(() => get('/notifications?limit=60'), (r, refresh) => {
    const markAll = action(async () => { await post('/notifications/read', {}); window.dispatchEvent(new CustomEvent('wld:notif', { detail: 0 })); }, { refresh });
    const open = async (n) => {
      if (!n.read) { try { await post('/notifications/read', { ids: [n.id] }); window.dispatchEvent(new CustomEvent('wld:notif')); } catch { /* sans gravité */ } }
      if (n.link) goTo(n.link); else await refresh();
    };
    return h('div', {}, pageHead('Notifications', r.unread > 0 ? `${r.unread} non lue(s)` : 'Tout est lu', r.unread > 0 && h('button', { class: 'btn btn-ghost', type: 'button', onclick: markAll }, icon('check', 16), 'Tout marquer comme lu')),
      r.items.length === 0
        ? empty('bell', 'Aucune notification pour le moment. Vous serez prévenu ici de l\'avancement de vos commandes, de vos retraits et des annonces de Wallindirain.')
        : h('div', { class: 'notif-list' }, r.items.map((n) => h('button', { class: `notif ${n.read ? '' : 'unread'}`, type: 'button', onclick: () => open(n) },
          h('span', { class: `notif-ico ${KIND_TONE[n.kind] || 'info'}` }, icon(KIND_ICON[n.kind] || 'bell', 20)),
          h('span', { class: 'notif-main' }, h('b', {}, n.title), n.body && h('span', { class: 'notif-body' }, n.body), h('span', { class: 'notif-time' }, ago(n.created_at))),
          !n.read && h('span', { class: 'notif-new', 'aria-label': 'Non lue' })))));
  }, { poll: 30000 });
}

/** Annonces de l'administration : un message envoyé dans les notifications d'un groupe de personnes. */
export function adminAnnounce() {
  return liveView(() => get('/admin/announcements'), (r, refresh) => {
    const audience = h('select', {}, AUDIENCES.map(([k, l]) => h('option', { value: k }, l)));
    const title = h('input', { type: 'text', maxlength: 120, placeholder: 'Ex. Nouvelle règle de livraison', 'aria-label': 'Titre' });
    const body = h('textarea', { rows: 4, maxlength: 600, placeholder: 'Votre message (600 caractères maximum). Ne mettez ni mot de passe ni code.', 'aria-label': 'Message' });
    const count = h('span', { class: 'small muted' }, '0 / 600');
    body.addEventListener('input', () => { count.textContent = `${body.value.length} / 600`; });
    const send = action(async () => {
      if (title.value.trim().length < 3 || body.value.trim().length < 3) { toast('Écrivez un titre et un message.', 'bad'); return; }
      if (!(await confirmBox('Envoyer cette annonce ?', `Elle sera envoyée à : ${AUDIENCE_LABEL[audience.value]}. Elle ne pourra pas être retirée.`))) return;
      const res = await post('/admin/announcements', { audience: audience.value, title: title.value, body: body.value });
      title.value = ''; body.value = ''; count.textContent = '0 / 600';
      toast(`Annonce envoyée à ${res.recipients} personne(s)`, 'ok');
      await refresh();
    });
    return h('div', {}, pageHead('Annonces', 'Un message dans les notifications de vos équipes et de vos vendeurs.'),
      h('div', { class: 'card' }, h('h2', {}, 'Nouvelle annonce'),
        h('label', { class: 'f' }, h('span', {}, 'Pour qui ?'), audience), h('label', { class: 'f' }, h('span', {}, 'Titre'), title),
        h('label', { class: 'f' }, h('span', {}, 'Message'), body, count),
        h('button', { class: 'btn btn-gold', type: 'button', onclick: send }, icon('megaphone', 18), 'Envoyer l\'annonce')),
      h('div', { class: 'card' }, h('h2', {}, 'Annonces envoyées'),
        r.announcements.length === 0 ? empty('megaphone', 'Aucune annonce envoyée pour le moment')
          : h('div', { class: 'notif-list' }, r.announcements.map((a) => h('div', { class: 'notif' }, h('span', { class: 'notif-ico gold' }, icon('megaphone', 20)),
            h('span', { class: 'notif-main' }, h('b', {}, a.title), h('span', { class: 'notif-body' }, a.body), h('span', { class: 'notif-time' }, `${AUDIENCE_LABEL[a.audience]} · ${a.recipients} personne(s) · ${fmtDate(a.created_at)}`)))))));
  });
}
