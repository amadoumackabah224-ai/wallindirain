// Espace administrateur : tout est visible, chaque action sensible est tracée dans le journal.
import { h, ask, telLink, fmtGNF, fmtDate, fmtPhone, liveView, statusBadge, amount, action, kv, empty, toast, badge, table, confirmBox, proofButton, ROLE_LABEL, ORDER_STATUS, CAUSE_LABEL, FAIL_LABEL, WALLET_KIND } from '../ui.js';
import { get, post } from '../api.js';

const kpi = (label, value, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label));

export function adminDashboard({ goTo }) {
  return liveView(() => get('/admin/dashboard'), (d) => h('div', {}, h('h1', {}, 'Tableau de bord'),
    d.ledger_problems > 0 && h('div', { class: 'notice bad' }, `⚠ ${d.ledger_problems} incohérence(s) comptable(s) détectée(s). Contactez le développeur.`),
    h('div', { class: 'grid g3 mb' },
      kpi('Livraisons aujourd\'hui', d.delivered_today, 'good'), kpi('Ventes livrées aujourd\'hui', fmtGNF(d.sales_today)), kpi('Résultat Wallindirain (cumulé)', fmtGNF(d.platform_result), 'good'),
      kpi('Stock prépayé détenu pour les vendeurs', fmtGNF(d.prepaid_float)), kpi('Argent à récupérer chez les livreurs', fmtGNF(d.cash_outstanding), d.cash_outstanding > 0 ? 'alert' : '')),
    d.legal_missing?.length > 0 && h('div', { class: 'notice warn' }, `Informations légales à compléter dans les variables Render avant la mise en service : ${d.legal_missing.join(' ; ')}.`),
    h('h2', {}, 'À traiter'),
    h('div', { class: 'grid g3 mb' },
      h('div', { onclick: () => goTo('users') }, kpi('Fournisseurs à valider', d.suppliers_pending, d.suppliers_pending ? 'alert' : '')),
      h('div', { onclick: () => goTo('products') }, kpi('Produits à valider', d.products_pending, d.products_pending ? 'alert' : '')),
      h('div', { onclick: () => goTo('withdrawals') }, kpi('Retraits à payer', d.withdrawals_pending, d.withdrawals_pending ? 'alert' : '')),
      h('div', { onclick: () => goTo('remit') }, kpi('Reversements livreurs à valider', d.remittances_pending, d.remittances_pending ? 'alert' : '')),
      h('div', { onclick: () => goTo('support') }, kpi('Messages non lus', d.support_unread, d.support_unread ? 'alert' : '')),
      h('div', { onclick: () => goTo('data') }, kpi('Demandes sur les données', d.data_requests_open, d.data_requests_open ? 'alert' : '')),
      kpi('Arrivages à compter (magasin)', d.arrivals_pending)),
    h('div', { class: 'card' }, h('h2', {}, 'Commandes par statut'), h('div', { class: 'gap' }, d.by_status.map((s) => h('span', { class: 'badge ' + (ORDER_STATUS[s.status]?.[1] || '') }, `${ORDER_STATUS[s.status]?.[0] || s.status} : ${s.n}`))))), { poll: 20000 });
}

