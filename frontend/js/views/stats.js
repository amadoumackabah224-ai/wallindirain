// Tableaux de bord (vendeur, administrateur), suivi de commande pour le client, parrainage.
import { h, fmtGNF, fmtDate, liveView, table, empty, kv, toast, CAUSE_LABEL } from '../ui.js';
import { get } from '../api.js';

const PERIODS = [[7, '7 jours'], [30, '30 jours'], [90, '3 mois'], [365, '1 an']];
const pct = (v) => (v == null ? '–' : `${String(v).replace('.', ',')} %`);
const tile = (label, value, hint) => h('div', { class: 'card stat' }, h('div', { class: 'small muted' }, label), h('div', { class: 'stat-n' }, value), hint && h('div', { class: 'small muted' }, hint));

// Barres horizontales : la largeur est posée par le style DOM (la politique de sécurité interdit les attributs style)
function bars(items, fmt = (n) => String(n)) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h('div', { class: 'bars' }, items.map((i) => {
    const fill = h('span', { class: 'bar-f' });
    fill.style.width = `${Math.round((i.value * 100) / max)}%`;
    return h('div', { class: 'bar-row' }, h('span', { class: 'bar-l' }, i.label), h('span', { class: 'bar-t' }, fill), h('span', { class: 'bar-v' }, fmt(i.value)));
  }));
}

function withPeriod(title, load, render) {
  let days = 30;
  const host = h('div');
  const chips = h('div', { class: 'chips' }, PERIODS.map(([d, l]) => h('button', { class: 'chip', 'aria-pressed': String(d === days), onclick: (e) => {
    days = d; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); refresh(); } }, l)));
  function refresh() { host.replaceChildren(liveView(() => load(days), render)); }
  refresh();
  return h('div', {}, h('h1', {}, title), chips, host);
}

