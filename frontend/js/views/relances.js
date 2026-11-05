// Relances du vendeur : il écrit ou appelle ses clients un par un, avec son propre téléphone (SMS, WhatsApp ou appel).
// Wallindirain prépare la liste, le message et le suivi ; elle n'envoie rien. Le texte n'est jamais envoyé au serveur ni enregistré.
import { h, badge, empty, ask, confirmBox, action, toast, fmtDate, fmtPhone, liveView } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const STOP = 'Répondez STOP pour ne plus recevoir de messages.';

// Modèles proposés : à relire et à adapter. Marques permises : {prenom}, {boutique}, {fete}. Jamais d'information de commande ni de code de livraison.
const SUGGESTED = {
  fideles: [['Merci pour votre fidélité', 'Bonjour {prenom}, merci pour votre fidélité chez {boutique} ! De nouveaux articles viennent d\'arriver. Voulez-vous que je vous les présente ?']],
  nouveaux: [['Merci pour votre première commande', 'Bonjour {prenom}, merci d\'avoir commandé chez {boutique}. Êtes-vous satisfait(e) de votre achat ? Votre avis m\'aide beaucoup.']],
  inactifs: [['On ne s\'est pas parlé depuis un moment', 'Bonjour {prenom}, cela fait un moment ! {boutique} a de nouveaux articles qui pourraient vous plaire. Je peux vous les montrer ?']],
  non_abouti: [['Reprogrammer la livraison', 'Bonjour {prenom}, nous n\'avons pas pu vous remettre votre colis. Souhaitez-vous que nous reprogrammions la livraison ? Dites-moi quel jour vous arrange.']],
  fete: [['Voeux de fête', 'Bonjour {prenom}, toute l\'équipe de {boutique} vous souhaite une très belle {fete} !']],
  generic: [['Message simple', 'Bonjour {prenom}, c\'est {boutique}. Comment puis-je vous aider aujourd\'hui ?']]
};
const suggestedFor = (list) => [...(SUGGESTED[list] || []), ...SUGGESTED.generic];

const AUTO = { livre: ['Livré', 'ok'], paye: ['Payé', 'ok'], echec: ['Échec', 'bad'], a_relancer: ['À relancer', 'warn'], nouveau: ['Nouveau', 'info'], fidele: ['Fidèle', 'ok'],
  bon_client: ['Bon client', 'ok'], inactif: ['Inactif', 'grey'], a_risque: ['Client à risque', 'bad'] };
const COLOR_KIND = { green: 'ok', red: 'bad', gold: 'warn', blue: 'info', grey: 'grey' };
const COLOR_LABEL = [['green', 'Vert'], ['red', 'Rouge'], ['gold', 'Doré'], ['blue', 'Bleu'], ['grey', 'Gris']];
const OUTCOME = { answered: 'a répondu', no_answer: 'pas de réponse', call_back: 'à rappeler' };
const EVENT = { order_created: 'Commande créée', delivered: 'Commande livrée', failed: 'Livraison échouée', returned: 'Commande retournée', refused: 'Commande refusée', note: 'Note ajoutée' };