export function adminUsers() {
  let role = '';
  const host = h('div');
  const load = () => host.replaceChildren(liveView(() => get(`/admin/users${role ? `?role=${role}` : ''}`), ({ users }, refresh) => {
    const create = action(async () => {
      const v = await ask({ title: 'Créer un compte du personnel', submit: 'Créer', fields: [
        { name: 'role', label: 'Rôle', type: 'select', options: [['agent', 'Agent call center'], ['call_chief', 'Chef call center'], ['courier', 'Livreur'], ['warehouse', 'Magasinier'], ['admin', 'Administrateur']] },
        { name: 'name', label: 'Nom complet' }, { name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'numeric' },
        { name: 'team', label: 'Call center (agents et chefs)', required: false, placeholder: 'Ex. Alpha' }, { name: 'password', label: 'Mot de passe provisoire', type: 'text', hint: '8 caractères minimum, lettres et chiffres. Communiquez-le à la personne.' }] });
      if (v) await post('/admin/users', v);
    }, { ok: 'Compte créé', refresh });
    return h('div', {}, h('div', { class: 'gap mb' }, h('select', { class: 'grow', 'aria-label': 'Filtrer par rôle', onchange: (e) => { role = e.target.value; load(); } }, h('option', { value: '' }, 'Tous les rôles'), Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k, selected: k === role }, l))), h('button', { class: 'btn btn-gold', onclick: create }, '+ Créer un compte')),
      h('div', { class: 'card' }, table(['Nom', 'Rôle', 'Téléphone', 'Versement', 'Statut', 'Identité', 'Solde', ''], users.map((u) => {
        const edit = action(async () => {
          const v = await ask({ title: `Modifier ${u.full_name}`, text: 'Le numéro de versement est celui où part l\'argent de ses retraits : modifiez-le seulement après avoir vérifié la demande de la personne.', submit: 'Enregistrer', fields: [
            { name: 'name', label: 'Nom complet', value: u.full_name },
            ...(['agent', 'call_chief'].includes(u.role) ? [{ name: 'team', label: 'Call center', value: u.team || '' }] : []),
            { name: 'payout_method', label: 'Opérateur de versement', type: 'select', value: u.payout_method || 'orange_money', options: [['orange_money', 'Orange Money'], ['mtn_momo', 'MTN MoMo']] },
            { name: 'payout_phone', label: 'Numéro de versement', type: 'tel', inputmode: 'numeric', required: false, value: u.payout_phone || '', hint: 'Laissez vide pour ne pas définir de numéro.' }] });
          if (v) await post(`/admin/users/${u.id}/update`, { name: v.name, team: v.team, payout_method: v.payout_method, payout_phone: v.payout_phone });
        }, { ok: 'Compte modifié', refresh });
        const resetPw = action(async () => {
          if (!(await confirmBox('Nouveau mot de passe ?', `Un mot de passe temporaire sera créé pour ${u.full_name} et ses connexions en cours seront coupées. Vous le transmettrez vous-même à la personne.`, 'Créer le mot de passe'))) return;
          const r = await post(`/admin/users/${u.id}/reset-password`);
          await ask({ title: 'Mot de passe temporaire', text: `${u.full_name} : ${r.temporary_password}. Il ne sera plus affiché : notez-le et transmettez-le maintenant. La personne pourra le changer via « Mot de passe oublié ».`, submit: 'C\'est noté', fields: [] });
        }, { refresh });
        const anonymize = action(async () => {
          if (!(await confirmBox('Anonymiser ce compte ?', `${u.full_name} ne pourra plus se connecter : nom, téléphone, pièce d'identité, numéro de versement et photo sont effacés. Les écritures d'argent restent, sans nom. Impossible si le portefeuille n'est pas à zéro ou si des opérations sont en cours. IRRÉVERSIBLE.`, 'Anonymiser', true))) return;
          await post(`/admin/users/${u.id}/anonymize`);
        }, { ok: 'Compte anonymisé', refresh });
        const unlock = action(async () => { await post(`/admin/users/${u.id}/unlock`); }, { ok: 'Compte déverrouillé', refresh });
        const setStatus = (s, msg) => action(async () => { await post(`/admin/users/${u.id}/status`, { status: s }); }, { ok: msg, refresh });
        const verify = action(async () => {
          if (u.identity_verified) { await post(`/admin/users/${u.id}/verify`, { verified: false }); return; }
          if (await confirmBox('Vérifier l\'identité ?', `Pièce déclarée : « ${u.identity_doc || 'aucune'} ». Confirmez uniquement après avoir contrôlé le document.`, 'Identité vérifiée')) await post(`/admin/users/${u.id}/verify`, { verified: true });
        }, { ok: 'Identité mise à jour', refresh });
        return [h('div', {}, h('b', {}, u.full_name), u.team && h('div', { class: 'small muted' }, u.team)), ROLE_LABEL[u.role], fmtPhone(u.phone),
          u.payout_phone ? h('div', { class: 'small' }, u.payout_method === 'orange_money' ? 'Orange Money' : 'MTN MoMo', h('div', { class: 'muted' }, fmtPhone(u.payout_phone))) : h('span', { class: 'small muted' }, 'non défini'),
          badge({ active: 'Actif', pending: 'À valider', suspended: 'Suspendu' }[u.status], { active: 'ok', pending: 'warn', suspended: 'bad' }[u.status]),
          u.identity_doc ? h('div', {}, u.identity_verified ? badge('Vérifiée', 'ok') : badge('À vérifier', 'warn'), h('div', { class: 'small muted' }, u.identity_doc)) : '—',
          u.balance != null ? amount(u.balance) : '', h('div', { class: 'gap' }, u.identity_doc && h('button', { class: 'btn btn-sm btn-ghost', onclick: verify }, u.identity_verified ? 'Retirer' : 'Vérifier ID'),
            u.status !== 'active' ? h('button', { class: 'btn btn-sm btn-ok', onclick: setStatus('active', 'Compte activé') }, 'Activer') : h('button', { class: 'btn btn-sm btn-ghost', onclick: setStatus('suspended', 'Compte suspendu') }, 'Suspendre'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: edit }, 'Modifier'), h('button', { class: 'btn btn-sm btn-ghost', onclick: resetPw }, 'Mot de passe'), h('button', { class: 'btn btn-sm btn-ghost', onclick: unlock }, 'Débloquer'), u.role !== 'admin' && h('button', { class: 'btn btn-sm btn-ghost', onclick: anonymize }, 'Anonymiser'))];
      }), { empty: empty('👥', 'Aucun utilisateur') })));
  }));
  load();
  return h('div', {}, h('h1', {}, 'Utilisateurs'), host);
}

