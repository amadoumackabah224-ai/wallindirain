// Espaces de groupe (migration 057) : un budget partagé pour une activité ou un groupe, avec des rôles.
// Séparé des finances personnelles. Les catégories sont celles du propriétaire de l'espace.
import { h, ask, confirmBox, action, toast, errToast, empty, badge, liveView, fmtGNF } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const ROLE = { owner: 'Propriétaire', accountant: 'Comptable', contributor: 'Contributeur', viewer: 'Lecteur' };
const ROLE_HELP = { accountant: 'écrit et corrige tout', contributor: 'ajoute ses propres opérations', viewer: 'consulte seulement' };
const KIND = { cash: 'Espèces', mobile_money: 'Mobile money', bank: 'Banque', savings: 'Épargne', other: 'Autre' };
const COLORS = { blue: 'Bleu', green: 'Vert', orange: 'Orange', red: 'Rouge', purple: 'Violet', brown: 'Marron', teal: 'Turquoise', grey: 'Gris' };
const ACTION = { space_create: 'Espace créé', rename: 'Espace renommé', archive: 'Espace archivé', unarchive: 'Espace rétabli', invite: 'Invitation', accept: 'Invitation acceptée', decline: 'Invitation refusée', role: 'Rôle modifié', remove: 'Membre retiré', leave: 'Départ', account: 'Compte', account_archive: 'Compte archivé', tx_add: 'Opération ajoutée', tx_update: 'Opération modifiée', tx_void: 'Opération supprimée', transfer: 'Virement' };
const today = () => new Date().toISOString().slice(0, 10);
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const catName = (cats, key) => { const c = cats.find((x) => x.key === key); return c ? `${c.icon ? `${c.icon} ` : ''}${c.label}` : key; };
function catOptions(cats, kind) {
  const out = [];
  const walk = (parent, depth) => { for (const c of cats.filter((i) => i.parent === parent && i.kind === kind && !i.hidden)) { out.push([c.key, `${'  '.repeat(depth)}${c.icon ? `${c.icon} ` : ''}${c.label}`]); walk(c.key, depth + 1); } };
  walk(null, 0);
  return out;
}