const tagBadges = (c) => [...c.auto_tags.map((k) => badge(AUTO[k]?.[0] || k, AUTO[k]?.[1] || 'grey')), ...c.tags.map((t) => badge(t.name, COLOR_KIND[t.color] || 'grey'))];
const isoPlus = (d) => { const x = new Date(Date.now() + d * 86_400_000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const dayLabel = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** Message prêt à envoyer : marques remplacées, mention STOP ajoutée à la fin. */
export function buildMessage(tpl, { first_name }, { shop, feast }) {
  const text = String(tpl).replaceAll('{prenom}', first_name || '').replaceAll('{boutique}', shop || '').replaceAll('{fete}', feast || '').replace(/ +,/g, ',').replace(/ {2,}/g, ' ').trim();
  return `${text}\n${STOP}`;
}
const smsHref = (phone, body) => `sms:+224${phone}?&body=${encodeURIComponent(body)}`;
const waHref = (phone, body) => `https://wa.me/224${phone}?text=${encodeURIComponent(body)}`;
const telHref = (phone) => `tel:+224${phone}`;
/** Ouvre le lien comme un appui du doigt (le téléphone ouvre son application de SMS, de WhatsApp ou d'appel). */
const openLink = (href, newTab = false) => { const a = h('a', { href, target: newTab ? '_blank' : null, rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); };

// ---------- Point d'entrée ----------
export function sellerRelances() {
  return h('div', {}, h('h1', {}, 'Relances'), liveView(() => get('/seller/relances'), (o, refresh) => {
    if (!o.enabled) return h('div', { class: 'notice' }, 'Les relances ne sont pas encore disponibles pour votre compte. L\'équipe Wallindirain vous préviendra dès qu\'elles seront ouvertes.');
    if (!o.consent.ok) return consentScreen(o, refresh);
    return home(o, refresh);
  }));
}

function consentScreen(o, refresh) {
  const ok = h('input', { type: 'checkbox', id: 'rel-ok' });
  const go = h('button', { class: 'btn btn-gold', type: 'button', disabled: true, onclick: action(() => post('/seller/relances/consent', { version: o.consent.version }), { ok: 'Engagement enregistré', refresh }) }, 'Je m\'engage et je commence');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  return h('div', { class: 'card' },
    h('h2', {}, 'Avant de commencer : mon engagement'),
    h('p', { class: 'muted' }, 'Les relances vous permettent d\'écrire ou d\'appeler vos clients, un par un, avec votre propre téléphone. Wallindirain prépare la liste et le message ; c\'est vous qui envoyez.'),
    h('ul', {},
      h('li', {}, 'J\'écris ou j\'appelle seulement des clients qui ont commandé chez moi.'),
      h('li', {}, 'Je respecte un client qui me demande de ne plus le contacter : je touche « Ne plus contacter » aussitôt.'),
      h('li', {}, 'Je n\'envoie aucun message trompeur, menaçant ou insultant, et jamais le code de livraison d\'une commande.'),
      h('li', {}, 'Je sais que Wallindirain n\'envoie rien à ma place : je suis responsable des messages que j\'envoie.')),
    h('label', { class: 'f', for: 'rel-ok' }, ok, 'Je l\'ai lu et je m\'engage à le respecter'),
    go);
}

// ---------- Accueil des relances ----------
function home(o, refresh) {
  const host = h('div');
  const open = (spec) => host.replaceChildren(queue({ ...spec, o, back: refresh }));
  const L = o.lists;

  const alerts = [];
  if (o.reminders_today) alerts.push(h('div', { class: 'notice warn' }, h('b', {}, `${plural(o.reminders_today, 'client à relancer', 'clients à relancer')} aujourd'hui. `),
    h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: () => open({ list: 'rappels', title: 'À relancer aujourd\'hui' }) }, 'Voir')));
  for (const f of o.feasts.filter((x) => x.days_left <= 7)) alerts.push(h('div', { class: 'notice' }, h('b', {}, `${f.name} : ${f.days_left === 0 ? 'c\'est aujourd\'hui' : `dans ${plural(f.days_left, 'jour', 'jours')}`}. `),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open({ list: 'fete', title: f.name, feast: f.name }) }, 'Écrire à mes clients')));

  const card = (title, hint, n, onOpen, { disabled = false } = {}) => h('div', { class: 'card' }, h('h3', {}, title), h('p', { class: 'small muted' }, hint),
    h('div', { class: 'gap' }, h('b', {}, plural(n, 'client', 'clients')), h('button', { class: 'btn btn-sm btn-gold', type: 'button', disabled: disabled || n === 0, onclick: onOpen }, 'Ouvrir')));
  const inactifs = h('div', { class: 'card' }, h('h3', {}, 'Inactifs'), h('p', { class: 'small muted' }, 'Clients livrés, mais sans nouvelle commande depuis un moment.'),
    h('div', { class: 'chips' }, [[30, L.inactifs_30], [60, L.inactifs_60], [90, L.inactifs_90]].map(([d, n]) => h('button', { class: 'chip', type: 'button', disabled: n === 0,
      onclick: () => open({ list: 'inactifs', days: d, title: `Inactifs depuis ${d} jours ou plus` }) }, `${d} jours ou plus (${n})`))));

  const reglages = action(async () => {
    const v = await ask({ title: 'Mes réglages de relance', text: 'Vous décidez vous-même combien de messages vous envoyez par jour. Laissez « Maximum par jour » vide pour ne mettre aucune limite.', submit: 'Enregistrer', fields: [
      { name: 'shop_name', label: 'Nom de ma boutique (pour les messages)', value: o.prefs.shop_name || '', required: false, maxlength: 40 },
      { name: 'daily_max', label: 'Maximum de messages par jour', type: 'number', inputmode: 'numeric', value: o.prefs.daily_max ?? '', required: false, hint: 'Atteint, l\'application s\'arrête. Vous pouvez le changer quand vous voulez.' },
      { name: 'interval_days', label: 'Jours minimum entre deux messages au même client', type: 'number', inputmode: 'numeric', value: o.prefs.interval_days, hint: '7 jours au minimum, pour ne pas harceler vos clients.' }] });
    if (!v) return;
    await post('/seller/relances/prefs', { shop_name: v.shop_name, daily_max: v.daily_max === '' ? null : Number(v.daily_max), interval_days: Number(v.interval_days) });
  }, { ok: 'Réglages enregistrés', refresh });

  const newTemplate = (t) => action(async () => {
    const v = await ask({ title: t ? 'Modifier le modèle' : 'Nouveau modèle de message', text: 'Marques permises : {prenom}, {boutique}, {fete}. N\'écrivez jamais de code de livraison. La mention « Répondez STOP » est ajoutée toute seule.', submit: 'Enregistrer', fields: [
      { name: 'title', label: 'Titre', value: t?.title || '', maxlength: 40 }, { name: 'body', label: 'Message', type: 'textarea', rows: 5, maxlength: 300, value: t?.body || 'Bonjour {prenom}, ' }] });
    if (!v) return;
    await post('/seller/relances/templates', { id: t?.id, title: v.title, body: v.body });
  }, { ok: 'Modèle enregistré', refresh });
  const delTemplate = (t) => action(async () => { if (!(await confirmBox('Supprimer ce modèle ?', t.title, 'Supprimer', true))) return; await post(`/seller/relances/templates/${t.id}/delete`); }, { ok: 'Modèle supprimé', refresh });

  const newTag = action(async () => {
    const v = await ask({ title: 'Nouvelle étiquette', text: 'Par exemple « Tabaski », « gros acheteur », « paie toujours cash ». Vous la mettez ensuite sur vos clients.', submit: 'Créer', fields: [
      { name: 'name', label: 'Nom', maxlength: 30 }, { name: 'color', label: 'Couleur', type: 'select', options: COLOR_LABEL, value: 'blue' }] });
    if (!v) return;
    await post('/seller/relances/tags', { name: v.name, color: v.color });
  }, { ok: 'Étiquette créée', refresh });
  const delTag = (t) => action(async () => { if (!(await confirmBox('Supprimer cette étiquette ?', `« ${t.name} » sera retirée de tous vos clients.`, 'Supprimer', true))) return; await post(`/seller/relances/tags/${t.id}/delete`); }, { ok: 'Étiquette supprimée', refresh });

  const newFeast = (f) => action(async () => {
    const v = await ask({ title: f ? 'Modifier la fête' : 'Ajouter une fête', text: 'Écrivez le nom et la date vous-même : la date de la Tabaski, par exemple, change chaque année. Un rappel s\'affiche 7 jours avant.', submit: 'Enregistrer', fields: [
      { name: 'name', label: 'Nom de la fête', value: f?.name || '', maxlength: 40 }, { name: 'date', label: 'Date', type: 'date', value: f?.on_date || isoPlus(7) }] });
    if (!v) return;
    await post('/seller/relances/feasts', { id: f?.id, name: v.name, date: v.date });
  }, { ok: 'Fête enregistrée', refresh });
  const delFeast = (f) => action(async () => { if (!(await confirmBox('Supprimer cette fête ?', f.name, 'Supprimer', true))) return; await post(`/seller/relances/feasts/${f.id}/delete`); }, { ok: 'Fête supprimée', refresh });

  const section = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), ...kids);
  host.replaceChildren(
    ...alerts,
    h('p', { class: 'muted' }, 'Écrivez ou appelez vos clients un par un, avec votre téléphone. Wallindirain n\'envoie rien : elle prépare la liste et garde le suivi.'),
    h('div', { class: 'gap mb' },
      h('span', { class: 'small muted grow' }, `Aujourd'hui : ${plural(o.sent_today, 'message', 'messages')}${o.prefs.daily_max ? ` sur ${o.prefs.daily_max}` : ''} · ${o.prefs.interval_days} jours entre deux messages au même client`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: reglages }, icon('sliders', 16), 'Réglages')),
    h('div', { class: 'grid g2' },
      card('Fidèles', 'Au moins 2 commandes livrées.', L.fideles, () => open({ list: 'fideles', title: 'Fidèles' })),
      card('Nouveaux', 'Première commande livrée il y a 30 jours ou moins.', L.nouveaux, () => open({ list: 'nouveaux', title: 'Nouveaux clients' })),
      inactifs,
      card('Commande non aboutie', 'Le client était absent à la livraison.', L.non_abouti, () => open({ list: 'non_abouti', title: 'Commande non aboutie' })),
      card('Rappels du jour', 'Clients que vous avez choisi de rappeler.', L.rappels, () => open({ list: 'rappels', title: 'À relancer aujourd\'hui' })),
      card('Tous mes clients livrés', 'Pour une fête ou une annonce : tous les clients livrés au moins une fois.', L.fete, () => open({ list: 'fete', title: 'Tous mes clients livrés' })),
      card('À éviter', 'Clients à risque : jamais contactés par les relances. Vous les voyez ici, sans bouton d\'envoi.', L.a_eviter, () => open({ list: 'a_eviter', title: 'À éviter' }))),
    section('Par étiquette', o.tags.length ? h('div', { class: 'chips' }, o.tags.map((t) => h('span', { class: 'gap' },
      h('button', { class: 'chip', type: 'button', disabled: t.count === 0, onclick: () => open({ list: 'etiquette', tag: t.id, title: `Étiquette « ${t.name} »` }) }, `${t.name} (${t.count})`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Supprimer l'étiquette ${t.name}`, onclick: delTag(t) }, icon('x', 14))))) : h('p', { class: 'small muted' }, 'Aucune étiquette pour le moment.'),
      h('div', { class: 'mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: newTag }, icon('plus', 16), 'Nouvelle étiquette'))),
    section('Mes fêtes', o.feasts.length ? o.feasts.map((f) => h('div', { class: 'gap mb' }, h('b', { class: 'grow' }, `${f.name} · ${dayLabel(f.on_date)}`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open({ list: 'fete', title: f.name, feast: f.name }) }, 'Écrire'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: newFeast(f) }, 'Modifier'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Supprimer ${f.name}`, onclick: delFeast(f) }, icon('x', 14)))) : h('p', { class: 'small muted' }, 'Aucune fête. Ajoutez celles qui comptent pour vos clients, avec leur date.'),
      h('div', { class: 'mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: newFeast(null) }, icon('plus', 16), 'Ajouter une fête'))),
    section('Mes modèles de messages', h('p', { class: 'small muted' }, 'Des modèles sont déjà proposés dans chaque liste. Ajoutez les vôtres ici. Le texte réellement envoyé n\'est jamais enregistré par Wallindirain.'),
      o.templates.map((t) => h('div', { class: 'gap mb' }, h('div', { class: 'grow' }, h('b', {}, t.title), h('div', { class: 'small muted' }, t.body)),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: newTemplate(t) }, 'Modifier'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Supprimer ${t.title}`, onclick: delTemplate(t) }, icon('x', 14)))),
      h('div', { class: 'mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: newTemplate(null) }, icon('plus', 16), 'Nouveau modèle'))));
  return host;
}

// ---------- File d'envoi : un client à la fois ----------
function queue({ list, days, tag, title, feast, o, back }) {
  const shop = o.prefs.shop_name || o.seller_name || 'ma boutique';
  const qs = `list=${list}${days ? `&days=${days}` : ''}${tag ? `&tag=${tag}` : ''}`;
  return h('div', {}, h('div', { class: 'gap mb' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: back }, '← Retour'), h('h2', { class: 'grow' }, title)),
    liveView(() => get(`/seller/relances/list?${qs}`), (r, reload) => {
      if (!r.count) return empty('users', 'Aucun client dans cette liste pour le moment.');
      if (r.readonly) return h('div', {}, h('div', { class: 'notice warn' }, 'Ces clients ont déjà causé un incident (refus du colis, par exemple). Ils ne sont jamais contactés par les relances : aucun bouton d\'envoi.'),
        r.customers.map((c) => h('div', { class: 'card' }, h('b', {}, c.name), ' ', h('span', { class: 'muted' }, fmtPhone(c.phone)), h('div', { class: 'chips mt' }, tagBadges(c)))));
      return runner({ r, list, feast, shop, o, reload, back });
    }));
}

function runner({ r, list, feast, shop, o, reload, back }) {
  const customers = r.customers;
  let idx = 0, sentN = 0, callN = 0;
  const tpls = [...suggestedFor(list).map(([t, b]) => ({ title: `${t} (proposé)`, body: b })), ...o.templates];
  const host = h('div');
  const advance = () => { idx++; draw(); };

  function draw() {
    if (idx >= customers.length) {
      host.replaceChildren(h('div', { class: 'card center' }, h('h2', {}, 'Liste terminée'),
        h('p', { class: 'muted' }, `${plural(sentN, 'message', 'messages')} · ${plural(callN, 'appel', 'appels')} enregistré(s).`),
        h('button', { class: 'btn btn-gold', type: 'button', onclick: back }, 'Retour aux relances')));
      return;
    }
    const c = customers[idx];
    const tplSel = h('select', { 'aria-label': 'Modèle de message' }, tpls.map((t, i) => h('option', { value: i }, t.title)));
    const msg = h('textarea', { rows: 5, maxlength: 600, 'aria-label': 'Message à envoyer' });
    const fill = () => { msg.value = buildMessage(tpls[Number(tplSel.value)].body, c, { shop, feast }); };
    tplSel.addEventListener('change', fill); fill();
    const status = h('div');
    const bar = h('div', { class: 'gap mt relance-bar' });

    const setTagsBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(() => editTags(c, o), { refresh: async () => { const f = await get(`/seller/relances/customer/${c.phone}`); c.tags = f.tags; draw(); } }) }, 'Étiquettes');
    const remindBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => {
      const v = await ask({ title: `Rappeler ${c.name}`, text: 'Choisissez le jour. Il apparaîtra dans « Rappels du jour ». Une date vide efface le rappel.', submit: 'Enregistrer', fields: [{ name: 'date', label: 'Date', type: 'date', value: c.reminder_on || isoPlus(1), required: false }] });
      if (!v) return;
      await post(`/seller/relances/customers/${c.phone}/reminder`, { date: v.date || null }); c.reminder_on = v.date || null;
    }, { ok: 'Rappel enregistré', refresh: draw }) }, c.reminder_on ? `Rappel : ${dayLabel(c.reminder_on)}` : 'Me rappeler');
    const optBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => {
      if (!(await confirmBox('Ne plus contacter ce client ?', `${c.name} disparaîtra de toutes vos listes. Seul l'administrateur Wallindirain pourra le remettre.`, 'Ne plus contacter', true))) return;
      await post(`/seller/relances/customers/${c.phone}/optout`);
      customers.splice(idx, 1); draw();
    }, { ok: 'Client retiré des relances' }) }, 'Ne plus contacter');
    const ficheBox = h('div', { class: 'hidden' });
    const ficheBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
      ficheBox.classList.toggle('hidden'); if (ficheBox.classList.contains('hidden')) return;
      ficheBox.replaceChildren(h('div', { class: 'spinner', role: 'status' }));
      try { ficheBox.replaceChildren(history(await get(`/seller/relances/customer/${c.phone}`))); } catch (e) { ficheBox.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
    } }, 'Historique');

    // un seul geste : la base vérifie les règles (désinscrit, à risque, délai, maximum par jour), puis le téléphone ouvre l'application
    const contact = (channel) => action(async () => {
      try { await post('/seller/relances/open', { phone: c.phone, channel }); }
      catch (e) { if (e.code === 'too_soon' || e.code === 'daily_limit' || e.code === 'opted_out' || e.code === 'risky_customer') { toast(e.message, 'bad'); await reload(); return; } throw e; }
      const text = msg.value;
      if (channel === 'sms') openLink(smsHref(c.phone, text)); else if (channel === 'whatsapp') openLink(waHref(c.phone, text), true); else openLink(telHref(c.phone));
      afterOpen(channel, text);
    });
    const afterOpen = (channel, text) => {
      const again = channel === 'sms' ? h('a', { class: 'btn btn-sm btn-ghost', href: smsHref(c.phone, text) }, 'Ouvrir à nouveau') : channel === 'whatsapp' ? h('a', { class: 'btn btn-sm btn-ghost', href: waHref(c.phone, text), target: '_blank', rel: 'noopener' }, 'Ouvrir à nouveau') : null;
      const log = (outcome, remind_on) => action(async () => { await post('/seller/relances/log', { phone: c.phone, channel, outcome, list: r.list === 'a_eviter' ? null : r.list, remind_on }); if (channel === 'call') callN++; else sentN++; }, { ok: channel === 'call' ? 'Appel enregistré' : 'Relance enregistrée', refresh: advance });
      if (channel === 'call') {
        status.replaceChildren(h('div', { class: 'notice' }, h('b', {}, 'Comment s\'est passé l\'appel ?')));
        bar.replaceChildren(h('button', { class: 'btn btn-gold', type: 'button', onclick: log('answered') }, 'Répondu'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: log('no_answer') }, 'Pas de réponse'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: action(async () => {
            const v = await ask({ title: 'À rappeler quand ?', text: `Le rappel apparaîtra dans « Rappels du jour » pour ${c.name}.`, submit: 'Enregistrer', fields: [{ name: 'date', label: 'Date', type: 'date', value: isoPlus(1) }] });
            if (!v) return; await log('call_back', v.date)();
          }) }, 'À rappeler'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: draw }, 'Annuler'));
      } else {
        status.replaceChildren(h('div', { class: 'notice' }, h('b', {}, channel === 'sms' ? 'Votre application de messages s\'est ouverte. ' : 'WhatsApp s\'est ouvert. '), 'Envoyez le message, puis revenez ici.'));
        bar.replaceChildren(h('button', { class: 'btn btn-gold', type: 'button', onclick: log(null) }, 'C\'est envoyé'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: draw }, 'Pas envoyé'), again);
      }
      bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const blockedMsg = !c.can_message ? (c.next_message_on ? `Déjà relancé : prochain message possible le ${dayLabel(c.next_message_on)}.` : r.daily_reached ? `Vous avez atteint votre maximum de ${r.daily_max} messages aujourd'hui (réglable dans « Réglages »).` : 'Messages indisponibles pour ce client.') : '';
    bar.replaceChildren(
      h('button', { class: 'btn btn-gold', type: 'button', disabled: !c.can_message, onclick: contact('sms') }, icon('message', 16), 'Message simple (SMS)'),
      h('button', { class: 'btn btn-gold', type: 'button', disabled: !c.can_message, onclick: contact('whatsapp') }, icon('message', 16), 'WhatsApp'),
      h('button', { class: 'btn btn-ghost', type: 'button', disabled: !c.can_call, onclick: contact('call') }, icon('phone', 16), 'Appeler'));

    host.replaceChildren(
      h('div', { class: 'small muted' }, `Client ${idx + 1} sur ${customers.length}`),
      h('div', { class: 'card' },
        h('div', { class: 'gap' }, h('h3', { class: 'grow' }, c.name), h('span', { class: 'muted nowrap' }, fmtPhone(c.phone))),
        h('div', { class: 'small muted' }, `${c.commune || ''} · ${plural(c.delivered, 'livraison', 'livraisons')} sur ${plural(c.orders, 'commande', 'commandes')}${c.last_contact_at ? ` · dernier contact : ${fmtDate(c.last_contact_at)}` : ''}`),
        h('div', { class: 'chips mt' }, tagBadges(c)),
        c.note && h('div', { class: 'small'}, h('b', {}, 'Ma note : '), c.note),
        h('label', { class: 'f mt' }, h('span', {}, 'Modèle de message'), tplSel),
        h('label', { class: 'f' }, h('span', {}, 'Message (vous pouvez le modifier avant l\'envoi)'), msg),
        blockedMsg && h('div', { class: 'notice warn' }, blockedMsg),
        status, bar,
        h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: advance }, 'Passer'), remindBtn, setTagsBtn, ficheBtn, optBtn),
        ficheBox));
  }
  draw();
  return h('div', {}, r.blocked_recently ? h('div', { class: 'small muted mb' }, `${plural(r.blocked_recently, 'client déjà relancé récemment', 'clients déjà relancés récemment')} : seuls les appels sont possibles pour eux.`) : null, host);
}