export function adminProducts() {
  return liveView(() => get('/admin/products'), ({ products }, refresh) => h('div', {}, h('h1', {}, 'Produits'),
    h('div', { class: 'card' }, table(['Produit', 'Fournisseur', 'Prix fournisseur', 'Marge', 'Stockage', 'Stock', 'Statut', ''], products.map((p) => {
      const review = (approve) => action(async () => {
        if (approve) {
          const v = await ask({ title: `Valider « ${p.name} »`, text: 'Marge Wallindirain en points de base (1500 = 15 %). Laissez vide pour la marge par défaut.', submit: 'Valider le produit', fields: [{ name: 'bps', label: 'Marge (points de base)', type: 'number', required: false, placeholder: '1500' }] });
          if (v) await post(`/admin/products/${p.id}/review`, { approve: true, margin_bps: v.bps === '' ? undefined : Number(v.bps) });
        } else if (await confirmBox('Refuser ce produit ?', p.name, 'Refuser', true)) await post(`/admin/products/${p.id}/review`, { approve: false });
      }, { ok: approve ? 'Produit validé' : 'Produit refusé', refresh });
      const margin = action(async () => { const v = await ask({ title: `Marge : ${p.name}`, submit: 'Changer', fields: [{ name: 'bps', label: 'Marge (points de base)', type: 'number' }] }); if (v) await post(`/admin/products/${p.id}/margin`, { margin_bps: Number(v.bps) }); }, { ok: 'Marge modifiée', refresh });
      return [h('b', {}, p.name), p.supplier_name, amount(p.supplier_price), p.margin_unit != null ? amount(p.margin_unit) : '—', p.storage === 'wallindirain' ? 'Wallindirain' : 'Fournisseur', `${p.stock_qty} (${p.reserved_qty} rés.)`,
        badge({ pending: 'À valider', approved: 'Validé', rejected: 'Refusé', archived: 'Archivé' }[p.status], { pending: 'warn', approved: 'ok', rejected: 'bad', archived: 'grey' }[p.status]),
        h('div', { class: 'gap' }, p.status === 'pending' && [h('button', { class: 'btn btn-sm btn-ok', onclick: review(true) }, 'Valider'), h('button', { class: 'btn btn-sm btn-ghost', onclick: review(false) }, 'Refuser')], p.status === 'approved' && h('button', { class: 'btn btn-sm btn-ghost', onclick: margin }, 'Marge'))];
    }), { empty: empty('🛍️', 'Aucun produit') }))));
}

