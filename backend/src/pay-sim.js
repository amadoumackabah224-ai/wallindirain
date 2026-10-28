// Simulation de rémunération des livreurs (aucune écriture, aucun effet : sert à comparer avant d'activer un barème).
// Un seul endroit de calcul : l'écran de l'administration affiche ce que ce module renvoie, il ne recalcule rien.
// Les hypothèses (frais moyens, carburant, jours…) sont saisies par l'administrateur : ce sont des ESTIMATIONS, jamais des coûts vérifiés.

const int = (x, name, min, max) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n < min || n > max) { const e = new Error(`${name} invalide`); e.code = 'invalid_input'; throw e; }
  return Math.round(n);
};
const pct = (fee, bps) => Math.floor((fee * bps + 5000) / 10000);

export const DEFAULT_SCENARIOS = [
  { name: 'faible', assigned: 6, delivered: 4, km: 45, grouped: 0 },
  { name: 'normal', assigned: 10, delivered: 8, km: 70, grouped: 50 },
  { name: 'fort', assigned: 14, delivered: 12, km: 100, grouped: 80 }
];

/** Livraisons isolées, nombre de tournées (de 3 commandes) et livraisons en tournée, pour un nombre de livraisons et une part groupée (%). */
export function splitTours(delivered, groupedPct) {
  const wanted = Math.round((delivered * groupedPct) / 100 / 3) * 3;
  const inTours = Math.min(wanted, Math.floor(delivered / 3) * 3);
  return { tours: inTours / 3, inTours, isolated: delivered - inTours };
}

/**
 * @param {object} i
 *  fee: frais de livraison moyens (GNF) ; independent: { share_bps, fixed_pay, tour_share_bps, tour_extra_share_bps } (réglages actuels)
 *  scale: { per_delivery, tour_extra, failed_trip, prime_threshold, prime_amount } (barème proposé)
 *  moto: { fuel_price, consumption, maint_km, price, life_days, days_per_month } ; scenarios: [{ name, assigned, delivered, km, grouped }]
 */