/** Liste des espaces + invitations + création. */
export function spacesScreen({ go, head, card }) {
  return liveView(() => get('/pf/spaces'), (o, refresh) => {
    if (!o.spaces_enabled) return h('div', {}, head('Espaces de groupe', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' }, empty('users', 'Les espaces de groupe ne sont pas encore ouverts.')));
    const create = action(async () => {
      const v = await ask({ title: 'Nouvel espace', text: 'Un budget partagé, séparé de vos finances personnelles : boutique, association, tontine, équipe…', submit: 'Créer', fields: [{ name: 'name', label: 'Nom de l\'espace', maxlength: 60 }] });
      if (!v) return;
      const r = await post('/pf/spaces', { name: v.name });
      go(`space-${r.id}`);
    }, { refresh });
    const respond = (i, accept) => action(async () => { await post(`/pf/spaces/${i.space_id}/respond`, { accept }); }, { ok: accept ? 'Invitation acceptée' : 'Invitation refusée', refresh });
    return h('div', {}, head('Espaces de groupe', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' },
      o.invitations.map((i) => card(`Invitation · ${i.name}`, h('p', { class: 'pf-note' }, `${i.invited_by_name || 'Quelqu\'un'} vous invite comme ${ROLE[i.role].toLowerCase()} (${ROLE_HELP[i.role]}).`),
        h('div', { class: 'pf-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: respond(i, true) }, 'Accepter'), h('button', { class: 'btn', type: 'button', onclick: respond(i, false) }, 'Refuser')))),
      o.spaces.length === 0 ? empty('users', 'Aucun espace pour le moment.') : h('section', { class: 'pf-card flush' }, o.spaces.map((s) => h('button', { class: `pf-row${s.archived_at ? ' dim' : ''}`, type: 'button', onclick: () => go(`space-${s.id}`) },
        h('span', { class: 'pf-ico pf-c-teal' }, icon('users', 24)), h('span', { class: 'pf-row-main' }, h('b', {}, s.name), h('span', { class: 'pf-amt' }, fmtGNF(s.balance)), h('small', {}, `${ROLE[s.role]} · ${s.members} membre${s.members > 1 ? 's' : ''}${s.archived_at ? ' · archivé' : ''}`)), icon('chevronRight', 18)))),
      o.can_create ? h('button', { class: 'btn primary block', type: 'button', onclick: create }, 'Créer un espace') : h('p', { class: 'pf-note' }, 'Créer un espace fait partie de la formule Pro. Vous pouvez toutefois rejoindre l\'espace d\'une autre personne sur invitation.')));
  });
}

/** Détail d'un espace : onglets Aperçu · Opérations · Comptes · Membres · Activité. */
export function spaceScreen({ go, head, card, id }) {
  let tab = 'overview';
  return liveView(() => get(`/pf/spaces/${id}`), (d, refresh) => {
    const can = d.can_write;
    const mine = (t) => ['owner', 'accountant'].includes(d.role) || t.author_id === d.me;
    const active = d.accounts.filter((a) => !a.archived_at);
    const accOpts = active.map((a) => [a.id, a.name]);
    const run = (fn, okMsg) => action(fn, { ok: okMsg, refresh });
    const askTx = async (kind, t) => {
      if (!accOpts.length) { toast('Créez d\'abord un compte pour cet espace.', 'bad'); return; }
      const opts = catOptions(d.categories, kind);
      if (t && !opts.some((o) => o[0] === t.category)) opts.push([t.category, catName(d.categories, t.category)]);
      const v = await ask({ title: t ? 'Modifier l\'opération' : kind === 'income' ? 'Nouveau revenu' : 'Nouvelle dépense', submit: 'Enregistrer', fields: [
        { name: 'account_id', label: 'Compte', type: 'select', options: accOpts, value: t?.account_id || accOpts[0][0] },
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: t ? t.amount : '' },
        { name: 'category', label: 'Catégorie', type: 'select', options: opts, value: t?.category || opts[0]?.[0] },
        { name: 'occurred_on', label: 'Date', type: 'date', value: t?.occurred_on || today() },
        { name: 'note', label: 'Note (facultatif)', required: false, maxlength: 200, value: t?.note || '' }] });
      if (!v) return;
      const body = { account_id: v.account_id, amount: Math.round(Number(v.amount)), category: v.category, occurred_on: v.occurred_on, note: v.note || undefined };
      if (t) await post(`/pf/spaces/${id}/transactions/${t.id}`, body); else await post(`/pf/spaces/${id}/transactions`, { ...body, kind });
    };
    const askAccount = async (a) => {
      const v = await ask({ title: a ? 'Modifier le compte' : 'Nouveau compte', submit: 'Enregistrer', fields: [
        { name: 'name', label: 'Nom', maxlength: 40, value: a?.name || '' },
        { name: 'kind', label: 'Type', type: 'select', options: Object.entries(KIND), value: a?.kind || 'cash' },
        { name: 'color', label: 'Couleur', type: 'select', options: Object.entries(COLORS), value: a?.color || 'teal' },
        { name: 'opening_balance', label: 'Solde de départ (GNF)', type: 'number', inputmode: 'numeric', required: false, value: a ? a.opening_balance : 0 }] });
      if (!v) return;
      await post(`/pf/spaces/${id}/accounts`, { id: a?.id, name: v.name, kind: v.kind, color: v.color, opening_balance: Math.round(Number(v.opening_balance || 0)) });
    };
    const askTransfer = async () => {
      if (active.length < 2) { toast('Il faut deux comptes pour un virement.', 'bad'); return; }
      const v = await ask({ title: 'Virement entre comptes', submit: 'Virer', fields: [
        { name: 'from', label: 'De', type: 'select', options: accOpts, value: accOpts[0][0] }, { name: 'to', label: 'Vers', type: 'select', options: accOpts, value: accOpts[1][0] },
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' }, { name: 'occurred_on', label: 'Date', type: 'date', value: today() }] });
      if (!v) return;
      await post(`/pf/spaces/${id}/transfers`, { from: v.from, to: v.to, amount: Math.round(Number(v.amount)), occurred_on: v.occurred_on });
    };
    const askInvite = async () => {
      const v = await ask({ title: 'Inviter quelqu\'un', text: 'La personne doit déjà avoir un compte Wallindirain. Elle reçoit une invitation à accepter.', submit: 'Inviter', fields: [
        { name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'tel' },
        { name: 'role', label: 'Rôle', type: 'select', options: Object.keys(ROLE_HELP).map((r) => [r, `${ROLE[r]} · ${ROLE_HELP[r]}`]), value: 'contributor' }] });
      if (!v) return;
      await post(`/pf/spaces/${id}/invite`, { phone: v.phone, role: v.role });
    };
    const openTx = (t) => async () => {
      if (t.kind.startsWith('transfer')) { if (can && mine(t) && await confirmBox('Supprimer ce virement ?', 'Les deux comptes sont rétablis.', 'Supprimer', true)) await run(() => post(`/pf/spaces/${id}/transactions/${t.id}/void`), 'Virement supprimé')(); return; }
      if (!can || !mine(t)) { toast(can ? 'Seul son auteur, le comptable ou le propriétaire peut la modifier.' : 'Espace en lecture seule.', 'bad'); return; }
      const v = await ask({ title: catName(d.categories, t.category), text: `${fmtGNF(t.amount)} · ${t.account_name} · ${t.author_name}`, submit: 'Modifier', cancel: 'Fermer', fields: [] });
      if (v) await run(() => askTx(t.kind, t), 'Opération modifiée')();
      else if (await confirmBox('Supprimer cette opération ?', 'Elle ne compte plus dans les soldes ; le journal en garde la trace.', 'Supprimer', true)) await run(() => post(`/pf/spaces/${id}/transactions/${t.id}/void`), 'Opération supprimée')();
    };
    const txRow = (t) => h('button', { class: 'pf-row', type: 'button', onclick: openTx(t) },
      h('span', { class: `pf-ico pf-c-${t.kind === 'income' ? 'green' : t.kind === 'expense' ? 'orange' : 'blue'}` }, icon(t.kind === 'income' ? 'plus' : t.kind === 'expense' ? 'arrowUpRight' : 'arrowRight', 22)),
      h('span', { class: 'pf-row-main' }, h('b', {}, t.kind.startsWith('transfer') ? 'Virement' : catName(d.categories, t.category)),
        h('span', { class: `pf-amt ${t.kind === 'income' || t.kind === 'transfer_in' ? 'pos' : t.kind === 'expense' ? 'neg' : ''}` }, `${t.kind === 'expense' || t.kind === 'transfer_out' ? '−' : '+'}${fmtGNF(t.amount)}`),
        h('small', {}, `${t.account_name} · ${dayLabel(t.occurred_on)} · ${t.author_name}${t.note ? ` · ${t.note}` : ''}`)));

    const flow = (label, value, total, tone) => {
      const fill = h('span', { class: `pf-bar-fill ${tone}` }); fill.style.width = `${total > 0 ? Math.round((value * 100) / total) : 0}%`;
      return h('div', { class: 'pf-flow' }, h('div', { class: 'pf-flow-row' }, h('b', {}, label), h('span', {}, fmtGNF(value))), h('span', { class: 'pf-bar-track' }, fill));
    };
    const views = {
      overview: () => [
        card('Solde de l\'espace', h('div', { class: 'pf-big' }, fmtGNF(d.balance)), h('small', { class: 'pf-note' }, `${d.days} derniers jours : +${fmtGNF(d.income)} · −${fmtGNF(d.expense)}`)),
        d.expense_by_category.length > 0 && card('Dépenses par catégorie', d.expense_by_category.slice(0, 6).map((c) => flow(catName(d.categories, c.category), c.total, d.expense, 'neg'))),
        card('Dernières opérations', d.recent.length ? d.recent.slice(0, 8).map(txRow) : h('p', { class: 'pf-note' }, 'Aucune opération.'))],
      tx: () => [d.recent.length ? h('section', { class: 'pf-card flush' }, d.recent.map(txRow)) : empty('receipt', 'Aucune opération pour le moment.')],
      accounts: () => [d.accounts.length ? h('section', { class: 'pf-card flush' }, d.accounts.map((a) => h('div', { class: 'pf-acc' },
        h('button', { class: `pf-row${a.archived_at ? ' dim' : ''}`, type: 'button', onclick: can && ['owner', 'accountant'].includes(d.role) ? run(() => askAccount(a), 'Compte modifié') : null },
          h('span', { class: `pf-ico pf-c-${a.color}` }, icon('bank', 24)), h('span', { class: 'pf-row-main' }, h('b', {}, a.name), h('span', { class: 'pf-amt' }, fmtGNF(a.balance)), h('small', {}, a.archived_at ? 'Archivé' : KIND[a.kind]))),
        can && ['owner', 'accountant'].includes(d.role) && h('button', { class: 'pf-mini', type: 'button', onclick: run(() => post(`/pf/spaces/${id}/accounts/${a.id}/archive`, { archived: !a.archived_at }), a.archived_at ? 'Compte rétabli' : 'Compte archivé') }, a.archived_at ? 'Rétablir' : 'Archiver')))) : empty('bank', 'Aucun compte dans cet espace.'),
        can && ['owner', 'accountant'].includes(d.role) && h('button', { class: 'btn block', type: 'button', onclick: run(() => askAccount(), 'Compte créé') }, 'Ajouter un compte')],
      members: () => [h('section', { class: 'pf-card flush' }, d.members.map((m) => h('div', { class: 'pf-acc' },
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-ico pf-c-purple' }, icon('user', 22)), h('span', { class: 'pf-row-main' }, h('b', {}, m.name), h('small', {}, `${ROLE[m.role]}${m.status === 'invited' ? ' · invitation envoyée' : ''}${m.phone ? ` · ${m.phone}` : ''}`))),
        d.role === 'owner' && m.role !== 'owner' && h('div', { class: 'pf-actions' },
          m.status === 'active' && h('button', { class: 'pf-mini', type: 'button', onclick: action(async () => { const v = await ask({ title: `Rôle de ${m.name}`, submit: 'Enregistrer', fields: [{ name: 'role', label: 'Rôle', type: 'select', options: Object.keys(ROLE_HELP).map((r) => [r, `${ROLE[r]} · ${ROLE_HELP[r]}`]), value: m.role }] }); if (v) await post(`/pf/spaces/${id}/members/${m.user_id}/role`, { role: v.role }); }, { ok: 'Rôle modifié', refresh }) }, 'Rôle'),
          h('button', { class: 'pf-mini', type: 'button', onclick: action(async () => { if (await confirmBox(`Retirer ${m.name} ?`, 'Ses opérations restent dans l\'espace.', 'Retirer', true)) await post(`/pf/spaces/${id}/members/${m.user_id}/remove`); }, { ok: 'Membre retiré', refresh }) }, 'Retirer'))))),
        can && d.role === 'owner' && h('button', { class: 'btn block', type: 'button', onclick: run(askInvite, 'Invitation envoyée') }, 'Inviter quelqu\'un'),
        d.role !== 'owner' && h('button', { class: 'btn block', type: 'button', onclick: action(async () => { if (await confirmBox('Quitter cet espace ?', 'Vous ne verrez plus ses données.', 'Quitter', true)) { await post(`/pf/spaces/${id}/leave`); go('spaces'); } }, { ok: '' }) }, 'Quitter l\'espace'),
        d.role === 'owner' && h('button', { class: 'btn block', type: 'button', onclick: action(async () => { const v = await ask({ title: 'Renommer', submit: 'Enregistrer', fields: [{ name: 'name', label: 'Nom', maxlength: 60, value: d.space.name }] }); if (v) await post(`/pf/spaces/${id}/rename`, { name: v.name }); }, { ok: 'Espace renommé', refresh }) }, 'Renommer l\'espace'),
        d.role === 'owner' && h('button', { class: 'btn block', type: 'button', onclick: action(async () => { if (await confirmBox(d.space.archived ? 'Rétablir l\'espace ?' : 'Archiver l\'espace ?', d.space.archived ? '' : 'Il passe en lecture seule pour tout le monde. Rien n\'est supprimé.', d.space.archived ? 'Rétablir' : 'Archiver', !d.space.archived)) await post(`/pf/spaces/${id}/archive`, { archived: !d.space.archived }); }, { ok: 'Espace mis à jour', refresh }) }, d.space.archived ? 'Rétablir l\'espace' : 'Archiver l\'espace')],
      log: () => [d.log.length ? h('section', { class: 'pf-card flush' }, d.log.map((l) => h('div', { class: 'pf-row' }, h('span', { class: 'pf-row-main' }, h('b', {}, ACTION[l.action] || l.action), h('small', {}, `${l.actor_name || '—'} · ${new Date(String(l.created_at).replace(' ', 'T')).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${l.detail ? ` · ${l.detail}` : ''}`))))) : empty('receipt', 'Rien à afficher.')]
    };
    const tabs = [['overview', 'Aperçu'], ['tx', 'Opérations'], ['accounts', 'Comptes'], ['members', 'Membres'], ...(['owner', 'accountant'].includes(d.role) ? [['log', 'Activité']] : [])];
    const body = h('div', { class: 'pf-pad' });
    const paint = () => { body.replaceChildren(...views[tab]().filter(Boolean)); tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === tab))); };
    const tabsEl = h('div', { class: 'wallet-tabs', role: 'group' }, tabs.map(([k, l]) => h('button', { type: 'button', 'data-k': k, 'aria-pressed': String(k === tab), onclick: () => { tab = k; paint(); } }, l)));
    const add = can && h('div', { class: 'pf-split' }, h('button', { class: 'btn primary', type: 'button', onclick: run(() => askTx('expense'), 'Dépense ajoutée') }, 'Dépense'), h('button', { class: 'btn', type: 'button', onclick: run(() => askTx('income'), 'Revenu ajouté') }, 'Revenu'), h('button', { class: 'btn', type: 'button', onclick: run(askTransfer, 'Virement fait') }, 'Virement'));
    paint();
    return h('div', {}, head(d.space.name, { back: ['Espaces', () => go('spaces')] }), h('div', { class: 'pf-pad' }, h('div', { class: 'pf-badges' }, badge(ROLE[d.role], 'blue'), d.space.archived && badge('Archivé', 'grey'), !d.space.archived && !d.writable && badge('Lecture seule : formule Pro du propriétaire terminée', 'orange'), h('small', { class: 'pf-note' }, `Propriétaire : ${d.space.owner_name}`)), add, tabsEl), body);
  });
}
