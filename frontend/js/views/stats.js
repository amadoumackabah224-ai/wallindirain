// Tableaux de bord (vendeur, administrateur), suivi de commande pour le client, parrainage.
import { h, fmtGNF, fmtDate, liveView, table, empty, kv, toast, badge, trophy, TROPHY, CAUSE_LABEL, CHANNEL_LABEL } from '../ui.js';
import { get, post } from '../api.js';

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
  return h('div', {}, rankingCard(), sellerStatsBody());
}

function sellerStatsBody() {
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
      s.by_channel && s.by_channel.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Mes commandes par canal'),
        table(['Canal', 'Commandes', 'Livrées', 'Ventes livrées'], s.by_channel.map((c) => [CHANNEL_LABEL[c.channel] || c.channel, c.total, c.delivered, fmtGNF(c.sales)]))),
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

// Messages d'invitation prêts à envoyer : un par type de vendeur. Aucun montant n'y figure.
const INVITES = [
  ['online', 'Vendeur en ligne', (c, l) => `Tu vends sur WhatsApp, Facebook ou Instagram ? Wallindirain livre tes colis et encaisse le paiement à la livraison. Tu es payé pour chaque colis livré. Inscris-toi avec mon code ${c} : ${l}`],
  ['shop', 'Boutique', (c, l) => `Tu as une boutique ? Ne te déplace plus pour livrer : Wallindirain livre tes commandes et encaisse pour toi. Tu es payé pour chaque colis livré. Inscris-toi avec mon code ${c} : ${l}`],
  ['short', 'Message court', (c, l) => `Wallindirain livre et encaisse pour toi. Tu es payé pour chaque colis livré. Mon code ${c} : ${l}`]];
// Niveau de parrain : simple affichage selon le nombre de filleuls ayant atteint l'objectif (aucun effet sur l'argent)
const PARRAIN_LEVELS = [[1, 'bronze'], [3, 'silver'], [5, 'gold'], [10, 'platinum']];
const levelOf = (n) => PARRAIN_LEVELS.reduce((cur, [min, tier], i) => (n >= min ? { tier, i } : cur), { tier: 'none', i: -1 });

/** Carte « Parrainage » du profil (vendeurs et fournisseurs). */
export function referralCard() {
  return liveView(() => get('/me/referral'), (r) => {
    const link = `${location.origin}/#/register/${r.code}`;
    let kind = INVITES[0][0];
    const text = () => INVITES.find((x) => x[0] === kind)[2](r.code, link);
    const preview = h('p', { class: 'invite-text' }, text());
    const chips = h('div', { class: 'chips' }, INVITES.map(([k, label]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === kind), onclick: (e) => {
      kind = k; preview.textContent = text(); wa.href = `https://wa.me/?text=${encodeURIComponent(text())}`; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
    } }, label)));
    const copyText = async (t, ok) => { try { await navigator.clipboard.writeText(t); toast(ok, 'ok'); } catch { toast(t, 'ok'); } };
    const wa = h('a', { class: 'btn btn-gold', href: `https://wa.me/?text=${encodeURIComponent(text())}`, target: '_blank', rel: 'noopener noreferrer' }, 'Inviter sur WhatsApp');
    const lvl = levelOf(r.paid);
    const next = PARRAIN_LEVELS[lvl.i + 1];
    const need = Number(r.orders_required) || 0;
    const mine = Math.min(Number(r.my_progress) || 0, need);
    const bar = (v, max) => { const i = h('span', { class: 'seg-i ok' }); i.style.width = `${(v * 100) / Math.max(1, max)}%`; return h('div', { class: 'seg', role: 'img', 'aria-label': `${v} sur ${max}` }, i); };
    return h('div', { class: 'card referral' }, h('h2', {}, 'Parrainage'),
      r.bonus > 0
        ? h('p', {}, `Invitez un vendeur : quand il aura ${r.orders_required} commandes livrées, vous recevez `, h('b', {}, fmtGNF(r.bonus)), '.')
        : h('p', { class: 'muted' }, 'Le parrainage n\'est pas activé pour le moment.'),
      r.my_referrer && h('div', { class: 'notice' }, mine >= need && need > 0 ? `Objectif atteint : merci ! ${r.my_referrer} a reçu son bonus de parrainage.` : `Vous avez été invité par ${r.my_referrer}. Encore ${need - mine} livraison(s) pour que son bonus soit versé.`, need > 0 && bar(mine, need)),
      h('div', { class: 'code-box' }, h('span', { class: 'muted small' }, 'Mon code'), h('b', { class: 'code' }, r.code), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => copyText(r.code, 'Code copié') }, 'Copier le code')),
      h('div', { class: 'mchips' },
        h('div', { class: 'mchip info' }, h('span', { class: 'mchip-l' }, 'Vendeurs invités'), h('b', { class: 'mchip-v' }, String(r.referred))),
        h('div', { class: 'mchip ok' }, h('span', { class: 'mchip-l' }, 'Objectif atteint'), h('b', { class: 'mchip-v' }, String(r.paid))),
        h('div', { class: 'mchip' }, h('span', { class: 'mchip-l' }, 'En cours'), h('b', { class: 'mchip-v' }, String(Math.max(0, r.referred - r.paid)))),
        h('div', { class: 'mchip gold' }, h('span', { class: 'mchip-l' }, 'Bonus reçus'), h('b', { class: 'mchip-v' }, fmtGNF(r.earned)))),
      h('div', { class: 'level' }, trophy(lvl.tier, 44), h('div', {}, h('b', {}, `Niveau de parrain : ${lvl.tier === 'none' ? 'à débloquer' : TROPHY[lvl.tier].name}`),
        h('div', { class: 'small muted' }, next ? `Encore ${next[0] - r.paid} filleul(s) actif(s) pour le niveau ${TROPHY[next[1]].name}.` : 'Niveau maximum atteint, bravo !'))),
      r.bonus > 0 && h('div', {}, h('h3', { class: 'sub-h' }, 'Message à envoyer'), chips, preview,
        h('div', { class: 'gap actions' }, wa,
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => copyText(text(), 'Message copié') }, 'Copier le message'),
          navigator.share && h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigator.share({ text: text() }).catch(() => {}) }, 'Partager'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => copyText(link, 'Lien copié') }, 'Copier le lien'))));
  });
}

