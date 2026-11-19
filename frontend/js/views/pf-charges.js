// Charges de l'entreprise : une liste prête à remplir (montant par mois). Elle alimente la prévision de trésorerie ;
// rien n'est enregistré automatiquement dans les dépenses (la paie et les dépenses réelles se notent comme d'habitude).
import { h, ask, action, empty, liveView, fmtGNF } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

// [libellé, catégorie, jour du mois conseillé]
const GROUPS = [
  ['Locaux', [['Loyer du bureau', 'rent_space', 1], ['Électricité et eau', 'utilities', 5], ['Sécurité et gardiennage', 'security', 1], ['Nettoyage et entretien', 'maintenance', 1]]],
  ['Plateforme et technologie', [['Hébergement du serveur', 'co_hosting', 1], ['Base de données et sauvegardes', 'co_database', 1], ['SMS et WhatsApp', 'co_sms', 1], ['Nom de domaine et sécurité', 'co_domain', 1], ['Logiciels et licences', 'co_licences', 1], ['Internet et téléphone', 'telecom_fees', 5]]],
  ['Équipe', [['Cotisations sociales (CNSS)', 'co_social', 15], ['Formation', 'education', 1], ['Primes et événements d\'équipe', 'team_events', 28]]],
  ['Flotte et livraison', [['Carburant', 'co_fuel', 1], ['Entretien et réparation des motos', 'co_bike_repair', 1], ['Assurance des motos', 'co_fleet_insurance', 1], ['Équipement des livreurs', 'co_courier_gear', 1], ['Compensations (colis perdu ou abîmé)', 'co_compensation', 28]]],
  ['Marketing', [['Publicité en ligne', 'co_ads', 1], ['Promotions et parrainage', 'co_promo', 1], ['Affiches, tenues et supports imprimés', 'co_print', 1]]],
  ['Administration et impôts', [['Comptable et juridique', 'accounting_legal', 1], ['Impôts', 'tax', 15], ['Patente et taxes locales', 'co_local_tax', 15], ['Assurance de l\'entreprise', 'insurance', 1], ['Frais Mobile Money et banque', 'co_momo_fees', 1]]]
];

export function chargesScreen({ go, head, card }) {
  return liveView(() => get('/pf/plan'), (d, refresh) => {
    const byLabel = new Map((d.recurring || []).filter((r) => r.kind === 'expense').map((r) => [r.label, r]));
    const total = [...byLabel.values()].reduce((s, r) => s + (r.frequency === 'monthly' ? Number(r.amount) : r.frequency === 'weekly' ? Number(r.amount) * 4 : Number(r.amount) * 30), 0);
    const day = (n) => { const t = new Date(); const m = t.getUTCDate() > n ? t.getUTCMonth() + 1 : t.getUTCMonth(); return new Date(Date.UTC(t.getUTCFullYear(), m, n)).toISOString().slice(0, 10); };
    const setCharge = (label, category, dom) => action(async () => {
      if (d.tier !== 'pro') { go('pro'); return; }
      const cur = byLabel.get(label);
      const v = await ask({ title: label, text: 'Montant de cette charge chaque mois. Il sert à la prévision de trésorerie.', submit: 'Enregistrer', fields: [{ name: 'amount', label: 'Montant par mois (GNF)', type: 'number', inputmode: 'numeric', value: cur?.amount ?? '' }, { name: 'anchor_on', label: 'Prochaine échéance (jour 1 à 28)', type: 'date', value: cur?.anchor_on || day(dom) }] });
      if (!v) return;
      await post('/pf/recurring', { id: cur?.id, label, kind: 'expense', category, amount: Math.round(Number(v.amount)), frequency: 'monthly', anchor_on: v.anchor_on });
    }, { ok: 'Charge enregistrée', refresh });
    return h('div', {}, head('Charges de l\'entreprise', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' },
      card(null, h('div', { class: 'pf-start' }, h('span', { class: 'pf-ico pf-c-blue' }, icon('receipt', 26)), h('div', {}, h('b', {}, 'Tout ce dont l\'entreprise a besoin pour fonctionner'),
        h('p', {}, 'Touchez une ligne pour indiquer son montant mensuel. Le total alimente la prévision à 30 jours. La paie se fait dans « Paie des employés ».'))),
        h('div', { class: 'pf-big' }, fmtGNF(total)), h('div', { class: 'pf-sub' }, 'de charges par mois renseignées')),
      GROUPS.map(([title, items]) => card(title, items.map(([label, category, dom]) => {
        const cur = byLabel.get(label);
        return h('button', { class: 'pf-flow', type: 'button', onclick: setCharge(label, category, dom) }, h('b', {}, label), h('small', { class: 'pf-sub' }, cur ? `${fmtGNF(cur.amount)} par mois` : 'À renseigner'));
      }))),
      byLabel.size === 0 && empty('receipt', 'Aucune charge renseignée pour le moment.')));
  });
}
