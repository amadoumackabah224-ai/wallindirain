// Aide : assistant (réponses écrites à l'avance) + messagerie avec l'équipe Wallindirain.
// Réservé aux personnes connectées : la conversation avec l'équipe reste dans l'application.
import { h, fmtDate, errToast, showLegal } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

/** Ouvre la fenêtre d'aide (personne connectée). */
export function openHelp({ user, onRead }) {
  const opener = document.activeElement;
  let tab = 'bot', timer = null;
  const close = () => { clearInterval(timer); document.removeEventListener('keydown', onKey); panel.remove(); opener?.isConnected && opener.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const base = '';
  const body = h('div', { class: 'chat-body' });
  const tabBtns = [['bot', 'Assistant'], ['team', 'Écrire à l\'équipe']].map(([k, l]) =>
    h('button', { class: 'tab', type: 'button', 'data-tab': k, 'aria-pressed': String(k === tab), onclick: () => { tab = k; tabBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === k))); show(); } }, l));
  const panel = h('div', { class: 'chat', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chat-title' },
    h('div', { class: 'chat-head' }, h('span', { class: 'bot-av', 'aria-hidden': 'true' }, 'W'), h('div', { class: 'grow' }, h('h2', { id: 'chat-title' }, 'Assistant Wallindirain'), h('div', { class: 'chat-sub' }, 'Réponses instantanées · pas une personne')), h('button', { class: 'btn btn-sm btn-ghost chat-x', type: 'button', onclick: close, 'aria-label': 'Fermer l\'aide' }, '✕')),
    h('div', { class: 'chat-tabs' }, tabBtns), body);

  const bubble = (who, text) => h('div', { class: `bubble ${who}` }, text);

  // ----- assistant -----
  function showBot() {
    clearInterval(timer);
    const log = h('div', { class: 'chat-log tall', role: 'log', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Conversation avec l\'assistant' });
    const input = h('input', { type: 'text', maxlength: 300, placeholder: 'Posez votre question…', 'aria-label': 'Votre question', required: true, autocomplete: 'off' });
    let topicsData = null;
    const scroll = () => { log.scrollTop = log.scrollHeight; };
    const clearActions = () => log.querySelectorAll('.bot-actions').forEach((n) => n.remove());
    const say = async (shownText, payload) => {
      clearActions();
      log.append(bubble('me', shownText));
      const wait = bubble('bot typing', '…'); log.append(wait); scroll();
      try {
        const r = await post(`${base}/assistant`, payload);
        wait.remove();
        const card = h('div', { class: 'bubble bot' }, r.title && h('strong', { class: 'bt' }, r.title), h('div', {}, r.text));
        const acts = h('div', { class: 'bot-actions' });
        if (r.related?.length) acts.append(h('div', { class: 'small muted' }, 'Voir aussi :'), h('div', { class: 'chips' }, r.related.map((x) => h('button', { class: 'chip', type: 'button', onclick: () => say(x.title, { topic: x.id }) }, x.title))));
        acts.append(h('div', { class: 'chips' },
          r.legal && h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: () => showLegal(r.legal) }, 'Lire le texte complet'),
          r.team && h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: () => tabBtns.at(-1).click() }, 'Écrire à l\'équipe'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => menu() }, 'Tous les thèmes')));
        log.append(card, acts);
      } catch (e) { wait.remove(); log.append(bubble('bot', e.message)); }
      scroll();
    };
    // menu des thèmes -> sujets
    const menu = async (cat) => {
      clearActions();
      try { topicsData ||= (await get(`${base}/assistant/topics`)).topics; } catch (e) { log.append(bubble('bot', e.message)); return; }
      const box = h('div', { class: 'bot-actions' });
      if (!cat) {
        box.append(h('div', { class: 'small muted' }, 'Choisissez un thème :'),
          h('div', { class: 'topics' }, topicsData.map((c) => h('button', { class: 'topic', type: 'button', onclick: () => menu(c.key) }, c.label))));
      } else {
        const c = topicsData.find((x) => x.key === cat);
        box.append(h('div', { class: 'small muted' }, c.label),
          h('div', { class: 'topic-list' }, c.items.map((x) => h('button', { class: 'topic-row', type: 'button', onclick: () => say(x.title, { topic: x.id }) }, x.title))),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => menu() }, '← Tous les thèmes'));
      }
      log.append(box); scroll();
      box.querySelector('button')?.focus({ preventScroll: true });
    };
    log.append(bubble('bot', 'Bonjour ! Je réponds à vos questions sur Wallindirain et sur le commerce en ligne : commandes, retraits, livraison, mobile money, publicité, sécurité, règles… Je ne suis pas une personne : pour une urgence, écrivez à l\'équipe.'));
    const chips = h('div', { class: 'chips quick' });
    get(`${base}/assistant/suggestions`).then((r) => chips.replaceChildren(...r.suggestions.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => say(t, { question: t }) }, t)))).catch(() => {});
    body.replaceChildren(log, chips, h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) { input.value = ''; say(q, { question: q }); } } }, input, h('button', { class: 'btn btn-gold', type: 'submit' }, 'Envoyer')));
    menu();
    input.focus({ preventScroll: true });
  }

  // ----- équipe (connecté) -----
  async function showTeamUser() {
    const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    const input = h('textarea', { maxlength: 1000, rows: 2, placeholder: 'Votre message à l\'équipe…', 'aria-label': 'Votre message à l\'équipe', required: true });
    const load = async () => {
      try {
        const r = await get('/support?read=1');
        log.replaceChildren(bubble('bot', 'Écrivez-nous : un administrateur vous répond dans cette conversation. Ne partagez jamais votre mot de passe.'),
          ...r.messages.map((m) => h('div', { class: `bubble ${m.sender === 'admin' ? 'team' : 'me'}` }, m.body, h('div', { class: 'when' }, fmtDate(m.created_at)))));
        log.scrollTop = log.scrollHeight;
        if (r.unread) onRead?.();
      } catch (e) { log.replaceChildren(bubble('bot', e.message)); }
    };
    body.replaceChildren(log, h('form', { class: 'chat-form', onsubmit: async (e) => {
      e.preventDefault(); const t = input.value.trim(); if (!t) return;
      try { await post('/support', { body: t }); input.value = ''; await load(); } catch (ex) { errToast(ex); }
    } }, input, h('button', { class: 'btn btn-gold', type: 'submit' }, 'Envoyer')));
    await load();
    timer = setInterval(load, 15000);
  }

  function show() { if (tab === 'bot') showBot(); else showTeamUser(); }
  document.body.append(panel);
  document.addEventListener('keydown', onKey);
  show();
  return { close, goTeam: () => tabBtns.at(-1).click() };
}

/** Bouton flottant « Aide » (avec pastille si l'équipe a répondu). */
export function helpButton({ user }) {
  const dot = h('span', { class: 'dot hidden', 'aria-hidden': 'true' });
  const btn = h('button', { class: 'help-fab', type: 'button', onclick: () => openHelp({ user, onRead: () => dot.classList.add('hidden') }) }, icon('message', 18), ' Aide', dot);
  {
    const check = async () => { if (!btn.isConnected) return clearInterval(t); try { const r = await get('/support'); dot.classList.toggle('hidden', !r.unread); btn.setAttribute('aria-label', r.unread ? 'Aide : nouveau message de l\'équipe' : 'Aide'); } catch { /* hors ligne */ } };
    const t = setInterval(check, 45000); setTimeout(check, 1500);
  }
  return btn;
}