/** Tableau de bord du vendeur. */
export function sellerStats() {
  return withPeriod('Mes chiffres', (d) => get(`/seller/stats?days=${d}`), (s) => {
    if (!s.total) return empty('📊', 'Pas encore de commande sur cette période');
    const weekLabel = (iso) => `Sem. du ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    return h('div', {},
      h('div', { class: 'grid g3' },
        tile('Commandes', s.total, `${s.in_progress} en cours`),
        tile('Livrées', s.delivered, s.delivery_rate == null ? 'Pas encore de résultat' : `Taux de livraison : ${pct(s.delivery_rate)}`),
        tile('Échecs et retours', s.failed, `${s.cancelled} annulée(s)`),
        tile('Chiffre d\'affaires livré', fmtGNF(s.sales))),
      s.delivery_rate != null && s.delivery_rate < 60 && h('div', { class: 'notice warn mt' }, 'Moins de 6 commandes sur 10 sont livrées. Vérifiez les adresses et assurez-vous que vos clients veulent vraiment le produit : chaque refus coûte des frais.'),
      h('div', { class: 'card' }, h('h2', {}, 'Mes gains par semaine'),
        s.weeks.length ? bars(s.weeks.map((w) => ({ label: weekLabel(w.week), value: Number(w.gain) })), fmtGNF) : h('p', { class: 'muted' }, 'Aucun gain encore : ils apparaissent après les livraisons.')),
      h('div', { class: 'card' }, h('h2', {}, 'Mes produits les plus rentables'),
        s.products.length ? table(['Produit', 'Livrées', 'Gain'], s.products.map((p) => [p.name, p.delivered, fmtGNF(p.gain)])) : h('p', { class: 'muted' }, 'Aucune livraison sur cette période.')),
      s.failed_by_cause.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Pourquoi des colis reviennent'),
        bars(s.failed_by_cause.map((c) => ({ label: CAUSE_LABEL?.[c.cause] || (c.cause === 'unknown' ? 'Cause non précisée' : c.cause), value: c.n })))));
  });
}

/** Statistiques de l'administrateur : produits, call centers, livreurs, retours. */
export function adminStats() {
  return withPeriod('Statistiques', (d) => get(`/admin/stats?days=${d}`), (s) => {
    const t = s.totals;
    return h('div', {},
      h('div', { class: 'grid g3' }, tile('Commandes', t.orders), tile('Livrées', t.delivered), tile('Ventes livrées', fmtGNF(t.sales)), tile('Revenu plateforme', fmtGNF(t.platform_revenue), 'Frais, marge, appels')),
      h('div', { class: 'card' }, h('h2', {}, 'Produits'),
        table(['Produit', 'Livrées', 'Échecs', 'Taux', 'Ventes', 'Revenu plateforme'], s.products.map((p) => [p.name, p.delivered, p.failed, pct(p.delivery_rate), fmtGNF(p.sales), fmtGNF(p.platform_revenue)]),
          { empty: empty('🛍️', 'Aucune donnée') })),
      h('div', { class: 'card' }, h('h2', {}, 'Call centers'),
        table(['Call center', 'Appels', 'Confirmés', 'Injoignables', 'Refus', 'Taux de confirmation'], s.call_centers.map((c) => [c.name, c.calls, c.confirmed, c.unreachable, c.refused, pct(c.confirm_rate)]),
          { empty: empty('📞', 'Aucun appel') })),
      h('div', { class: 'card' }, h('h2', {}, 'Livreurs'),
        table(['Livreur', 'Livrées', 'Échecs', 'Taux de livraison'], s.couriers.map((c) => [c.name, c.delivered, c.failed, pct(c.delivery_rate)]), { empty: empty('🏍️', 'Aucune livraison') })),
      s.returns.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Causes des retours'),
        bars(s.returns.map((r) => ({ label: CAUSE_LABEL?.[r.cause] || r.cause, value: r.n })))));
  });
}

const STEPS = [['received', 'Commande reçue', 'Un conseiller va vous appeler pour confirmer.'], ['confirmed', 'Commande confirmée', 'Nous préparons votre colis.'],
  ['assigned', 'Livreur désigné', 'Un livreur va récupérer votre colis.'], ['on_the_way', 'En route', 'Le livreur arrive : gardez votre téléphone allumé.'], ['delivered', 'Livrée', 'Merci pour votre confiance !']];

/** Page publique de suivi : le client voit seulement l'étape de sa commande. */
export function trackView(token) {
  const root = h('main', { class: 'public', id: 'contenu' });
  const logo = h('div', { class: 'hero' }, h('img', { src: '/assets/logo-gold.png', alt: 'Wallindirain' }));
  root.append(logo, liveView(() => get(`/public/track/${encodeURIComponent(token)}`), (t) => {
    const idx = STEPS.findIndex((s) => s[0] === t.step);
    return h('div', { class: 'card' }, h('h1', {}, `Commande ${t.ref}`),
      kv([['Produit', `${t.product} × ${t.qty}`], ['Total à payer à la livraison', fmtGNF(t.amount)], ['Passée le', fmtDate(t.created_at)]]),
      t.step === 'cancelled' && h('div', { class: 'notice warn' }, 'Cette commande a été annulée.'),
      t.step === 'problem' && h('div', { class: 'notice warn' }, `La livraison n'a pas abouti. Notre équipe va vous recontacter. Besoin d'aide : ${t.contact_phone}.`),
      idx >= 0 && h('ol', { class: 'track' }, STEPS.map((s, i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', 'aria-current': i === idx ? 'step' : null },
        h('b', {}, s[1]), i === idx && h('div', { class: 'small muted' }, s[2])))),
      h('p', { class: 'small muted' }, 'Cette page se met à jour toute seule. Elle ne montre que l\'état de votre commande.'),
      h('p', { class: 'center small muted' }, `Une question ? Appelez le ${t.contact_phone}`));
  }, { poll: 30000 }));
  return root;
}

/** Carte « Parrainage » du profil (vendeurs et fournisseurs). */
export function referralCard() {
  return liveView(() => get('/me/referral'), (r) => {
    const link = `${location.origin}/#/register/${r.code}`;
    const msg = `Rejoins Wallindirain pour vendre en ligne avec paiement à la livraison. Inscris-toi avec mon code de parrainage ${r.code} : ${link}`;
    const copy = async () => { try { await navigator.clipboard.writeText(link); toast('Lien copié', 'ok'); } catch { toast(link, 'ok'); } };
    return h('div', { class: 'card' }, h('h2', {}, 'Parrainage'),
      r.bonus > 0
        ? h('p', {}, `Invitez un vendeur : quand il aura ${r.orders_required} commandes livrées, vous recevez `, h('b', {}, fmtGNF(r.bonus)), '.')
        : h('p', { class: 'muted' }, 'Le parrainage n\'est pas activé pour le moment.'),
      kv([['Mon code', h('b', {}, r.code)], ['Vendeurs invités', r.referred], ['Bonus reçus', `${r.paid} · ${fmtGNF(r.earned)}`], r.my_referrer && ['Parrain', r.my_referrer]]),
      r.bonus > 0 && h('div', { class: 'gap' },
        h('a', { class: 'btn btn-sm btn-gold', href: `https://wa.me/?text=${encodeURIComponent(msg)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Inviter sur WhatsApp'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: copy }, 'Copier mon lien')));
  });
}
