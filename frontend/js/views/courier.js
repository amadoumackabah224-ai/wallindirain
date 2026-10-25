// Espace livreur : récupérer, livrer avec le code du client, signaler un échec.
import { h, ask, confirmBox, fmtGNF, fmtDate, liveView, statusBadge, amount, action, kv, empty, toast, telLink, waLink, badge, table, since, pickupText, pickupLate, proofButton, FAIL_LABEL } from '../ui.js';
import { get, post } from '../api.js';

const PAY = { cash: 'Espèces', orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };
const OPERATOR = { orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' };

export function courierOrders() {
  return liveView(() => Promise.all([get('/courier/orders'), get('/courier/profile'), get('/courier/offers'), get('/courier/tours')]).then(([o, profile, off, t]) => ({ ...o, profile, offers: off.offers, tours: t.tours })), ({ profile, offers, tours, orders, cash_to_hand_over, cash_pending_validation, max_attempts, require_code, pickup_alert_hours }, refresh) => h('div', {},
    h('h1', {}, 'Mes livraisons'),
    h('div', { class: 'card gap mb' }, h('div', { class: 'grow' }, h('b', {}, profile.availability === 'available' ? 'Vous êtes disponible' : 'Vous êtes indisponible'),
      h('div', { class: 'small muted' }, profile.zones.length ? `Zones : ${profile.zones.join(', ')}` : 'Aucune zone définie : l\'administration vous les attribue.')),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: action(() => post('/courier/availability', { available: profile.availability !== 'available' }), { ok: 'Disponibilité mise à jour', refresh }) },
        profile.availability === 'available' ? 'Me mettre indisponible' : 'Me mettre disponible')),
    h('div', { class: 'kpi mb' }, h('div', { class: 'v' }, fmtGNF(cash_to_hand_over)), h('div', { class: 'l' }, 'Argent encaissé à remettre à l\'administration (tout manque vous est débité). Onglet « Caisse » pour reverser par transfert.'),
      cash_pending_validation > 0 && h('div', { class: 'small muted' }, `+ ${fmtGNF(cash_pending_validation)} déjà reversés par transfert, en attente de validation`)),
    tours.map((t) => h('div', { class: 'card mb' }, h('b', {}, `Tournée de ${t.stops.length} commandes`), t.note && h('div', { class: 'small muted' }, t.note),
      h('ol', { class: 'small' }, t.stops.map((st) => h('li', {}, `${st.ref} · ${st.commune} · `, statusBadge(st.status)))), h('div', { class: 'small muted' }, 'Livrez dans cet ordre si possible. Chaque commande se valide séparément ci-dessous.'))),
    offers.length > 0 && h('div', {}, h('h2', {}, `Propositions de mission (${offers.length})`), offers.map((m) => {
      const accept = action(() => post(`/courier/offers/${m.id}/accept`), { ok: 'Mission acceptée : elle apparaît dans vos livraisons', refresh });
      const refuse = action(async () => {
        const v = await ask({ title: `Refuser ${m.ref}`, text: 'Aucune pénalité. Le motif aide à mieux répartir les missions.', submit: 'Refuser', danger: true, fields: [{ name: 'reason', label: 'Motif', type: 'select', options: [['', 'Je ne précise pas'], ['too_far', 'Trop loin'], ['busy', 'Déjà occupé'], ['vehicle', 'Véhicule indisponible'], ['other', 'Autre']] }] });
        if (v) await post(`/courier/offers/${m.id}/refuse`, { reason: v.reason || null });
      }, { ok: 'Proposition refusée', refresh });
      return h('div', { class: 'card order' }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, m.ref), badge(`Réponse avant ${new Date(m.expires_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'warn'), m.retry && badge('Nouvelle tentative', 'grey')),
        kv([['Zone', m.commune], ['Produit', `${m.product} × ${m.qty}`], ['À encaisser', amount(m.amount_to_collect)], ['Votre rémunération', amount(m.courier_pay)]]),
        h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-ok', onclick: accept }, 'Accepter'), h('button', { class: 'btn btn-ghost', onclick: refuse }, 'Refuser')));
    })),
    orders.length ? orders.map((o) => {
      const step = (path, ok) => action(() => post(`/courier/orders/${o.id}/${path}`), { ok, refresh });
      const deliver = action(async () => {
        if (require_code) {
          const v = await ask({ title: `Livrer ${o.ref}`, text: `Encaissez ${fmtGNF(o.amount_to_collect)}, puis demandez au client son code à 4 chiffres. Vous ne pouvez pas livrer sans ce code (${max_attempts} essais).`, submit: 'Valider la livraison',
            fields: [{ name: 'code', label: 'Code du client', inputmode: 'numeric', maxlength: 4, code: true }] });
          if (v) await post(`/courier/orders/${o.id}/deliver`, { code: v.code });
        } else if (await confirmBox(`Livrer ${o.ref} ?`, `Confirmez seulement si le colis est remis au client et que vous avez encaissé ${fmtGNF(o.amount_to_collect)}.`, 'Oui, livré')) {
          await post(`/courier/orders/${o.id}/deliver`, {});
        }
      }, { ok: 'Livraison validée. Merci !', refresh });
      // Comment le client a payé : espèces, ou transfert (capture d'écran obligatoire)
      const payment = action(async () => {
        const v = await ask({ title: `Paiement du client · ${o.ref}`, text: 'Si le client paie par transfert Mobile Money, joignez la capture d\'écran du message de confirmation.', submit: 'Enregistrer', fields: [
          { name: 'method', label: 'Le client a payé en', type: 'select', options: Object.entries(PAY) },
          { name: 'reference', label: 'Référence de la transaction (si transfert)', required: false },
          { name: 'image', label: 'Capture d\'écran du transfert', type: 'image', required: false, hint: 'Obligatoire si le client paie par Orange Money ou MTN MoMo.' }] });
        if (!v) return;
        if (v.method !== 'cash' && !v.image) { toast('Ajoutez la capture d\'écran du transfert.', 'bad'); return; }
        const proof = v.method !== 'cash' ? (await post('/proofs', { kind: 'order_payment', image: v.image })).id : undefined;
        await post(`/courier/orders/${o.id}/payment`, { method: v.method, proof_id: proof, reference: v.reference || undefined });
      }, { ok: 'Mode de paiement enregistré', refresh });
      const fail = action(async () => {
        const v = await ask({ title: `Échec de livraison ${o.ref}`, submit: 'Signaler l\'échec', danger: true, fields: [{ name: 'reason', label: 'Motif', type: 'select', options: Object.entries(FAIL_LABEL) }] });
        if (v) await post(`/courier/orders/${o.id}/fail`, { reason: v.reason });
      }, { ok: 'Échec signalé : le chef call center va réaffecter', refresh });
      return h('div', { class: `card order ${o.risk_flag ? 'risk' : ''}` }, h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status), o.risk_flag && badge('Client à risque', 'bad')),
        pickupLate(o, pickup_alert_hours) && h('div', { class: 'notice bad' }, h('b', {}, `⏰ Colis affecté depuis ${since(o.assigned_since)}. `), 'Récupérez-le maintenant, ou prévenez le chef call center si vous ne pouvez pas.'),
        o.risk_flag && h('div', { class: 'notice warn' }, 'Ce client a déjà refusé ou raté une livraison : confirmez avec lui avant de vous déplacer.'),
        kv([['Client', o.customer_name], ['Téléphone', h('span', { class: 'gap' }, telLink(o.customer_phone), waLink(o.customer_phone, `Bonjour ${o.customer_name}, je suis votre livreur Wallindirain pour la commande ${o.ref}. Je suis en route, merci de rester joignable.`))], ['À récupérer', pickupText(o)], ['Adresse', `${o.commune}, ${o.address}`], o.note && ['Note', o.note], ['Colis', `${o.product_name} × ${o.qty}`], ['À encaisser', amount(o.amount_to_collect)], o.payment_method && ['Paiement déclaré', badge(PAY[o.payment_method], 'ok')]]),
        h('div', { class: 'gap mt' },
          o.status === 'assigned' && h('button', { class: 'btn btn-gold', onclick: step('pickup', 'Colis récupéré') }, 'J\'ai récupéré le colis'),
          o.status === 'picked_up' && h('button', { class: 'btn btn-gold', onclick: step('depart', 'Bonne route !') }, 'Je pars livrer'),
          o.status === 'on_the_way' && !o.payment_method && h('button', { class: 'btn btn-ghost', onclick: payment }, '💳 Paiement du client'),
          o.status === 'on_the_way' && h('button', { class: 'btn btn-ok', onclick: deliver }, require_code ? '✔ Livrer avec le code' : '✔ Colis livré'),
          h('button', { class: 'btn btn-ghost', onclick: fail }, 'Échec')),
        require_code && o.code_attempts > 0 && h('div', { class: 'notice warn mt' }, `${o.code_attempts} essai(s) de code déjà utilisé(s) sur ${max_attempts}.`));
    }) : empty('🏍️', 'Aucune livraison affectée pour le moment')), { poll: 15000 });
}

const REMIT_STATUS = { pending: ['En attente de validation', 'warn'], confirmed: ['Validé', 'ok'], rejected: ['Refusé', 'bad'] };

// Caisse : l'argent encaissé à remettre, avec la possibilité de reverser par transfert en joignant la capture d'écran
export function courierCash() {
  return liveView(() => get('/courier/cash'), ({ entries, remittances }, refresh) => {
    const due = entries.filter((e) => !e.in_remittance);
    const remit = action(async () => {
      const v = await ask({ title: 'Reverser par transfert', text: 'Envoyez l\'argent par Orange Money ou MTN MoMo au numéro indiqué par Wallindirain, puis joignez la capture d\'écran. L\'administrateur vérifie et valide.', submit: 'Envoyer pour validation', fields: [
        ...due.map((e) => ({ name: `o_${e.order_id}`, label: `${e.ref} · ${fmtGNF(e.amount)}`, type: 'checkbox', value: true, required: false })),
        { name: 'method', label: 'Transfert envoyé par', type: 'select', options: Object.entries(OPERATOR) },
        { name: 'reference', label: 'Référence de la transaction', required: false },
        { name: 'image', label: 'Capture d\'écran du transfert', type: 'image' }] });
      if (!v) return;
      const chosen = due.filter((e) => v[`o_${e.order_id}`]).map((e) => e.order_id);
      if (!chosen.length) { toast('Cochez au moins une commande à reverser.', 'bad'); return; }
      const proof = (await post('/proofs', { kind: 'remittance', image: v.image })).id;
      await post('/courier/remit', { method: v.method, proof_id: proof, reference: v.reference || undefined, orders: chosen });
    }, { ok: 'Reversement envoyé : en attente de validation', refresh });
    const total = due.reduce((a, e) => a + e.amount, 0);
    return h('div', {}, h('h1', {}, 'Caisse'),
      h('div', { class: 'kpi mb' }, h('div', { class: 'v' }, fmtGNF(total)), h('div', { class: 'l' }, 'À remettre à l\'administration (en espèces ou par transfert)')),
      h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Encaissements à remettre'), due.length > 0 && h('button', { class: 'btn btn-sm btn-gold', onclick: remit }, '📲 Reverser par transfert')),
        table(['Commande', 'Montant', 'Livrée le', 'Situation'], entries.map((e) => [h('b', {}, e.ref), amount(e.amount), fmtDate(e.created_at), e.in_remittance ? badge('Reversement en attente', 'warn') : badge('À remettre', 'gold')]),
          { empty: empty('✅', 'Rien à remettre pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mes reversements par transfert'), table(['Date', 'Montant', 'Via', 'Statut', ''], remittances.map((r) => [fmtDate(r.created_at), amount(r.amount),
        `${OPERATOR[r.method]}${r.reference ? ` · ${r.reference}` : ''}`, h('div', {}, badge(...REMIT_STATUS[r.status]), r.status === 'confirmed' && r.received !== r.amount && h('div', { class: 'small muted' }, `Reçu : ${fmtGNF(r.received)}`), r.decision_note && h('div', { class: 'small muted' }, r.decision_note)), proofButton(r.proof_id)]),
        { empty: empty('📲', 'Aucun reversement par transfert') })));
  }, { poll: 30000 });
}
