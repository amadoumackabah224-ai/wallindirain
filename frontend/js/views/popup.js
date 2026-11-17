// Annonces en fenêtre : une image, un titre, un texte et un bouton, affichés à l'ouverture de l'application (comme les messages d'Orange Money).
import { h, liveView, empty, action, confirmBox, ask, fmtDate, badge } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

/** Affiche une annonce. `preview` : aperçu de l'administrateur (rien n'est compté). */
export function openPopup(p, { preview = false, imageSrc = null } = {}) {
  const prev = document.activeElement;
  const tell = (event) => { if (!preview) post(`/popup/${p.id}/event`, { event }).catch(() => {}); };
  const close = (event) => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.isConnected && prev.focus?.(); if (event) tell(event); };
  const onKey = (e) => { if (e.key === 'Escape') close('close'); };
  const go = () => {
    const t = p.cta_target || '';
    close('click');
    if (preview) return;
    if (t.startsWith('tab:')) location.hash = `#/app/${t.slice(4)}`;
    else if (/^https:\/\//.test(t)) window.open(t, '_blank', 'noopener,noreferrer');
  };
  const src = imageSrc || (p.has_image ? `/api/popup/${p.id}/image` : null);
  const overlay = h('div', { class: 'pop-overlay', onclick: (e) => { if (e.target === overlay) close('close'); } },
    h('div', { class: 'pop-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title },
      h('button', { class: 'pop-x', type: 'button', 'aria-label': 'Fermer', onclick: () => close('close') }, icon('x', 20)),
      h('div', { class: 'pop-card' },
        src ? h('img', { class: 'pop-img', src, alt: '' }) : h('div', { class: 'pop-hero' }, icon('megaphone', 40)),
        h('div', { class: 'pop-body' }, h('h2', {}, p.title), p.body && h('p', {}, p.body),
          p.cta_label && h('button', { class: 'btn btn-gold pop-cta', type: 'button', onclick: go }, p.cta_label)))));
  document.body.append(overlay); document.addEventListener('keydown', onKey);
  overlay.querySelector('.pop-x').focus();
  if (!preview) tell('seen');
}

let checked = false;
/** À l'ouverture : montre la prochaine annonce prévue pour cette personne, au plus une fois par ouverture de l'application. */
export async function showPopupIfAny() {
  if (checked || document.querySelector('.pop-overlay')) return;
  checked = true;
  try { const r = await get('/popup/next'); if (r.popup) openPopup(r.popup); } catch { /* sans réseau ou fonction fermée : rien à montrer */ }
}
export const resetPopupCheck = () => { checked = false; };

const AUDIENCES = [['all', 'Tout le monde'], ['seller', 'Les vendeurs'], ['supplier', 'Les fournisseurs'], ['courier', 'Les livreurs'], ['agent', 'Les agents du call center'], ['call_chief', 'Les chefs d\'équipe'], ['warehouse', 'Le magasin'], ['shipper', 'Les expéditeurs'], ['member', 'Les membres Mes finances']];
const AUD = Object.fromEntries(AUDIENCES);
const TARGETS = [['', 'Aucun bouton'], ['tab:pf', 'Ouvrir Mes finances'], ['tab:notifications', 'Ouvrir les notifications'], ['tab:profile', 'Ouvrir le profil'], ['https', 'Ouvrir une adresse web']];
const toLocal = (iso) => iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

/** Espace administrateur : créer, aperçu, publier, suivre les vues et clics. */
export function adminPopups() {
  return liveView(() => get('/admin/popups'), ({ enabled, popups }, refresh) => {
    const edit = (p) => action(async () => {
      const fields = [
        { name: 'title', label: 'Titre (120 caractères maximum)', value: p?.title || '' },
        { name: 'body', label: 'Texte (400 caractères maximum, facultatif)', type: 'textarea', value: p?.body || '' },
        { name: 'image', label: 'Image (facultatif ; format affiche, bien lisible sur téléphone)', type: 'image', required: false, hint: 'Une affiche verticale ou carrée, avec peu de texte, reste lisible sur téléphone.' },
        { name: 'audience', label: 'Pour qui ?', type: 'select', options: AUDIENCES.map(([k, l]) => [k, l]), value: p?.audience || 'all' },
        { name: 'target', label: 'Bouton', type: 'select', options: TARGETS, value: !p?.cta_target ? '' : p.cta_target.startsWith('https://') ? 'https' : p.cta_target },
        { name: 'label', label: 'Texte du bouton (ex. Découvrir)', value: p?.cta_label || '', required: false },
        { name: 'url', label: 'Adresse web (https://...) si « adresse web »', value: p?.cta_target?.startsWith('https://') ? p.cta_target : '', required: false },
        { name: 'starts', label: 'Début', type: 'datetime-local', value: toLocal(p?.starts_at || new Date().toISOString()) },
        { name: 'ends', label: 'Fin (facultatif)', type: 'datetime-local', value: toLocal(p?.ends_at), required: false },
        { name: 'frequency', label: 'Combien de fois ?', type: 'select', options: [['once', 'Une seule fois par personne'], ['daily', 'Une fois par jour jusqu\'à la fin']], value: p?.frequency || 'once' }
      ];
      const v = await ask({ title: p ? 'Modifier l\'annonce' : 'Nouvelle annonce en fenêtre', text: 'L\'annonce est enregistrée en brouillon : elle ne s\'affiche qu\'après « Publier ».', submit: 'Enregistrer', fields });
      if (!v) return;
      const target = v.target === 'https' ? v.url.trim() : v.target;
      const body = { id: p?.id, title: v.title, body: v.body, audience: v.audience, cta_label: target ? v.label : '', cta_target: target || '',
        starts_at: v.starts ? new Date(v.starts).toISOString() : null, ends_at: v.ends ? new Date(v.ends).toISOString() : null, frequency: v.frequency };
      if (v.image) body.image = v.image;
      await post('/admin/popups', body);
    }, { ok: 'Annonce enregistrée', refresh });
    const publish = (p) => action(async () => {
      if (!p.active && !(await confirmBox('Publier cette annonce ?', `Elle s'affichera à : ${AUD[p.audience]}, à leur prochaine ouverture de l'application.${enabled ? '' : ' Attention : les annonces en fenêtre sont éteintes, activez-les plus haut.'}`, 'Publier'))) return;
      await post(`/admin/popups/${p.id}/active`, { active: !p.active });
    }, { ok: p.active ? 'Annonce retirée' : 'Annonce publiée', refresh });
    const archive = (p) => action(async () => { if (await confirmBox('Archiver cette annonce ?', 'Elle ne s\'affichera plus et disparaîtra de la liste.', 'Archiver', true)) await post(`/admin/popups/${p.id}/archive`); }, { ok: 'Annonce archivée', refresh });
    const toggle = action(async () => {
      if (!(await confirmBox(enabled ? 'Éteindre les annonces en fenêtre ?' : 'Allumer les annonces en fenêtre ?', enabled ? 'Plus aucune fenêtre ne s\'affichera, sans rien supprimer.' : 'Les annonces publiées s\'afficheront à l\'ouverture de l\'application.', enabled ? 'Éteindre' : 'Allumer', enabled))) return;
      await post('/admin/settings', { key: 'feature_popups', value: enabled ? 0 : 1 });
    }, { ok: enabled ? 'Annonces en fenêtre éteintes' : 'Annonces en fenêtre allumées', refresh });
    return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'gap' }, h('div', { class: 'grow' }, h('b', {}, 'Annonces en fenêtre'), ' ', badge(enabled ? 'Allumées' : 'Éteintes', enabled ? 'ok' : 'warn'),
        h('div', { class: 'small muted' }, 'Une image, un texte et un bouton qui s\'affichent à l\'ouverture de l\'application, comme les messages d\'Orange Money. Éteintes par défaut.')),
        h('button', { class: `btn btn-sm ${enabled ? 'btn-ghost' : 'btn-gold'}`, type: 'button', onclick: toggle }, enabled ? 'Éteindre' : 'Allumer')),
        h('div', { class: 'gap' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: edit(null) }, icon('plus', 18), 'Nouvelle annonce'))),
      popups.length === 0 ? h('div', { class: 'card' }, empty('megaphone', 'Aucune annonce en fenêtre pour le moment'))
        : popups.map((p) => h('div', { class: 'card' }, h('div', { class: 'gap' }, h('div', { class: 'grow' }, h('b', {}, p.title), ' ', badge(p.live ? 'En ligne' : p.active ? 'Programmée ou terminée' : 'Brouillon', p.live ? 'ok' : 'warn'),
            h('div', { class: 'small muted' }, `${AUD[p.audience]} · ${p.frequency === 'daily' ? 'chaque jour' : 'une fois'} · du ${fmtDate(p.starts_at)}${p.ends_at ? ` au ${fmtDate(p.ends_at)}` : ''}`),
            h('div', { class: 'small' }, `${p.views} vue(s) · ${p.clicks} clic(s) · ${p.closed} fermeture(s)`))),
          h('div', { class: 'gap' },
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openPopup(p, { preview: true }) }, 'Aperçu'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: edit(p) }, 'Modifier'),
            h('button', { class: `btn btn-sm ${p.active ? 'btn-ghost' : 'btn-gold'}`, type: 'button', onclick: publish(p) }, p.active ? 'Retirer' : 'Publier'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: archive(p) }, 'Archiver')))));
  });
}
