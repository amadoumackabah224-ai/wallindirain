// Tableau argent du vendeur, affiché en haut du Portefeuille : argent à venir, dépenses récurrentes, budget, objectif.
// Lecture seule sur l'argent de la plateforme ; les prévisions sont des estimations, et l'écran le dit.
import { h, fmtGNF, liveView, badge, ask, confirmBox, action } from '../ui.js';
import { get, post } from '../api.js';

const CATEGORY = { ads: 'Publicité', goods: 'Marchandise', transport: 'Transport', other: 'Autre' };
const FREQ = { daily: 'Tous les jours', weekly: 'Toutes les semaines', monthly: 'Tous les mois' };
const isoPlus = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Section « Tableau argent » : ne montre rien tant que la fonction n'est pas allumée par l'administrateur. */
export function sellerFinances() {
  let horizon = 30;
  return liveView(() => get('/seller/finances'), (o, refresh) => {
    if (!o.enabled) return h('div');
    const f = o.forecast.find((x) => x.days === horizon);

    const setRate = action(async () => {
      const v = await ask({ title: 'Taux de livraison pour la prévision', text: `Part des commandes en cours que vous pensez voir livrées. ${o.rate.enough_history ? `Votre taux réel récent : ${o.rate.real} %.` : 'Pas encore assez de commandes terminées pour calculer votre taux réel.'} Laissez vide pour utiliser le taux automatique.`,
        submit: 'Enregistrer', fields: [{ name: 'rate', label: 'Taux (en %)', type: 'number', inputmode: 'numeric', value: o.rate.custom ?? '', required: false, hint: 'Entre 5 et 100.' }] });
      if (!v) return;
      await post('/seller/finances/rate', { rate: v.rate === '' ? null : Number(v.rate) });
    }, { ok: 'Taux enregistré', refresh });

    const editRecurring = (r) => action(async () => {
      const v = await ask({ title: r ? 'Modifier la dépense récurrente' : 'Nouvelle dépense récurrente', text: 'Rien n\'est débité : ce sont des repères pour la prévision et les rappels.', submit: 'Enregistrer', fields: [
        { name: 'label', label: 'Nom (ex. Publicité Facebook, loyer)', value: r?.label || '', maxlength: 40 },
        { name: 'category', label: 'Catégorie', type: 'select', options: Object.entries(CATEGORY), value: r?.category || 'ads' },
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: r?.amount ?? '' },
        { name: 'frequency', label: 'Fréquence', type: 'select', options: Object.entries(FREQ), value: r?.frequency || 'monthly' },
        { name: 'anchor_on', label: 'Première échéance (mensuel : jour 1 à 28)', type: 'date', value: r?.anchor_on || isoPlus(1) }] });
      if (!v) return;
      await post('/seller/finances/recurring', { id: r?.id, label: v.label, category: v.category, amount: Number(v.amount), frequency: v.frequency, anchor_on: v.anchor_on });
    }, { ok: 'Dépense récurrente enregistrée', refresh });

    const stopRecurring = (r) => action(async () => {
      if (!(await confirmBox('Arrêter cette dépense ?', `« ${r.label} » n'entrera plus dans la prévision.`, 'Arrêter', true))) return;
      await post(`/seller/finances/recurring/${r.id}/stop`);
    }, { ok: 'Dépense arrêtée', refresh });

    const setBudget = (b) => action(async () => {
      const v = await ask({ title: `Budget du mois : ${CATEGORY[b.category]}`, text: 'Combien voulez-vous dépenser au maximum ce mois-ci ? Laissez vide pour retirer le budget.', submit: 'Enregistrer',
        fields: [{ name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: b.budget ?? '', required: false }] });
      if (!v) return;
      await post('/seller/finances/budget', { category: b.category, amount: v.amount === '' ? null : Number(v.amount) });
    }, { ok: 'Budget enregistré', refresh });

    const setGoal = action(async () => {
      const v = await ask({ title: 'Objectif de gains du mois', text: 'Combien voulez-vous gagner ce mois-ci ? Laissez vide pour retirer l\'objectif.', submit: 'Enregistrer',
        fields: [{ name: 'target', label: 'Objectif (GNF)', type: 'number', inputmode: 'numeric', value: o.goal.target ?? '', required: false }] });
      if (!v) return;
      await post('/seller/finances/goal', { target: v.target === '' ? null : Number(v.target) });
    }, { ok: 'Objectif enregistré', refresh });

    const chips = h('div', { class: 'chips' }, o.forecast.map((x) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(x.days === horizon),
      onclick: () => { horizon = x.days; refresh(); } }, `${x.days} jours`)));

    return h('div', { class: 'card' },
      h('h2', {}, 'Tableau argent'),
      o.due_soon.length > 0 && h('div', { class: 'notice warn' }, h('b', {}, 'À payer bientôt : '), o.due_soon.slice(0, 3).map((d) => `${d.label} (${fmtGNF(d.amount)}, ${dayLabel(d.on)})`).join(' · '), o.due_soon.length > 3 && ` et ${o.due_soon.length - 3} autre(s)`),
      o.ads_alert && h('div', { class: 'notice bad' }, `Votre publicité coûte ${fmtGNF(o.ads_alert.ads_per_delivery)} par livraison, plus que votre gain moyen (${fmtGNF(o.ads_alert.avg_gain)}). À surveiller.`),
      h('div', { class: 'small muted' }, `${o.in_progress} commande(s) en cours${o.avg_gain > 0 ? ` · gain moyen par livraison : ${fmtGNF(o.avg_gain)}` : ''}. Votre solde et vos gains en attente sont dans le cadre doré plus bas.`),

      h('h3', {}, 'Argent à venir'), chips,
      h('div', { class: 'small muted mt' }, `Dans ${f.days} jours, en comptant seulement ce qui existe déjà : votre solde, les gains qui se débloquent, vos commandes en cours et vos dépenses récurrentes. Aucune vente future n'est devinée.`),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Sûr'), h('dd', {}, fmtGNF(f.certain)),
        h('dt', {}, 'Prudent'), h('dd', {}, fmtGNF(f.low)),
        h('dt', { class: 'key' }, 'Probable'), h('dd', { class: 'key' }, fmtGNF(f.mid)),
        h('dt', {}, 'Favorable'), h('dd', {}, fmtGNF(f.high))),
      h('div', { class: 'small muted' }, `Estimation avec un taux de livraison de ${o.rate.used} % (${o.rate.custom != null ? 'réglé par vous' : o.rate.enough_history ? 'votre taux réel' : 'taux par défaut, pas assez d\'historique'}). `,
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: setRate }, 'Modifier')),

      h('details', { class: 'mt' }, h('summary', {}, 'Objectif du mois'),
        o.goal.target == null
          ? h('p', { class: 'muted' }, 'Pas d\'objectif ce mois-ci.')
          : h('div', {}, h('progress', { value: Math.min(o.goal.gains, o.goal.target), max: o.goal.target, 'aria-label': 'Avancement de l\'objectif' }),
            h('p', {}, `${fmtGNF(o.goal.gains)} gagnés sur ${fmtGNF(o.goal.target)}.`),
            o.goal.missing > 0
              ? h('p', { class: 'small muted' }, `Il reste ${o.goal.days_left} jour(s). Il vous manque ${fmtGNF(o.goal.missing)}${o.goal.deliveries_missing ? `, soit environ ${o.goal.deliveries_missing} livraison(s)` : ''}.`)
              : badge('Objectif atteint', 'ok')),
        h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: setGoal }, o.goal.target == null ? 'Fixer un objectif' : 'Modifier')),

      h('details', { class: 'mt' }, h('summary', {}, 'Budget du mois'),
        h('p', { class: 'small muted' }, 'Le réel vient des dépenses que vous saisissez dans « Mon bénéfice ».'),
        o.budgets.map((b) => h('div', { class: 'gap mb' }, h('div', { class: 'grow' }, h('b', {}, CATEGORY[b.category]), ' ',
          b.budget == null ? h('span', { class: 'muted' }, `${fmtGNF(b.spent)} dépensés, pas de budget`) : h('span', {}, `${fmtGNF(b.spent)} sur ${fmtGNF(b.budget)} `, b.spent > b.budget ? badge('Dépassé', 'bad') : b.spent >= 0.8 * b.budget ? badge('Presque atteint', 'warn') : badge('Dans le budget', 'ok'))),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: setBudget(b) }, b.budget == null ? 'Fixer' : 'Modifier')))),

      h('details', { class: 'mt' }, h('summary', {}, `Dépenses récurrentes (${o.recurring.length})`),
        o.recurring.length === 0 && h('p', { class: 'muted' }, 'Aucune pour le moment : publicité quotidienne, loyer, internet…'),
        o.recurring.map((r) => h('div', { class: 'gap mb' }, h('div', { class: 'grow' }, h('b', {}, r.label), ' ', h('span', { class: 'muted' }, `${fmtGNF(r.amount)} · ${FREQ[r.frequency].toLowerCase()} · ${CATEGORY[r.category]}${r.next ? ` · prochaine : ${dayLabel(r.next)}` : ''}`)),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: editRecurring(r) }, 'Modifier'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: stopRecurring(r) }, 'Arrêter'))),
        h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: editRecurring(null) }, 'Ajouter')),
      h('div', { class: 'small muted mt' }, h('a', { href: '#/app/profit' }, 'Saisir une dépense dans Mon bénéfice')));
  });
}