/** Étiquettes d'un client : une case par étiquette du vendeur. */
async function editTags(c, o) {
  const f = await get(`/seller/relances/customer/${c.phone}`);
  if (!f.all_tags.length) { toast('Créez d\'abord une étiquette dans l\'accueil des relances', 'bad'); return; }
  const v = await ask({ title: `Étiquettes de ${c.name}`, text: 'Cochez celles qui vont à ce client.', submit: 'Enregistrer', fields: f.all_tags.map((t) => ({ name: t.id, label: t.name, type: 'checkbox', value: f.tags.some((x) => x.id === t.id) })) });
  if (!v) return;
  for (const t of f.all_tags) {
    const was = f.tags.some((x) => x.id === t.id);
    if (v[t.id] !== was) await post(`/seller/relances/customers/${c.phone}/tags`, { tag_id: t.id, on: !!v[t.id] });
  }
}

/** Historique daté d'un client : commandes, livraisons, échecs, relances, notes. */
function history(f) {
  const line = (e) => {
    const txt = e.kind === 'relance' ? (e.channel === 'call' ? `Appel : ${OUTCOME[e.outcome] || ''}` : e.channel === 'sms' ? 'Message simple (SMS) envoyé' : 'WhatsApp envoyé') : `${EVENT[e.kind] || e.kind}${e.ref ? ` · ${e.ref}` : ''}`;
    return h('div', { class: 'gap small' }, h('span', { class: 'muted nowrap' }, fmtDate(e.at)), h('span', {}, txt));
  };
  return h('div', { class: 'mt' }, h('h4', {}, 'Historique'), f.history.length ? f.history.map(line) : h('p', { class: 'small muted' }, 'Rien pour le moment.'));
}