/** Invitation sur l'accueil du vendeur : visible seulement après une première livraison et si le parrainage est actif. */
export function referralNudge(goTo, delivered) {
  const box = h('div', {});
  if (!(delivered > 0)) return box;
  get('/me/referral').then((r) => {
    if (!(r.bonus > 0)) return;
    box.append(h('div', { class: 'panel nudge' }, h('h2', {}, 'Bravo pour votre première livraison !'),
      h('p', { class: 'muted' }, 'Invitez un autre vendeur : vous recevez un bonus quand il aura fait ses premières livraisons.'),
      h('button', { class: 'btn btn-gold', type: 'button', onclick: () => goTo('profile') }, 'Inviter un vendeur')));
  }).catch(() => {});
  return box;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Trophée du vendeur + classement du mois (seuls rang, prénom, livraisons et trophée sont visibles des autres). */
function rankingCard() {
  return liveView(() => get('/seller/ranking'), (r, refresh) => {
    const name = TROPHY[r.tier].name;
    const nextName = r.next_tier ? TROPHY[r.next_tier].name : '';
    const month = `${MONTHS[Number(r.month.slice(5, 7)) - 1]} ${r.month.slice(0, 4)}`;
    const toggle = async () => { try { await post('/seller/ranking-visibility', { hidden: !r.hidden }); refresh(); } catch (e) { toast(e.message, 'bad'); } };
    return h('div', { class: 'card' },
      h('h2', {}, 'Trophées et classement'),
      h('div', { class: 'trophy-hero' }, trophy(r.tier, 84), h('div', {}, h('b', { class: 'trophy-name' }, r.tier === 'none' ? 'Pas encore de trophée' : `Trophée ${name}`), h('div', { class: 'small' }, r.next_tier ? `Prochain trophée : ${nextName}` : 'Niveau maximum'))),
      h('p', {}, r.next_tier ? `Encore ${fmtGNF(Math.max(0, Number(r.next_at) - Number(r.lifetime)))} de ventes livrées pour le trophée ${nextName}.` : 'Niveau maximum atteint, bravo !'),
      r.next_tier && progress(Math.round(((Number(r.lifetime) - Number(r.tier_from)) * 100) / Math.max(1, Number(r.next_at) - Number(r.tier_from)))),
      h('div', { class: 'list' }, r.tiers.map((t) => h('div', { class: 'list-item' },
        h('span', { class: Number(r.lifetime) >= Number(t.at) ? '' : 'locked' }, trophy(t.tier, 34)), ' ', h('div', { class: 'grow' }, `${TROPHY[t.tier].name} : ${fmtGNF(t.at)} de ventes livrées`),
        Number(r.lifetime) >= Number(t.at) ? badge('Obtenu', 'ok') : badge('À gagner', 'grey')))),
      h('p', { class: 'small muted' }, `Total livré à ce jour : ${fmtGNF(r.lifetime)}. Seules comptent les commandes livrées et encaissées de produits des fournisseurs : vos propres produits ne comptent pas.`),
      h('h3', {}, `Classement de ${month}`),
      r.hidden
        ? h('p', { class: 'muted' }, 'Vous êtes masqué du classement : personne ne voit votre nom et vous n\'y figurez pas.')
        : r.rank
          ? h('p', {}, `Vous êtes ${r.rank}${r.rank === 1 ? 'er' : 'e'} sur ${r.participants} · ${r.my_delivered} livraison(s) · ${fmtGNF(r.my_sales)}.`)
          : h('p', { class: 'muted' }, 'Aucune livraison ce mois-ci : une première livraison vous place dans le classement.'),
      r.top.length
        ? table(['Rang', 'Vendeur', 'Livraisons', 'Trophée'], r.top.map((t) => [t.rank, t.me ? `${t.name} (vous)` : t.name, t.delivered, t.tier === 'none' ? '–' : trophy(t.tier, 24)]))
        : null,
      h('p', { class: 'small muted mt' }, 'Les autres vendeurs ne voient jamais vos montants : seulement votre rang, votre prénom et l\'initiale de votre nom, votre nombre de livraisons et votre trophée.'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: toggle }, r.hidden ? 'Réapparaître dans le classement' : 'Me retirer du classement'));
  });
}

function progress(percent) {
  const fill = h('span', { class: 'bar-f' });
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return h('div', { class: 'bars' }, h('div', { class: 'bar-row' }, h('span', { class: 'bar-t' }, fill), h('span', { class: 'bar-v' }, `${Math.max(0, Math.min(100, percent))} %`)));
}
