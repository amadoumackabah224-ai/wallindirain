// Accords individuels de rémunération : conditions propres à un compte, conclues avec la personne puis activées par l'administrateur.
// Aucun calcul ici : le serveur contrôle tout (montants, dates, catégorie du livreur). Rien ne s'applique rétroactivement.
import { h, ask, fmtGNF, fmtDate, liveView, amount, action, table, toast, empty, confirmBox } from '../ui.js';
import { get, post } from '../api.js';

const when = (v) => {
  if (v === 'tomorrow') { const d = new Date(); d.setHours(24, 0, 0, 0); return d.toISOString(); }
  if (v === 'week') { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  return undefined;
};
const WHEN = { name: 'when', label: 'Entrée en vigueur', type: 'select', options: [['now', 'Maintenant'], ['tomorrow', 'Demain à minuit'], ['week', 'Dans 7 jours']] };
const END = { name: 'end', label: 'Mettre fin à l\'accord (retour aux règles communes)', type: 'checkbox', required: false, value: false };

const summary = (d) => {
  const t = d.in_force;
  if (!t) return d.kind === 'agent' ? `Pas d'accord : rémunération commune de ${fmtGNF(d.common_pay)} par commande confirmée et livrée.` : (d.courier_kind === 'company' ? 'Pas d\'accord : barème des livreurs de Wallindirain (ou règles communes).' : 'Pas d\'accord : règles communes des indépendants.');
  if (d.kind === 'agent') return `Accord en vigueur : ${fmtGNF(t.pay_per_order)} par commande confirmée et livrée (depuis le ${fmtDate(t.effective_from)}).`;
  return `Accord en vigueur : ${fmtGNF(t.per_delivery)} par livraison${Number(t.tour_extra) ? ` · +${fmtGNF(t.tour_extra)} par livraison de tournée dès la 2e` : ''}${Number(t.failed_trip) ? ` · ${fmtGNF(t.failed_trip)} par déplacement à vide` : ''}${Number(t.prime_threshold) ? ` · prime ${fmtGNF(t.prime_amount)} dès ${t.prime_threshold} livraisons/jour` : ''}.`;
};

/** Ouvre la fenêtre de l'accord d'un livreur (de Wallindirain), d'un agent ou d'un chef d'équipe. */
export const openAgreement = (user, refresh) => action(async () => {
  const d = await get(`/admin/agreements/${user.id}`);
  const t = d.in_force;
  const num = (name, label, value, hint) => ({ name, label, type: 'number', inputmode: 'numeric', required: false, value: value ?? '', hint });
  const fields = d.kind === 'agent'
    ? [{ name: 'pay', label: 'Rémunération par commande confirmée et livrée (GNF)', type: 'number', inputmode: 'numeric', value: t?.pay_per_order ?? '', required: false }, WHEN, { name: 'note', label: 'Note (accord conclu avec…)', required: false, maxlength: 200 }, ...(t ? [END] : [])]
    : [{ name: 'per', label: 'Paie par livraison réussie (GNF)', type: 'number', inputmode: 'numeric', required: false, value: t?.per_delivery ?? '', hint: `Au plus ${fmtGNF(d.min_zone_fee)} (zone la moins chère).` },
      num('extra', 'Supplément par livraison à partir de la 2e d\'une tournée', t?.tour_extra), num('failed', 'Déplacement à vide (livraison non aboutie)', t?.failed_trip),
      num('thr', 'Prime : à partir de combien de livraisons dans la journée', t?.prime_threshold, '0 ou vide = pas de prime.'), num('prime', 'Montant de la prime du jour', t?.prime_amount),
      WHEN, { name: 'note', label: 'Note (accord conclu avec…)', required: false, maxlength: 200 }, ...(t ? [END] : [])];
  const v = await ask({ title: `Accord de rémunération : ${user.full_name}`, text: `${summary(d)} Un nouvel accord s'applique seulement aux missions affectées (livreur) ou confirmées (agent) à partir de la date choisie ; l'ancien reste dans l'historique.`, submit: 'Valider', fields });
  if (!v) return;
  const base = `/admin/agreements/${user.id}/${d.kind}`;
  if (v.end) { await post(`${base}/end`, { note: v.note || undefined }); toast('Accord terminé : les règles communes s\'appliquent de nouveau', 'ok'); return; }
  if (d.kind === 'agent') {
    if (v.pay === '' || v.pay == null) { toast('Indiquez la rémunération de l\'accord', 'bad'); return; }
    await post(base, { pay: Number(v.pay), effective_from: when(v.when), note: v.note || undefined });
  } else {
    if (!v.per) { toast('Indiquez la paie par livraison de l\'accord', 'bad'); return; }
    await post(base, { per_delivery: Number(v.per), tour_extra: Number(v.extra || 0), failed_trip: Number(v.failed || 0), prime_threshold: Number(v.thr || 0), prime_amount: Number(v.prime || 0), effective_from: when(v.when), note: v.note || undefined });
  }
  toast('Accord enregistré', 'ok');
}, { refresh });

/** Carte « Accord de rémunération » : accord en vigueur et historique (fiche du livreur). */
export function agreementCard(user, refresh) {
  return liveView(() => get(`/admin/agreements/${user.id}`), (d, reload) => h('div', { class: 'card' },
    h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Accord de rémunération'), h('button', { class: 'btn btn-sm btn-gold', onclick: openAgreement(user, async () => { await reload(); refresh?.(); }) }, d.in_force ? 'Modifier l\'accord' : 'Faire un accord')),
    h('p', { class: 'small muted' }, summary(d)),
    d.kind === 'courier'
      ? table(['Depuis', 'Par livraison', 'Tournée (+)', 'À vide', 'Prime', 'Note'], d.terms.map((t) => [fmtDate(t.effective_from), Number(t.per_delivery) ? amount(t.per_delivery) : 'Fin d\'accord', amount(t.tour_extra), amount(t.failed_trip), Number(t.prime_threshold) ? `${fmtGNF(t.prime_amount)} dès ${t.prime_threshold}` : '—', t.note || '—']), { empty: empty('scroll', 'Aucun accord individuel') })
      : table(['Depuis', 'Par commande livrée', 'Note'], d.terms.map((t) => [fmtDate(t.effective_from), t.pay_per_order != null ? amount(t.pay_per_order) : 'Fin d\'accord', t.note || '—']), { empty: empty('scroll', 'Aucun accord individuel') })));
}