export function adminOrders() {
  let status = '', search = '';
  const host = h('div');
  const load = () => host.replaceChildren(liveView(() => get(`/admin/orders?${new URLSearchParams({ ...(status && { status }), ...(search && { search }) })}`), ({ orders }, refresh) => h('div', { class: 'card' }, table(
    ['Référence', 'Statut', 'Produit', 'Client', 'Vendeur', 'Fournisseur', 'Livreur', 'Total', ''], orders.map((o) => [h('b', {}, o.ref), statusBadge(o.status), `${o.product_name} × ${o.qty}`, `${o.customer_name} · ${fmtPhone(o.customer_phone)}`,
      o.seller_name, o.supplier_name || '—', o.courier_name || '—', amount(o.sale_total),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => detail(o.id, refresh) }, 'Détail')]), { empty: empty('📋', 'Aucune commande') })), { poll: 30000 }));
  async function detail(id, refresh) {
    const d = await get(`/admin/orders/${id}`).catch((e) => { toast(e.message, 'bad'); return null; }); if (!d) return;
    const o = d.order;
    const cancel = action(async () => { const v = await ask({ title: `Annuler ${o.ref}`, submit: 'Annuler', danger: true, fields: [{ name: 'reason', label: 'Motif' }] }); if (v) { await post(`/admin/orders/${id}/cancel`, { reason: v.reason }); overlay.remove(); } }, { ok: 'Commande annulée', refresh });
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } }, h('div', { class: 'modal' }, h('h2', {}, `${o.ref} `, statusBadge(o.status)),
      kv([['Produit', `${o.product_name} × ${o.qty}`], ['Formule', o.formula], ['Client', `${o.customer_name} · ${fmtPhone(o.customer_phone)}`], ['Adresse', `${o.commune}, ${o.address}`], ['Vendeur', o.seller_name], ['Fournisseur', o.supplier_name || '—'], ['Livreur', o.courier_name || '—'],
        ['Paiement du client', d.payment ? h('span', {}, { cash: 'Espèces', orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' }[d.payment.method], d.payment.reference && ` · ${d.payment.reference} `, proofButton(d.payment.proof_id, 'Capture')) : 'Non déclaré'], ['Total client', amount(o.sale_total)], ['Prix fournisseur', amount(o.supplier_unit_price * o.qty)], ['Marge', amount(o.margin_unit * o.qty)], ['Livraison', amount(o.delivery_fee)], ['Call center', amount(o.call_fee)], o.return_cause && ['Cause du retour', CAUSE_LABEL[o.return_cause]]]),
      h('h3', { class: 'mt' }, 'Appels'), d.calls.length ? d.calls.map((c) => h('div', { class: 'small' }, `${fmtDate(c.at)} · ${c.agent_name} (${c.call_center}) : ${c.result}${c.note ? ` · ${c.note}` : ''}`)) : h('p', { class: 'muted small' }, 'Aucun'),
      h('h3', { class: 'mt' }, 'Suivi'), h('ul', { class: 'timeline' }, d.history.map((x) => h('li', {}, statusBadge(x.to_status), h('span', { class: 'small muted' }, ` ${fmtDate(x.at)} · ${x.actor || 'système'}${x.note ? ` · ${x.note}` : ''}`)))),
      d.money.length > 0 && [h('h3', { class: 'mt' }, 'Mouvements d\'argent'), table(['Compte', 'Opération', 'Montant'], d.money.map((m) => [m.full_name, WALLET_KIND[m.kind] || m.kind, amount(m.amount, true)]))],
      h('div', { class: 'gap mt' }, ['new', 'in_call', 'confirmed', 'assigned', 'failed'].includes(o.status) && h('button', { class: 'btn btn-bad', onclick: cancel }, 'Annuler la commande'), h('button', { class: 'btn btn-ghost grow', onclick: () => overlay.remove() }, 'Fermer'))));
    document.body.append(overlay);
  }
  const sel = h('select', { 'aria-label': 'Filtrer par statut', onchange: (e) => { status = e.target.value; load(); } }, h('option', { value: '' }, 'Tous les statuts'), Object.entries(ORDER_STATUS).map(([k, [l]]) => h('option', { value: k }, l)));
  const q = h('input', { type: 'search', placeholder: 'Référence WLD ou téléphone client', onchange: (e) => { search = e.target.value.trim(); load(); } });
  load();
  return h('div', {}, h('h1', {}, 'Commandes'), h('div', { class: 'gap mb' }, sel, q), host);
}

export function adminCash() {
  return liveView(() => get('/admin/cash'), ({ couriers, counts }, refresh) => h('div', {}, h('h1', {}, 'Caisses des livreurs'),
    h('div', { class: 'notice' }, 'Comptez l\'argent remis par chaque livreur. Tout manque est enregistré et débité automatiquement au livreur.'),
    h('div', { class: 'card' }, table(['Livreur', 'Commandes livrées', 'Espèces attendues', 'Reversé par transfert (à valider)', ''], couriers.map((c) => {
      const count = action(async () => {
        const v = await ask({ title: `Caisse de ${c.full_name}`, text: `Montant attendu : ${fmtGNF(c.expected)}. Comptez les billets remis.`, submit: 'Valider le comptage', fields: [{ name: 'counted', label: 'Montant réellement remis (GNF)', type: 'number', inputmode: 'numeric' }] });
        if (!v) return;
        const r = await post(`/admin/cash/${c.id}`, { counted: Number(v.counted) });
        toast(r.shortage > 0 ? `Manque de ${fmtGNF(r.shortage)} débité au livreur` : r.surplus > 0 ? `Excédent de ${fmtGNF(r.surplus)} constaté` : 'Caisse exacte', r.shortage > 0 ? 'bad' : 'ok');
      }, { refresh });
      return [h('b', {}, c.full_name), c.orders, amount(c.expected), c.in_remittance > 0 ? h('span', {}, amount(c.in_remittance), ' ', badge('onglet Reversements', 'warn')) : '—', c.orders > 0 && h('button', { class: 'btn btn-sm btn-gold', onclick: count }, 'Compter')];
    }), { empty: empty('🏍️', 'Aucun livreur') })),
    h('div', { class: 'card' }, h('h2', {}, 'Historique des comptages'), table(['Date', 'Livreur', 'Attendu', 'Compté', 'Manque', 'Excédent', 'Par'], counts.map((c) => [fmtDate(c.at), c.courier, amount(c.expected), amount(c.counted), c.shortage ? h('span', { class: 'amount neg' }, fmtGNF(c.shortage)) : '—', c.surplus ? fmtGNF(c.surplus) : '—', c.admin]), { empty: empty('🧾', 'Aucun comptage') }))));
}

export function adminWithdrawals() {
  return liveView(() => get('/admin/withdrawals'), ({ withdrawals }, refresh) => h('div', {}, h('h1', {}, 'Retraits'),
    h('div', { class: 'notice' }, 'Procédure : 1) vérifiez la demande, 2) envoyez l\'argent à la main par Orange Money ou MTN MoMo au numéro enregistré, 3) cliquez « Payer », saisissez la référence et joignez la capture d\'écran. Le montant est débité du portefeuille à ce moment-là. Une demande refusée ne coûte rien à la personne.'),
    h('div', { class: 'card' }, table(['Date', 'Bénéficiaire', 'Montant', 'Envoyer à', 'Statut', ''], withdrawals.map((w) => {
      const pay = action(async () => {
        const v = await ask({ title: `Payer ${fmtGNF(w.amount)}`, text: `${w.full_name} · ${w.method === 'orange_money' ? 'Orange Money' : 'MTN MoMo'} ${fmtPhone(w.account_number)}. Envoyez l'argent, puis notez la référence et joignez la capture d'écran du transfert : la personne la verra dans son portefeuille.`, submit: 'Confirmer le paiement', fields: [
          { name: 'ref', label: 'Référence de la transaction' }, { name: 'image', label: 'Capture d\'écran du transfert envoyé', type: 'image' }] });
        if (!v) return;
        const proof = (await post('/proofs', { kind: 'withdrawal_payment', image: v.image })).id;
        await post(`/admin/withdrawals/${w.id}/pay`, { payment_ref: v.ref, proof_id: proof });
      }, { ok: 'Retrait marqué payé', refresh });
      const reject = action(async () => { const v = await ask({ title: 'Refuser le retrait', text: 'Rien n\'a été débité : la personne garde son solde.', submit: 'Refuser', danger: true, fields: [{ name: 'reason', label: 'Motif' }] }); if (v) await post(`/admin/withdrawals/${w.id}/reject`, { reason: v.reason }); }, { ok: 'Retrait refusé et remboursé', refresh });
      return [fmtDate(w.created_at), h('div', {}, h('b', {}, w.full_name), h('div', { class: 'small muted' }, `${ROLE_LABEL[w.role]} · ${fmtPhone(w.phone)}`, !w.identity_verified && ' · ⚠ identité non vérifiée')), amount(w.amount), `${w.method === 'orange_money' ? 'Orange Money' : 'MTN MoMo'} ${fmtPhone(w.account_number)}`,
        badge({ requested: 'À valider et payer', paid: 'Payé', rejected: 'Refusé', expired: 'Expiré' }[w.status], { requested: 'warn', paid: 'ok', rejected: 'bad', expired: 'grey' }[w.status]) , w.payment_ref && h('div', { class: 'small muted' }, w.payment_ref), proofButton(w.proof_id, 'Capture'),
        w.status === 'requested' && h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-ok', onclick: pay }, 'Payer'), h('button', { class: 'btn btn-sm btn-ghost', onclick: reject }, 'Refuser'))];
    }).map((r) => [r[0], r[1], r[2], r[3], h('div', {}, r[4], r[5], r[6]), r[7]]), { empty: empty('💸', 'Aucune demande de retrait') }))), { poll: 20000 });
}

export function adminDeposit() {
  return liveView(() => get('/admin/users'), ({ users }, refresh) => {
    const eligible = users.filter((u) => ['seller', 'supplier'].includes(u.role) && u.status === 'active');
    const deposit = action(async () => {
      const v = await ask({ title: 'Enregistrer un dépôt', text: 'À faire seulement après avoir reçu l\'argent (Orange Money, MTN MoMo ou espèces). Le portefeuille est crédité tout de suite.', submit: 'Créditer le portefeuille', fields: [
        { name: 'user_id', label: 'Compte', type: 'select', options: eligible.map((u) => [u.id, `${u.full_name} (${ROLE_LABEL[u.role]})`]) },
        { name: 'amount', label: 'Montant reçu (GNF)', type: 'number', inputmode: 'numeric' }, { name: 'reference', label: 'Référence du paiement reçu' }] });
      if (v) await post('/admin/deposits', { user_id: v.user_id, amount: Number(v.amount), reference: v.reference });
    }, { ok: 'Dépôt enregistré', refresh });
    return h('div', {}, h('h1', {}, 'Dépôts'), h('div', { class: 'card' }, h('p', {}, 'Un vendeur qui veut acheter du stock à l\'avance dépose d\'abord de l\'argent chez Wallindirain. Créditez ici son portefeuille après réception.'), h('button', { class: 'btn btn-gold', disabled: !eligible.length, onclick: deposit }, '+ Enregistrer un dépôt')));
  });
}

export function adminSettings() {
  return h('div', {}, adminSettingsMain(), adminSubscriptions());
}

function adminSettingsMain() {
  return liveView(() => get('/admin/settings'), ({ settings, rates }, refresh) => h('div', {}, h('h1', {}, 'Réglages'),
    h('div', { class: 'notice warn' }, 'Un changement de tarif ne modifie jamais les commandes déjà créées : les prix sont figés à la création.'),
    h('div', { class: 'card' }, h('h2', {}, 'Paramètres'), table(['Paramètre', 'Valeur', ''], settings.map((s) => [s.label, h('b', {}, s.value.toLocaleString('fr-FR')), h('button', { class: 'btn btn-sm btn-ghost', onclick: action(async () => { const v = await ask({ title: s.label, submit: 'Enregistrer', fields: [{ name: 'value', label: 'Nouvelle valeur', type: 'number', value: s.value }] }); if (v) await post('/admin/settings', { key: s.key, value: Number(v.value) }); }, { ok: 'Réglage enregistré', refresh }) }, 'Modifier')]))),
    h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Zones et tarifs de livraison (quartier ou ville)'), h('button', { class: 'btn btn-sm btn-gold', onclick: action(async () => { const v = await ask({ title: 'Nouvelle zone', submit: 'Ajouter', fields: [{ name: 'commune', label: 'Quartier ou ville' }, { name: 'fee', label: 'Tarif (GNF)', type: 'number' }] }); if (v) await post('/admin/rates', { commune: v.commune, fee: Number(v.fee) }); }, { ok: 'Zone ajoutée', refresh }) }, '+ Zone')),
      table(['Quartier ou ville', 'Tarif', 'État', ''], rates.map((r) => [r.commune, amount(r.fee), badge(r.active ? 'Active' : 'Désactivée', r.active ? 'ok' : 'grey'), h('button', { class: 'btn btn-sm btn-ghost', onclick: action(async () => { const v = await ask({ title: `Livraison ${r.commune}`, submit: 'Enregistrer', fields: [{ name: 'fee', label: 'Tarif (GNF)', type: 'number', value: r.fee }, { name: 'active', label: 'Zone active (proposée aux clients et vendeurs)', type: 'checkbox', value: r.active }] }); if (v) await post('/admin/rates', { commune: r.commune, fee: Number(v.fee), active: v.active }); }, { ok: 'Zone enregistrée', refresh }) }, 'Modifier')])))));
}

export function adminAudit() {
  let tab = 'audit';
  const host = h('div');
  const chips = h('div', { class: 'chips' }, [['audit', 'Journal des actions'], ['messages', 'Messages envoyés']].map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': String(k === tab), onclick: (e) => { tab = k; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); load(); } }, l)));
  const load = () => host.replaceChildren(tab === 'audit'
    ? liveView(() => get('/admin/audit?limit=100'), ({ entries }) => h('div', { class: 'card' }, table(['Date', 'Qui', 'Action', 'Détails'], entries.map((e) => [fmtDate(e.at), e.actor || 'système', h('code', {}, e.action), h('span', { class: 'small muted' }, JSON.stringify(e.details))]), { empty: empty('📜', 'Journal vide') })))
    : liveView(() => get('/admin/messages?limit=100'), ({ messages, test_codes_visible }) => h('div', { class: 'card' }, test_codes_visible
      ? h('div', { class: 'notice warn' }, 'MODE TEST : aucun message n\'est réellement envoyé, les codes (livraison, retrait, mot de passe) sont donc visibles ici pour pouvoir tester. À désactiver avant la mise en service réelle.')
      : h('div', { class: 'notice' }, 'Les codes de confirmation sont masqués : personne, pas même l\'administrateur, ne peut les lire.'),
      table(['Date', 'Destinataire', 'Type', 'Message', 'Statut'], messages.map((m) => [fmtDate(m.created_at), fmtPhone(m.to_phone), m.template, h('span', { class: 'small' }, m.body), badge({ queued: 'En file', sent: 'Envoyé', simulated: 'Simulé', failed: 'Échec' }[m.status], { queued: 'warn', sent: 'ok', simulated: 'grey', failed: 'bad' }[m.status])]), { empty: empty('💬', 'Aucun message') }))));
  load();
  return h('div', {}, h('h1', {}, 'Journal'), chips, host);
}

// Reversements par transfert déclarés par les livreurs : contrôler la capture, puis confirmer le montant réellement reçu
export function adminRemittances() {
  const ST = { pending: ['À valider', 'warn'], confirmed: ['Validé', 'ok'], rejected: ['Refusé', 'bad'] };
  return liveView(() => get('/admin/remittances'), ({ remittances }, refresh) => h('div', {}, h('h1', {}, 'Reversements des livreurs'),
    h('div', { class: 'notice' }, 'Un livreur a envoyé de l\'argent par transfert : regardez la capture d\'écran, vérifiez la somme reçue sur votre téléphone, puis validez. Un manque est débité au livreur.'),
    h('div', { class: 'card' }, table(['Date', 'Livreur', 'Annoncé', 'Via', 'Statut', ''], remittances.map((r) => {
      const confirm = action(async () => {
        const v = await ask({ title: `Valider ${fmtGNF(r.amount)}`, text: `${r.courier_name} annonce ${fmtGNF(r.amount)} par ${r.method === 'orange_money' ? 'Orange Money' : 'MTN MoMo'}. Saisissez la somme réellement reçue : tout manque lui sera débité.`, submit: 'Confirmer la réception', fields: [
          { name: 'received', label: 'Montant réellement reçu (GNF)', type: 'number', inputmode: 'numeric', value: r.amount }] });
        if (!v) return;
        const res = await post(`/admin/remittances/${r.id}/confirm`, { received: Number(v.received) });
        toast(res.shortage > 0 ? `Manque de ${fmtGNF(res.shortage)} débité au livreur` : res.surplus > 0 ? `Excédent de ${fmtGNF(res.surplus)} constaté` : 'Montant exact', res.shortage > 0 ? 'bad' : 'ok');
      }, { refresh });
      const reject = action(async () => {
        const v = await ask({ title: 'Refuser le reversement', text: 'Les encaissements redeviennent « à remettre » pour ce livreur.', submit: 'Refuser', danger: true, fields: [{ name: 'reason', label: 'Motif (ex. transfert non reçu)' }] });
        if (v) await post(`/admin/remittances/${r.id}/reject`, { reason: v.reason });
      }, { ok: 'Reversement refusé', refresh });
      return [fmtDate(r.created_at), h('div', {}, h('b', {}, r.courier_name), h('div', { class: 'small muted' }, fmtPhone(r.courier_phone))), amount(r.amount),
        h('div', {}, r.method === 'orange_money' ? 'Orange Money' : 'MTN MoMo', r.reference && h('div', { class: 'small muted' }, r.reference)),
        h('div', {}, badge(...ST[r.status]), r.status === 'confirmed' && r.received !== r.amount && h('div', { class: 'small muted' }, `Reçu : ${fmtGNF(r.received)}`), r.decision_note && h('div', { class: 'small muted' }, r.decision_note)),
        h('div', { class: 'gap' }, proofButton(r.proof_id, 'Capture'), r.status === 'pending' && [h('button', { class: 'btn btn-sm btn-ok', onclick: confirm }, 'Valider'), h('button', { class: 'btn btn-sm btn-ghost', onclick: reject }, 'Refuser')])];
    }), { empty: empty('📲', 'Aucun reversement par transfert') }))), { poll: 20000 });
}

// Messagerie avec l'équipe : conversations des utilisateurs connectés et des visiteurs (mot de passe oublié, urgence)
export function adminSupport() {
  const host = h('div');
  const open = (id, back) => host.replaceChildren(liveView(() => get(`/admin/support/${id}`), ({ thread, account, messages }, refresh) => {
    const text = h('textarea', { rows: 3, maxlength: 1000, placeholder: thread.user_id ? 'Votre réponse (visible dans l\'application de la personne)…' : 'Votre réponse (envoyée par message au téléphone de la personne)…', 'aria-label': 'Votre réponse' });
    const reply = action(async () => { if (!text.value.trim()) return; await post(`/admin/support/${id}/reply`, { body: text.value }); }, { ok: 'Réponse envoyée', refresh });
    const close = action(async () => { await post(`/admin/support/${id}/close`); back(); }, { ok: 'Conversation fermée' });
    const temp = action(async () => {
      if (!(await confirmBox('Envoyer un mot de passe temporaire ?', `Un nouveau mot de passe sera créé pour ${account.full_name} (${fmtPhone(thread.phone)}), envoyé par message à ce numéro, et ses connexions en cours seront coupées. Vérifiez son identité avant (appel, informations du compte).`, 'Envoyer'))) return;
      const r = await post(`/admin/support/${id}/temp-password`);
      if (r.temporary_password) toast(`MODE TEST : mot de passe temporaire ${r.temporary_password}`, 'ok'); else toast('Mot de passe temporaire envoyé par message', 'ok');
    }, { refresh });
    return h('div', {}, h('button', { class: 'btn btn-sm btn-ghost mb', onclick: back }, '← Toutes les conversations'),
      h('div', { class: 'card' }, h('h2', {}, thread.full_name), h('p', {}, telLink(thread.phone), thread.user_id ? ' · compte connecté' : ' · visiteur sans compte', account && ` · ${ROLE_LABEL[account.role]}`),
        h('div', { class: 'chat-log tall', role: 'log' }, messages.map((m) => h('div', { class: `bubble ${m.sender === 'admin' ? 'me' : 'team'}` }, m.body, h('div', { class: 'when' }, fmtDate(m.created_at))))),
        text, h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-gold', onclick: reply }, 'Répondre'),
          account && h('button', { class: 'btn btn-ghost', onclick: temp }, 'Envoyer un mot de passe temporaire'),
          thread.status === 'open' && h('button', { class: 'btn btn-ghost', onclick: close }, 'Fermer la conversation'))));
  }));
  const list = () => host.replaceChildren(liveView(() => get('/admin/support'), ({ threads }) => h('div', { class: 'card' },
    table(['Personne', 'Dernier message', 'Statut', ''], threads.map((t) => [
      h('div', {}, h('b', {}, t.full_name), h('div', { class: 'small muted' }, fmtPhone(t.phone), t.user_id ? '' : ' · visiteur')),
      h('span', { class: 'small' }, (t.last_body || '').slice(0, 90)),
      h('div', {}, t.unread_admin ? badge('Nouveau', 'warn') : badge(t.status === 'open' ? 'Répondu' : 'Fermée', t.status === 'open' ? 'ok' : 'grey'), h('div', { class: 'small muted' }, fmtDate(t.last_message_at))),
      h('button', { class: 'btn btn-sm btn-gold', onclick: () => open(t.id, list) }, 'Ouvrir')]), { empty: empty('💬', 'Aucune conversation') })), { poll: 20000 }));
  list();
  return h('div', {}, h('h1', {}, 'Messages'), h('div', { class: 'notice' }, 'Les utilisateurs écrivent depuis le bouton « Aide ». Mot de passe oublié : ouvrez la conversation, vérifiez l\'identité, puis « Envoyer un mot de passe temporaire » : il part par message, la personne le change ensuite dans Profil.'), host);
}

// Données : demandes sur les données personnelles et remise à zéro des activités
export function adminData() {
  return liveView(() => get('/admin/data-requests'), ({ requests }, refresh) => {
    const KIND = { access: 'Accès à mes données', rectification: 'Correction', erasure: 'Suppression', opposition: 'Opposition' };
    const close = (r, status) => action(async () => {
      const v = await ask({ title: status === 'done' ? 'Demande traitée' : 'Refuser la demande', text: `${r.full_name} · ${KIND[r.kind]}. Vérifiez d'abord son identité par un appel au ${fmtPhone(r.phone)}.`, submit: 'Enregistrer', danger: status === 'rejected',
        fields: [{ name: 'note', label: status === 'done' ? 'Ce qui a été fait' : 'Motif du refus' }] });
      if (v) await post(`/admin/data-requests/${r.id}/close`, { status, note: v.note });
    }, { ok: 'Demande clôturée', refresh });
    const reset = action(async () => {
      const v = await ask({ title: 'Remise à zéro des activités', danger: true, submit: 'Tout effacer',
        text: 'Efface : commandes, appels, argent (portefeuilles, retraits, caisses, captures), arrivages, stocks vendeurs et messages envoyés. Conserve : comptes, produits (stock remis à 0), tarifs, réglages. IRRÉVERSIBLE : à faire une seule fois, avant de commencer avec de vraies informations.',
        fields: [{ name: 'confirm', label: 'Tapez REINITIALISER pour confirmer', placeholder: 'REINITIALISER' }, { name: 'password', label: 'Votre mot de passe', type: 'password' }] });
      if (!v) return;
      const r = await post('/admin/reset-activity', v);
      toast(`Remise à zéro faite : ${r.orders} commande(s) et ${r.wallet_entries} mouvement(s) effacés`, 'ok');
    }, { refresh });
    return h('div', {}, h('h1', {}, 'Données'),
      h('div', { class: 'card' }, h('h2', {}, 'Demandes sur les données personnelles'),
        h('p', { class: 'small muted' }, 'Réponse promise sous 30 jours. Pour une suppression, utilisez « Anonymiser » dans Utilisateurs (impossible tant que le portefeuille n\'est pas soldé), puis clôturez la demande.'),
        table(['Date', 'Personne', 'Demande', 'Statut', ''], requests.map((r) => [fmtDate(r.created_at), h('div', {}, h('b', {}, r.full_name), h('div', { class: 'small muted' }, fmtPhone(r.phone))),
          h('div', {}, KIND[r.kind], r.message && h('div', { class: 'small muted' }, r.message)),
          h('div', {}, badge({ open: 'À traiter', done: 'Traitée', rejected: 'Refusée' }[r.status], { open: 'warn', done: 'ok', rejected: 'bad' }[r.status]), r.note && h('div', { class: 'small muted' }, r.note)),
          r.status === 'open' && h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-ok', onclick: close(r, 'done') }, 'Traitée'), h('button', { class: 'btn btn-sm btn-ghost', onclick: close(r, 'rejected') }, 'Refuser'))]),
          { empty: empty('📭', 'Aucune demande') })),
      h('div', { class: 'card danger-zone' }, h('h2', {}, 'Repartir de zéro'),
        h('p', {}, 'Efface toutes les activités de test (commandes, argent, appels, arrivages, messages) pour commencer avec de vraies informations. Les comptes, les produits et les réglages sont conservés.'),
        h('button', { class: 'btn btn-bad', onclick: reset }, 'Remise à zéro des activités')));
  });
}

// Abonnements des vendeurs : encaissement manuel (prélevé sur son portefeuille, ou payé hors plateforme)
function adminSubscriptions() {
  return liveView(() => get('/admin/subscriptions'), ({ settings, sellers }, refresh) => {
    const on = settings.subscription_monthly > 0;
    const charge = (s) => action(async () => {
      const v = await ask({ title: `Abonnement de ${s.full_name}`, text: `${fmtGNF(settings.subscription_monthly)} par mois. « Portefeuille » prélève le montant sur ses gains disponibles ; « Payé hors plateforme » note qu'il a payé autrement (Orange Money, espèces…).`, submit: 'Encaisser', fields: [
        { name: 'months', label: 'Nombre de mois', type: 'number', inputmode: 'numeric', value: 1 },
        { name: 'method', label: 'Mode', type: 'select', options: [['wallet', 'Prélevé sur son portefeuille'], ['external', 'Payé hors plateforme']] },
        { name: 'note', label: 'Note (obligatoire si payé hors plateforme : mode, référence)', required: false }] });
      if (v) await post('/admin/subscriptions/charge', { seller_id: s.id, months: Number(v.months), method: v.method, note: v.note });
    }, { ok: 'Abonnement enregistré', refresh });
    return h('div', { class: 'card' }, h('h2', {}, 'Abonnements des vendeurs'),
      h('div', { class: 'notice' }, on ? `Abonnement : ${fmtGNF(settings.subscription_monthly)} par mois, ${settings.subscription_required ? 'obligatoire pour vendre' : 'facultatif (non obligatoire)'} ; essai gratuit de ${settings.subscription_trial_days} jours.`
        : 'Aucun abonnement : mettez un montant dans « Abonnement mensuel du vendeur » ci-dessus pour l\'activer, puis « Abonnement obligatoire » à 1 pour bloquer les vendeurs non à jour.'),
      h('p', { class: 'small muted' }, `Autres frais actifs : ${settings.fee_order_bps ? `${settings.fee_order_bps / 100} % du prix par commande livrée` : 'pas de % par commande'} · ${settings.fee_unit ? `${fmtGNF(settings.fee_unit)} par produit livré` : 'pas de montant par produit'} · livreur : ${settings.courier_share_bps ? `${settings.courier_share_bps / 100} % des frais de livraison` : 'montant fixe par livraison'}.`),
      on && table(['Vendeur', 'Téléphone', 'Abonnement', ''], sellers.map((s) => [s.full_name, fmtPhone(s.phone), s.paid ? badge(`Payé jusqu'au ${new Date(s.paid_until).toLocaleDateString('fr-FR')}`, 'ok') : badge('Non payé', 'warn'),
        h('button', { class: 'btn btn-sm btn-gold', onclick: charge(s) }, 'Encaisser')]), { empty: empty('👥', 'Aucun vendeur') }));
  });
}
