// Espace administrateur : livreurs indépendants et livreurs de Wallindirain (moto de l'entreprise), fiche, charges de la moto, barèmes et simulation.
// Aucun calcul d'argent ici : tout est calculé et contrôlé par le serveur (la simulation aussi). L'écran affiche et envoie.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, amount, action, kv, empty, toast, badge, table, confirmBox, pageHead, errToast } from '../ui.js';
import { get, post } from '../api.js';
import { reviewIdentity } from './kyc.js';
import { agreementCard } from './agreements.js';

const KIND = { independent: 'Indépendant', company: 'Wallindirain' };
const KIND_LONG = { independent: 'Livreur indépendant (sa propre moto)', company: 'Livreur de Wallindirain (moto de l\'entreprise)' };
const kindBadge = (k) => badge(KIND[k] || k, k === 'company' ? 'info' : 'grey');
const EXPENSE = { fuel: 'Carburant', maintenance: 'Entretien', repair: 'Réparation', insurance: 'Assurance', other: 'Autre' };
const STATUS = { assigned: 'Affectée', picked_up: 'Récupérée', on_the_way: 'En route', delivered: 'Livrée', failed: 'Échec', return_pending: 'Retour', returned: 'Retournée', confirmed: 'Confirmée' };
const PAY_KIND = { team_pay: 'Livraison', tour_bonus: 'Supplément de tournée', tour_adjust: 'Ajustement de tournée', courier_prime: 'Prime du jour', failed_trip: 'Déplacement à vide', cash_shortage: 'Manque de caisse', withdrawal: 'Retrait' };
const num = (el) => (el.value === '' ? 0 : Number(el.value));