export function simulate(i) {
  const fee = int(i.fee, 'Frais moyens', 1000, 1_000_000);
  const ind = i.independent || {};
  const sc = i.scale || {};
  const scale = {
    per_delivery: int(sc.per_delivery ?? 0, 'Paie par livraison', 0, 1_000_000), tour_extra: int(sc.tour_extra ?? 0, 'Supplément de tournée', 0, 1_000_000),
    failed_trip: int(sc.failed_trip ?? 0, 'Déplacement à vide', 0, 1_000_000), prime_threshold: int(sc.prime_threshold ?? 0, 'Seuil de prime', 0, 50), prime_amount: int(sc.prime_amount ?? 0, 'Prime', 0, 1_000_000)
  };
  const m = i.moto || {};
  const moto = {
    fuel_price: int(m.fuel_price ?? 0, 'Prix du carburant', 0, 100_000), consumption: Number(m.consumption ?? 0), maint_km: int(m.maint_km ?? 0, 'Entretien par km', 0, 10_000),
    price: int(m.price ?? 0, 'Prix de la moto', 0, 1_000_000_000), life_days: int(m.life_days ?? 1, 'Durée de vie (jours)', 1, 5000), days_per_month: int(m.days_per_month ?? 26, 'Jours par mois', 1, 31)
  };
  if (!Number.isFinite(moto.consumption) || moto.consumption < 0 || moto.consumption > 20) { const e = new Error('Consommation invalide'); e.code = 'invalid_input'; throw e; }
  const scenarios = (Array.isArray(i.scenarios) && i.scenarios.length ? i.scenarios : DEFAULT_SCENARIOS).slice(0, 6).map((s) => ({
    name: String(s.name || '').slice(0, 20) || 'scénario', assigned: int(s.assigned, 'Commandes attribuées', 0, 200), delivered: int(s.delivered, 'Commandes livrées', 0, 200),
    km: int(s.km, 'Kilomètres', 0, 1000), grouped: int(s.grouped ?? 0, 'Part groupée', 0, 100)
  }));
  const indPerOrder = Number(ind.share_bps) > 0 ? pct(fee, Number(ind.share_bps)) : Math.min(fee, Number(ind.fixed_pay) || 0);
  const depreciation = Math.round(moto.price / moto.life_days);
  const rows = scenarios.map((s) => {
    if (s.delivered > s.assigned) { const e = new Error('Livrées ne peut pas dépasser attribuées'); e.code = 'invalid_input'; throw e; }
    const t = splitTours(s.delivered, s.grouped);
    const fees = s.delivered * fee;
    const fuel = Math.round((s.km * moto.consumption / 100) * moto.fuel_price), maintenance = s.km * moto.maint_km;
    const motoCost = fuel + maintenance + depreciation;
    // indépendant : règles actuelles (mode normal ; modes A et B si réglés)
    const indNormal = s.delivered * indPerOrder;
    const indA = Number(ind.tour_share_bps) > 0 ? t.isolated * indPerOrder + t.inTours * Math.min(fee, pct(fee, Number(ind.tour_share_bps))) : null;
    const indB = Number(ind.tour_extra_share_bps) > 0 ? t.isolated * indPerOrder + t.tours * (indPerOrder + 2 * Math.min(fee, pct(fee, Number(ind.tour_extra_share_bps)))) : null;
    // livreur de Wallindirain : barème proposé (chaque montant plafonné aux frais de la commande)
    let company = null;
    if (scale.per_delivery > 0) {
      const per = Math.min(scale.per_delivery, fee);
      const extra = t.tours * 2 * Math.min(scale.tour_extra, Math.max(fee - per, 0));
      const failed = (s.assigned - s.delivered) * Math.min(scale.failed_trip, fee);
      const prime = scale.prime_threshold > 0 && s.delivered >= scale.prime_threshold ? scale.prime_amount : 0;
      const pay = s.delivered * per + extra + failed + prime;
      company = { pay, per_delivery_part: s.delivered * per, tour_part: extra, failed_part: failed, prime_part: prime, moto_cost: motoCost,
        margin: fees - pay - motoCost, month_pay: pay * moto.days_per_month, month_margin: (fees - pay - motoCost) * moto.days_per_month };
    }
    const variants = {};
    for (const [key, pay] of [['normal', indNormal], ['A', indA], ['B', indB]]) {
      if (pay != null) variants[key] = { pay, margin: fees - pay, month_pay: pay * moto.days_per_month, month_margin: (fees - pay) * moto.days_per_month, courier_net_after_own_costs: pay - motoCost };
    }
    return { name: s.name, assigned: s.assigned, delivered: s.delivered, km: s.km, grouped: s.grouped, delivery_fees: fees, tours: t.tours, isolated: t.isolated,
      moto: { fuel, maintenance, depreciation, total: motoCost, per_delivery: s.delivered ? Math.round(motoCost / s.delivered) : null }, independent: variants, company };
  });
  // seuil d'équilibre du livreur de Wallindirain : premier nombre de livraisons par jour où la marge (après moto) devient positive, avec les km du scénario « normal »
  let breakeven = null;
  if (scale.per_delivery > 0) {
    const ref = scenarios.find((s) => s.name === 'normal') || scenarios[Math.floor(scenarios.length / 2)];
    for (let n = 1; n <= 60; n++) {
      const t = splitTours(n, ref.grouped);
      const per = Math.min(scale.per_delivery, fee);
      const pay = n * per + t.tours * 2 * Math.min(scale.tour_extra, Math.max(fee - per, 0)) + (scale.prime_threshold > 0 && n >= scale.prime_threshold ? scale.prime_amount : 0);
      const cost = Math.round((ref.km * moto.consumption / 100) * moto.fuel_price) + ref.km * moto.maint_km + depreciation;
      if (n * fee - pay - cost >= 0) { breakeven = n; break; }
    }
  }
  return { fee, assumptions: { moto, depreciation_per_day: depreciation }, scale, scenarios: rows, breakeven_deliveries_per_day: breakeven,
    notice: 'Estimation à partir des hypothèses saisies : ce n\'est pas un coût réel. La commission de plateforme, les frais du centre d\'appel, l\'assurance et les imprévus ne sont pas inclus.' };
}