export function adminCouriers() {
  let view = 'list', fileId = null, filter = 'all';
  const host = h('div');
  const show = () => host.replaceChildren(fileId ? fileView() : view === 'scales' ? scalesView() : listView());
  const open = (id) => { fileId = id; show(); window.scrollTo?.(0, 0); };
  const back = () => { fileId = null; show(); };

  function tabs() {
    const t = (key, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(view === key && !fileId), onclick: () => { view = key; fileId = null; show(); } }, label);
    return h('div', { class: 'chips mb' }, t('list', 'Livreurs'), t('scales', 'Barèmes et simulation'));
  }

  // ---------- Liste ----------
  function listView() {
    return h('div', {}, pageHead('Livreurs', 'Indépendants (leur moto) et livreurs de Wallindirain (moto de l\'entreprise)'), tabs(),
      liveView(() => get('/admin/couriers'), ({ couriers }, refresh) => {
        const shown = couriers.filter((c) => filter === 'all' || c.kind === filter);
        const chip = (key, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; show(); } }, label);
        const count = (k) => couriers.filter((c) => c.kind === k).length;
        return h('div', {}, h('div', { class: 'chips mb' }, chip('all', `Tous (${couriers.length})`), chip('independent', `Indépendants (${count('independent')})`), chip('company', `Wallindirain (${count('company')})`)),
          h('div', { class: 'card' }, table(['Livreur', 'Livraisons (30 j)', 'Paies (30 j)', 'Argent à reverser', 'Charges moto (30 j)', 'Identité', ''], shown.map((c) => [
            h('div', {}, h('b', {}, c.full_name), ' ', kindBadge(c.kind), h('div', { class: 'small muted' }, [fmtPhone(c.phone), c.status !== 'active' ? ({ pending: 'À valider', suspended: 'Suspendu' }[c.status] || c.status) : null, c.open_orders ? `${c.open_orders} mission(s) en cours` : null].filter(Boolean).join(' · '))),
            String(c.delivered_30), amount(c.pay_30), c.cash_pending > 0 ? h('b', {}, fmtGNF(c.cash_pending)) : '—', c.kind === 'company' || c.expenses_30 > 0 ? amount(c.expenses_30) : '—',
            c.identity_verified ? badge('Vérifiée', 'ok') : badge(({ submitted: 'À examiner', rejected: 'Refusée' }[c.kyc_status]) || 'Non faite', c.kyc_status === 'submitted' ? 'warn' : c.kyc_status === 'rejected' ? 'bad' : 'grey'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => open(c.id) }, 'Fiche')]), { empty: empty('bike', 'Aucun livreur dans cette catégorie') })),
          h('p', { class: 'small muted' }, 'Pour créer un livreur et choisir sa catégorie : Utilisateurs → « Créer un livreur ». Les paies affichées sont celles réellement versées.'));
      }, { poll: 0 }));
  }

  // ---------- Fiche d'un livreur ----------
  function fileView() {
    const id = fileId;
    return liveView(() => get(`/admin/couriers/${id}/file`), (f, refresh) => {
      const c = f.courier;
      const changeKind = action(async () => {
        const to = c.kind === 'company' ? 'independent' : 'company';
        const v = await ask({ title: `Passer ${c.full_name} en « ${KIND[to]} »`, submit: 'Changer la catégorie', text: to === 'company'
          ? 'Il utilisera une moto de l\'entreprise. Sa paie suivra le barème « Wallindirain » (s\'il y en a un en vigueur), sinon les règles communes.'
          : 'Il utilisera sa propre moto et sera payé selon les règles des indépendants. Les missions déjà calculées et les paies déjà versées ne changent jamais. Impossible tant qu\'il a une mission, une proposition ou une tournée en cours.',
        fields: [{ name: 'note', label: 'Note (facultative)', required: false, maxlength: 200 }] });
        if (v) await post(`/admin/couriers/${id}/kind`, { kind: to, note: v.note || undefined });
      }, { ok: 'Catégorie modifiée', refresh });
      const addExpense = action(async () => {
        const v = await ask({ title: 'Charge de la moto', text: 'Carburant, entretien, réparation… payés par l\'entreprise. C\'est un journal : rien n\'est versé au livreur.', submit: 'Enregistrer', fields: [
          { name: 'kind', label: 'Type', type: 'select', options: Object.entries(EXPENSE) }, { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric' },
          { name: 'spent_on', label: 'Date', type: 'date', required: false, hint: 'Laissez vide pour aujourd\'hui.' }, { name: 'note', label: 'Note', required: false, maxlength: 200 }] });
        if (v) await post(`/admin/couriers/${id}/expenses`, { kind: v.kind, amount: Number(v.amount), spent_on: v.spent_on || undefined, note: v.note || undefined });
      }, { ok: 'Charge enregistrée', refresh });
      const voidExpense = (e) => action(async () => {
        const v = await ask({ title: 'Annuler cette charge', text: `${EXPENSE[e.kind]} · ${fmtGNF(e.amount)}. Elle reste visible dans l'historique, barrée.`, submit: 'Annuler la charge', danger: true, fields: [{ name: 'reason', label: 'Motif', maxlength: 200 }] });
        if (v) await post(`/admin/expenses/${e.id}/void`, { reason: v.reason });
      }, { ok: 'Charge annulée', refresh });
      return h('div', {}, h('div', { class: 'gap mb' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: back }, '← Retour aux livreurs')),
        pageHead(c.full_name, `${KIND_LONG[c.kind]} · ${fmtPhone(c.phone)}`),
        h('div', { class: 'card' }, h('h2', {}, 'Compte'), kv([['Catégorie', kindBadge(c.kind)], ['Statut', { active: 'Actif', pending: 'À valider', suspended: 'Suspendu' }[c.status] || c.status],
          ['Identité', c.identity_verified ? 'Vérifiée' : ({ submitted: 'Pièce à examiner', rejected: 'Pièce refusée' }[c.kyc_status] || 'Pas encore demandée')], ['Véhicule', { moto: 'Moto', velo: 'Vélo', voiture: 'Voiture', pied: 'À pied' }[c.vehicle] || 'Non précisé'],
          ['Versement', c.payout_phone ? `${c.payout_method === 'orange_money' ? 'Orange Money' : 'MTN MoMo'} · ${fmtPhone(c.payout_phone)}` : 'Non défini'], ['Solde du portefeuille', fmtGNF(f.balance)], ['Argent à reverser', fmtGNF(f.cash_pending)]]),
          h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-gold', onclick: changeKind }, c.kind === 'company' ? 'Passer en indépendant' : 'Passer en livreur de Wallindirain'),
            c.kyc_status === 'submitted' && h('button', { class: 'btn btn-sm btn-ghost', onclick: () => reviewIdentity({ id: c.id, full_name: c.full_name }, refresh) }, 'Examiner la pièce'))),
        agreementCard({ id: c.id, full_name: c.full_name }, refresh),
        h('div', { class: 'card' }, h('h2', {}, 'Historique de catégorie'), table(['Depuis', 'Catégorie', 'Par', 'Note'], f.kind_history.map((k) => [fmtDate(k.effective_from), kindBadge(k.kind), k.set_by_name || '—', k.note || '—']), { empty: h('p', { class: 'muted' }, 'Indépendant depuis la création (aucun changement).') })),
        h('div', { class: 'card' }, h('h2', {}, 'Missions récentes'), table(['Commande', 'Statut', 'Zone', 'Frais livraison', 'Paie', 'Catégorie retenue', 'Date'], f.orders.map((o) => [h('b', {}, o.ref), STATUS[o.status] || o.status, o.commune, amount(o.delivery_fee), amount(o.pay),
          o.courier_kind ? h('span', {}, kindBadge(o.courier_kind), o.scale_applied ? h('div', { class: 'small muted' }, 'barème appliqué') : null) : '—', fmtDate(o.delivered_at || o.created_at)]), { empty: empty('package', 'Aucune mission') }),
          h('p', { class: 'small muted' }, 'La catégorie et le barème sont retenus au moment de l\'affectation : ils ne changent plus ensuite.')),
        h('div', { class: 'card' }, h('h2', {}, 'Paies et mouvements'), table(['Date', 'Type', 'Montant', 'Détail'], f.pay.map((p) => [fmtDate(p.created_at), PAY_KIND[p.kind] || p.kind, amount(p.amount, true), p.description || '']), { empty: empty('wallet', 'Aucun mouvement') })),
        h('div', { class: 'card' }, h('h2', {}, 'Reversements'), table(['Date', 'Mode', 'Annoncé', 'Reçu', 'Statut'], f.remittances.map((r) => [fmtDate(r.created_at), { cash: 'Espèces', orange_money: 'Orange Money', mtn_momo: 'MTN MoMo' }[r.method] || r.method, amount(r.amount), r.received != null ? amount(r.received) : '—', { pending: 'À valider', confirmed: 'Confirmé', rejected: 'Refusé' }[r.status] || r.status]), { empty: empty('wallet', 'Aucun reversement') })),
        h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Charges de la moto'), h('button', { class: 'btn btn-sm btn-gold', onclick: addExpense }, '+ Ajouter')),
          h('p', { class: 'small muted' }, `Total (hors charges annulées) : ${fmtGNF(f.expenses_total)}. Journal de l'entreprise : ces montants ne sont pas versés au livreur.`),
          table(['Date', 'Type', 'Montant', 'Note', ''], f.expenses.map((e) => [e.spent_on, EXPENSE[e.kind] || e.kind, e.voided_at ? h('s', {}, fmtGNF(e.amount)) : amount(e.amount), e.voided_at ? `Annulée : ${e.void_reason}` : (e.note || '—'),
            e.voided_at ? '' : h('button', { class: 'btn btn-sm btn-ghost', onclick: voidExpense(e) }, 'Annuler')]), { empty: empty('wallet', 'Aucune charge enregistrée') })));
    });
  }

  // ---------- Barèmes et simulation ----------
  function scalesView() {
    return h('div', {}, pageHead('Barèmes des livreurs', 'Rien ne s\'active sans votre validation'), tabs(),
      liveView(() => get('/admin/courier-scales'), (d, refresh) => {
        const ind = d.independent, inForce = d.scales.find((s) => s.in_force && Number(s.per_delivery) > 0);
        const pctText = (bps) => (Number(bps) > 0 ? `${Number(bps) / 100} %` : 'non réglé');
        // formulaire de simulation (valeurs gardées pendant la session ; les coûts de la moto ne sont JAMAIS préremplis : à saisir)
        const field = (label, value, hint, attrs = {}) => { const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, value: value === 0 || value == null ? '' : String(value), ...attrs }); return { input, el: h('label', { class: 'f' }, h('span', {}, label), input, hint && h('div', { class: 'hint' }, hint)) }; };
        const f = {
          fee: field('Frais de livraison moyens (GNF)', d.avg_zone_fee || '', 'Moyenne de vos zones actives ; modifiable.'),
          per: field('Paie par livraison réussie', inForce?.per_delivery ?? '', `Au plus ${fmtGNF(d.min_zone_fee)} (zone la moins chère).`), extra: field('Supplément par livraison à partir de la 2e d\'une tournée', inForce?.tour_extra ?? ''),
          failed: field('Déplacement à vide (livraison non aboutie)', inForce?.failed_trip ?? ''), thr: field('Prime : à partir de combien de livraisons dans la journée', inForce?.prime_threshold ?? '', '0 = pas de prime.', { max: 50 }), prime: field('Montant de la prime du jour', inForce?.prime_amount ?? ''),
          fuel: field('Prix du litre de carburant (GNF)', ''), cons: field('Consommation (litres aux 100 km)', '', null, { step: '0.1' }), maint: field('Entretien, pneus, réparations (GNF par km)', ''),
          moto: field('Prix d\'achat de la moto (GNF)', ''), life: field('Jours de travail avant de la remplacer', ''), days: field('Jours travaillés par mois', 26)
        };
        const out = h('div');
        const body = () => ({ fee: num(f.fee.input), scale: { per_delivery: num(f.per.input), tour_extra: num(f.extra.input), failed_trip: num(f.failed.input), prime_threshold: num(f.thr.input), prime_amount: num(f.prime.input) },
          moto: { fuel_price: num(f.fuel.input), consumption: num(f.cons.input), maint_km: num(f.maint.input), price: num(f.moto.input), life_days: num(f.life.input) || 1, days_per_month: num(f.days.input) || 26 } });
        const simulate = action(async () => {
          const b = body(); const r = await post('/admin/courier-scales/simulate', b);
          const unknown = !b.moto.fuel_price && !b.moto.maint_km && !b.moto.price;
          out.replaceChildren(
            unknown && h('div', { class: 'notice warn' }, 'Les coûts de la moto ne sont pas renseignés : la marge affichée ignore carburant, entretien et amortissement. Ne la prenez pas pour un résultat.'),
            h('div', { class: 'card' }, h('h2', {}, 'Résultat de la simulation'), table(['Scénario', 'Livrées / attribuées', 'Frais encaissés', 'Indépendant (paie · marge Wallindirain)', 'Livreur Wallindirain (paie · coût moto · marge)'], r.scenarios.map((s) => [
              h('b', {}, s.name), `${s.delivered} / ${s.assigned}`, amount(s.delivery_fees),
              h('div', {}, `${fmtGNF(s.independent.normal.pay)} · ${fmtGNF(s.independent.normal.margin)}`, s.independent.A && h('div', { class: 'small muted' }, `Tournées mode A : ${fmtGNF(s.independent.A.pay)}`), s.independent.B && h('div', { class: 'small muted' }, `Tournées mode B : ${fmtGNF(s.independent.B.pay)}`)),
              s.company ? h('div', {}, `${fmtGNF(s.company.pay)} · ${fmtGNF(s.moto.total)} · `, h('b', {}, fmtGNF(s.company.margin)), h('div', { class: 'small muted' }, `Par mois : paie ${fmtGNF(s.company.month_pay)}, marge ${fmtGNF(s.company.month_margin)}`)) : 'Saisissez une paie par livraison']), { empty: empty('chart', 'Aucun scénario') }),
              r.breakeven_deliveries_per_day != null && h('p', {}, `Équilibre (marge après la moto ≥ 0) : à partir de ${r.breakeven_deliveries_per_day} livraison(s) par jour.`),
              h('p', { class: 'small muted' }, r.notice)));
        }, {});
        const save = action(async () => {
          const b = body();
          if (!b.scale.per_delivery) { toast('Indiquez la paie par livraison du barème', 'bad'); return; }
          const v = await ask({ title: 'Enregistrer ce barème ?', submit: 'Enregistrer', text: 'Il s\'appliquera aux livreurs de Wallindirain, pour les missions affectées à partir de la date choisie. Les missions déjà affectées et les paies déjà versées ne changent pas. Chaque version est conservée avec son auteur.', fields: [
            { name: 'when', label: 'Entrée en vigueur', type: 'select', options: [['now', 'Maintenant'], ['tomorrow', 'Demain à minuit'], ['week', 'Dans 7 jours']] }, { name: 'note', label: 'Note (facultative)', required: false, maxlength: 200 }] });
          if (!v) return;
          const d0 = new Date(); let eff;
          if (v.when === 'tomorrow') { d0.setHours(24, 0, 0, 0); eff = d0.toISOString(); } else if (v.when === 'week') { d0.setDate(d0.getDate() + 7); d0.setHours(0, 0, 0, 0); eff = d0.toISOString(); }
          await post('/admin/courier-scales', { per_delivery: b.scale.per_delivery, tour_extra: b.scale.tour_extra, failed_trip: b.scale.failed_trip, prime_threshold: b.scale.prime_threshold, prime_amount: b.scale.prime_amount, effective_from: eff, note: v.note || undefined });
        }, { ok: 'Barème enregistré', refresh });
        const stop = action(async () => {
          if (!(await confirmBox('Revenir aux règles communes ?', 'Les livreurs de Wallindirain seront de nouveau payés comme les indépendants, pour les missions affectées à partir de maintenant. Rien de passé ne change.', 'Revenir aux règles communes'))) return;
          await post('/admin/courier-scales', { per_delivery: 0 });
        }, { ok: 'Retour aux règles communes', refresh });
        return h('div', {},
          h('div', { class: 'card' }, h('h2', {}, 'Livreurs indépendants'), h('p', { class: 'small muted' }, 'Règles actuelles, inchangées. Elles se modifient dans Réglages.'),
            kv([['Part du livreur sur les frais de livraison', Number(ind.courier_share_bps) > 0 ? pctText(ind.courier_share_bps) : `montant fixe de ${fmtGNF(ind.courier_pay)}`], ['Tournée, mode A', pctText(ind.tour_share_bps)], ['Tournée, mode B (dès la 2e livraison)', pctText(ind.tour_extra_share_bps)],
              ['Supplément de tournée (mode normal)', Number(ind.tour_bonus_per_extra_order) > 0 ? fmtGNF(ind.tour_bonus_per_extra_order) : 'aucun']]),
            h('a', { class: 'btn btn-sm btn-ghost', href: '#/app/settings' }, 'Ouvrir les réglages')),
          h('div', { class: 'card' }, h('h2', {}, 'Livreurs de Wallindirain'),
            inForce ? h('div', {}, h('div', { class: 'notice ok' }, 'Barème en vigueur'), kv([['Paie par livraison réussie', fmtGNF(inForce.per_delivery)], ['Supplément (2e livraison et suivantes d\'une tournée)', fmtGNF(inForce.tour_extra)], ['Déplacement à vide', fmtGNF(inForce.failed_trip)],
              ['Prime du jour', Number(inForce.prime_threshold) > 0 ? `${fmtGNF(inForce.prime_amount)} dès ${inForce.prime_threshold} livraisons` : 'aucune'], ['En vigueur depuis', fmtDate(inForce.effective_from)]]), h('button', { class: 'btn btn-sm btn-ghost', onclick: stop }, 'Revenir aux règles communes'))
              : h('div', { class: 'notice' }, 'Aucun barème : les livreurs de Wallindirain sont payés comme les indépendants. Simulez ci-dessous puis enregistrez quand vous êtes d\'accord.'),
            h('p', { class: 'small muted' }, 'Carburant et entretien de la moto : journal des charges dans la fiche de chaque livreur (rien n\'est versé au livreur).')),
          h('div', { class: 'card' }, h('h2', {}, 'Simuler avant d\'activer'),
            h('p', { class: 'small muted' }, 'Estimation avec les chiffres que vous saisissez : ce n\'est pas un coût réel. Les frais d\'appel, la commission de plateforme, l\'assurance et les imprévus ne sont pas inclus. Les coûts de la moto sont à saisir : ils ne sont jamais préremplis.'),
            h('h3', {}, 'Barème à tester'), h('div', { class: 'form-grid' }, f.per.el, f.extra.el, f.failed.el, f.thr.el, f.prime.el),
            h('h3', {}, 'Frais et moto (vos chiffres)'), h('div', { class: 'form-grid' }, f.fee.el, f.fuel.el, f.cons.el, f.maint.el, f.moto.el, f.life.el, f.days.el),
            h('div', { class: 'gap' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: simulate }, 'Simuler'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: save }, 'Enregistrer ce barème'))),
          out,
          h('div', { class: 'card' }, h('h2', {}, 'Historique des barèmes'), table(['En vigueur depuis', 'Par livraison', 'Tournée (suppl.)', 'À vide', 'Prime', 'Par', 'Note'], d.scales.map((s) => [
            h('span', {}, fmtDate(s.effective_from), s.in_force && Number(s.per_delivery) > 0 ? h('div', {}, badge('En vigueur', 'ok')) : (new Date(s.effective_from) > new Date() ? h('div', {}, badge('À venir', 'warn')) : null)),
            Number(s.per_delivery) > 0 ? fmtGNF(s.per_delivery) : 'règles communes', fmtGNF(s.tour_extra), fmtGNF(s.failed_trip), Number(s.prime_threshold) > 0 ? `${fmtGNF(s.prime_amount)} dès ${s.prime_threshold}` : '—', s.created_by_name || '—', s.note || '—']),
            { empty: h('p', { class: 'muted' }, 'Aucun barème enregistré pour l\'instant.') })));
      }, { poll: 0 }));
  }

  show();
  return host;
}
