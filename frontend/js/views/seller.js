// Espace vendeur : le fournisseur n'apparaît jamais ici.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, statusBadge, amount, action, kv, empty, toast, confirmBox, badge, telLink, waLink, newRequestKey, pickupText, photoStrip, zoneOptions, zoneHint, CHANNEL_LABEL, table } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const RESULT = { confirmed: ['Confirmée', 'ok'], unreachable: ['Injoignable', 'warn'], refused: ['Refusée', 'bad'] };

export function sellerOrders({ goTo } = {}) {
  let filter = '';
  const host = h('div');
  const FILTERS = [['', 'Toutes'], ['new', 'Nouvelles'], ['confirmed', 'Confirmées'], ['on_the_way', 'En route'], ['delivered', 'Livrées'], ['failed', 'Échecs']];
  const chips = h('div', { class: 'chips' }, FILTERS.map(([v, l]) => h('button', { class: 'chip', 'aria-pressed': String(v === filter), onclick: (e) => {
    filter = v; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); load(); } }, l)));
  function load() {
    host.replaceChildren(liveView(() => get(`/seller/orders${filter ? `?status=${filter}` : ''}`), ({ orders }, refresh) => orders.length ? h('div', {}, orders.map((o) => orderCard(o, refresh))) : empty('📦', 'Aucune commande pour le moment'), { poll: 20000 }));
  }
  load();
  return h('div', {}, h('h1', {}, 'Mes commandes'), startCard(goTo), chips, host);
}

function orderCard(o, refresh) {
  const showDetail = async () => {
    const d = await get(`/seller/orders/${o.id}`).catch((e) => { toast(e.message, 'bad'); return null; });
    if (!d) return;
    const box = h('div', {},
      h('h3', {}, 'Appels du call center'),
      d.calls.length ? d.calls.map((c) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('b', {}, `Appel ${c.call_center || 'du call center'}`), h('div', { class: 'small muted' }, fmtDate(c.at), c.note ? ` · ${c.note}` : '')), badge(...RESULT[c.result]))) : h('p', { class: 'muted' }, 'Pas encore appelé.'),
      h('h3', { class: 'mt' }, 'Suivi'),
      h('ul', { class: 'timeline' }, d.history.map((x) => h('li', {}, statusBadge(x.to_status), ' ', h('span', { class: 'small muted' }, fmtDate(x.at), x.note ? ` · ${x.note}` : '')))));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      h('div', { class: 'modal' }, h('h2', {}, `Commande ${o.ref}`), box, h('button', { class: 'btn btn-ghost btn-block mt', onclick: () => overlay.remove() }, 'Fermer')));
    document.body.append(overlay);
  };
  const cancel = action(async () => { if (await confirmBox('Annuler cette commande ?', 'Elle n\'a pas encore été appelée.', 'Oui, annuler', true)) { await post(`/seller/orders/${o.id}/cancel`); } },
    { ok: 'Commande annulée', refresh });
  const trackUrl = `${location.origin}/#/suivi/${o.track_token}`;
  const copyTrack = async () => { try { await navigator.clipboard.writeText(trackUrl); toast('Lien de suivi copié', 'ok'); } catch { toast(trackUrl, 'ok'); } };
  return h('div', { class: `card order ${o.risk_flag ? 'risk' : ''}` },
    h('div', { class: 'order-head' }, h('span', { class: 'ref' }, o.ref), statusBadge(o.status), o.risk_flag && badge('Client à risque', 'bad'), o.formula === 'C' && badge('Produit propre', 'grey'), o.channel && badge(CHANNEL_LABEL[o.channel] || o.channel, 'grey'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, fmtDate(o.created_at))),
    o.risk_flag && o.status !== 'delivered' && h('div', { class: 'notice bad' }, h('b', {}, icon('alert', 16), ' Client à risque. '), `Ce numéro a déjà eu ${o.risk_incidents || 1} commande(s) non aboutie(s) sur Wallindirain. Prévenez-le que le paiement à la livraison est obligatoire.`),
    kv([['Produit', `${o.product_name} × ${o.qty}`], ['Client', h('span', { class: 'gap' }, `${o.customer_name} · `, telLink(o.customer_phone), waLink(o.customer_phone, `Bonjour ${o.customer_name}, c'est votre vendeur. Suivez votre commande ${o.ref} ici : ${trackUrl}`))], ['Colis à récupérer', pickupText(o)], ['Livraison', `${o.commune}, ${o.address}`],
      ['Total client', amount(o.sale_total)], [o.status === 'delivered' ? 'Votre gain' : 'Gain attendu', amount(o.expected_gain), 'key'],
      o.failure_reason && ['Dernier échec', o.failure_reason]]),
    h('div', { class: 'gap mt actions' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: showDetail }, 'Appels et suivi'), h('button', { class: 'btn btn-sm btn-ghost', onclick: copyTrack }, 'Copier le lien de suivi client'), o.cancellable && h('button', { class: 'btn btn-sm btn-ghost', onclick: cancel }, 'Annuler')));
}

let catFilter = '';   // rayon choisi (gardé tant que la page reste ouverte)
export function sellerCatalog() {
  return liveView(() => get('/seller/catalog'), ({ products, categories = [], call_fee, max_delivery_fee }, refresh) => {
    if (!products.length) return h('div', {}, h('h1', {}, 'Catalogue'), empty('🛍️', 'Aucun produit validé pour le moment'));
    const shown = catFilter ? products.filter((p) => p.category_id === catFilter) : products;
    const sections = (catFilter ? categories.filter((c) => c.id === catFilter) : categories).map((c) => [c.name, shown.filter((p) => p.category_id === c.id)]).filter(([, l]) => l.length);
    const rest = shown.filter((p) => !categories.some((c) => c.id === p.category_id));
    if (rest.length) sections.push(['Autres', rest]);
    return h('div', {}, h('h1', {}, 'Catalogue'),
      h('div', { class: 'notice' }, `Votre prix de vente doit couvrir le prix vendeur, le call center (${fmtGNF(call_fee)}) et la livraison la plus chère (${fmtGNF(max_delivery_fee)}) : vous ne vendez jamais à perte.`),
      h('div', { class: 'chips mb' }, [['', 'Tous'], ...categories.filter((c) => products.some((p) => p.category_id === c.id)).map((c) => [c.id, c.name])].map(([id, name]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(catFilter === id), onclick: () => { catFilter = id; refresh(); } }, name))),
      sections.map(([title, list]) => h('div', { class: 'catalog-section' }, h('h2', { class: 'section-title' }, title), h('div', { class: 'grid g2' }, list.map((p) => {
        const setPrice = action(async () => {
          const v = await ask({ title: p.name, text: `Prix minimum autorisé : ${fmtGNF(p.min_price)}`, submit: 'Enregistrer', fields: [{ name: 'price', label: 'Votre prix de vente (GNF)', type: 'number', inputmode: 'numeric', value: p.sale_price || '' }] });
          if (v) await post('/seller/prices', { product_id: p.id, price: Number(v.price) });
        }, { ok: 'Prix enregistré', refresh });
        const link = action(async () => {
          const r = await post('/seller/links', { product_id: p.id });
          const url = `${location.origin}/#/c/${r.code}`;
          try { await navigator.clipboard.writeText(url); toast('Lien copié ! Partagez-le à vos clients.', 'ok'); } catch { await ask({ title: 'Votre lien', text: url, submit: 'OK', fields: [] }); }
          await refresh();
        });
        const buy = action(async () => {
          const v = await ask({ title: `Acheter du stock : ${p.name}`, text: `Prix vendeur : ${fmtGNF(p.vendor_price)} l'unité, payé à l'avance depuis votre portefeuille. Livraison plus rapide, gardé chez Wallindirain.`, submit: 'Acheter', fields: [{ name: 'qty', label: 'Quantité', type: 'number', inputmode: 'numeric' }] });
          if (v) { const r = await post('/seller/stock', { product_id: p.id, qty: Number(v.qty) }); toast(`Stock acheté : ${fmtGNF(r.cost)} débités`, 'ok'); }
        }, { refresh });
        return h('div', { class: 'card' }, h('h2', {}, p.name), photoStrip(p.image_ids, { size: 96 }), p.description && h('p', { class: 'muted small' }, p.description),
          kv([['Prix vendeur', amount(p.vendor_price)], ['Prix minimum', amount(p.min_price)], ['Votre prix', p.sale_price ? amount(p.sale_price) : badge('à fixer', 'warn')], ['Disponible', p.available], p.my_stock > 0 && ['Votre stock prépayé', p.my_stock]]),
          h('div', { class: 'gap mt' }, h('button', { class: 'btn btn-sm', onclick: setPrice }, p.sale_price ? 'Changer mon prix' : 'Fixer mon prix'),
            p.sale_price && h('button', { class: 'btn btn-sm btn-gold', onclick: link }, p.link_code ? 'Copier mon lien' : 'Créer mon lien'),
            p.can_prepay && h('button', { class: 'btn btn-sm btn-ghost', onclick: buy }, 'Acheter du stock')));
      })))));
  });
}

export function sellerNewOrder({ goTo }) {
  const host = h('div', {}, h('div', { class: 'spinner' }));
  Promise.all([get('/seller/catalog'), get('/public/info'), get('/seller/deposits').catch(() => ({ deposits: [] }))]).then(([cat, info, dep]) => {
    const stored = dep.deposits.filter((d) => d.status === 'stored' && d.free_qty > 0);
    const depositSel = h('select', {}, h('option', { value: '' }, 'Non : il est chez moi'), stored.map((d) => h('option', { value: d.id }, `${d.name} · ${d.free_qty} disponible(s)`)));
    const depositBox = stored.length ? h('label', { class: 'f' }, h('span', {}, 'Sortir du stock gardé chez Wallindirain ?'), depositSel, h('div', { class: 'hint' }, 'Si oui, le livreur récupère le colis à l\'entrepôt : inutile d\'indiquer une adresse.')) : null;
    const own = h('input', { type: 'checkbox' });
    const product = h('select', {}, cat.products.map((p) => h('option', { value: p.id }, `${p.name}${p.sale_price ? ` · ${fmtGNF(p.sale_price)}` : ' · prix à fixer'}`)));
    const ownName = h('input', { type: 'text', maxlength: 120, placeholder: 'Nom de votre produit' });
    const price = h('input', { type: 'number', inputmode: 'numeric', min: 1 });
    const qty = h('input', { type: 'number', min: 1, max: 100, value: 1, required: true });
    const cname = h('input', { type: 'text', required: true, maxlength: 100 });
    const cphone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX' });
    const commune = h('select', { required: true }, zoneOptions(info.communes));
    const communeHint = zoneHint(commune);
    const addr = h('textarea', { required: true, maxlength: 300, placeholder: 'Rue, repère connu (pharmacie, mosquée, marché…)' });
    const already = h('input', { type: 'checkbox' });
    const note = h('input', { type: 'text', maxlength: 300 });
    const channel = h('select', {}, h('option', { value: '' }, 'Non précisé'), Object.entries(CHANNEL_LABEL).filter(([k]) => k !== 'unknown').map(([k, l]) => h('option', { value: k }, l)));
    const channelBox = info.features?.order_channel ? h('label', { class: 'f' }, h('span', {}, 'D\'où vient cette commande ?'), channel) : null;
    const pickup = h('input', { type: 'text', maxlength: 200, placeholder: 'Quartier, repère, téléphone sur place' });
    const ownBox = h('div', { class: 'hidden' }, depositBox, h('label', { class: 'f' }, h('span', {}, 'Nom du produit'), ownName), h('label', { class: 'f' }, h('span', {}, 'Où récupérer le colis ?'), pickup, h('div', { class: 'hint' }, 'Le livreur passera prendre le colis à cet endroit.')), h('label', { class: 'f' }, h('span', {}, 'Prix de vente unitaire (GNF)'), price,
      h('div', { class: 'hint' }, `Doit couvrir au moins la livraison et le call center.`)));
    const catBox = h('label', { class: 'f' }, h('span', {}, 'Produit du catalogue'), product);
    own.addEventListener('change', () => { ownBox.classList.toggle('hidden', !own.checked); catBox.classList.toggle('hidden', own.checked); });
    const requestKey = newRequestKey();      // une clé par ouverture du formulaire : un envoi répété renvoie la même commande
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const body = { request_key: requestKey, qty: Number(qty.value), customer_name: cname.value, customer_phone: cphone.value, commune: commune.value, address: addr.value, note: note.value, already_confirmed: already.checked, channel: channel.value || undefined };
        if (own.checked) { body.own_product_name = ownName.value || 'Produit'; body.pickup_detail = pickup.value || 'Entrepôt Wallindirain'; body.unit_price = Number(price.value); if (depositSel.value) body.deposit_id = depositSel.value; } else body.product_id = product.value;
        const r = await post('/seller/orders', body);
        if (r.replayed) { toast(`Commande ${r.ref} déjà enregistrée : aucune seconde commande n'a été créée`, 'ok'); goTo('orders'); return; }
        toast(`Commande ${r.ref} créée${r.status === 'confirmed' ? ' : prête à être affectée à un livreur' : r.risk ? ' (client à surveiller)' : ''}`, 'ok'); goTo('orders');
      } catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
    } },
      h('label', { class: 'f' }, h('span', {}, 'Type de produit'), h('div', { class: 'gap' }, own, h('span', {}, 'Mon propre produit (hors catalogue)'))),
      catBox, ownBox, h('label', { class: 'f' }, h('span', {}, 'Quantité'), qty),
      h('h2', { class: 'mt' }, 'Client'), h('label', { class: 'f' }, h('span', {}, 'Nom'), cname), h('label', { class: 'f' }, h('span', {}, 'Téléphone'), cphone),
      h('label', { class: 'f' }, h('span', {}, 'Quartier ou ville'), commune, communeHint), h('label', { class: 'f' }, h('span', {}, 'Adresse'), addr), h('label', { class: 'f' }, h('span', {}, 'Note pour le call center (facultatif)'), note), channelBox,
      h('label', { class: 'f check' }, already, h('span', {}, h('b', {}, 'J\'ai déjà appelé ce client et il a confirmé.'), h('div', { class: 'hint' }, 'Cochée : la commande ne passe pas par le call center (pas de frais d\'appel) et va directement à l\'affectation au livreur. Ne cochez que si le client a vraiment confirmé.'))),
      h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Créer la commande'));
    host.replaceChildren(h('h1', {}, 'Nouvelle commande'), h('div', { class: 'card' }, form), importCard());
  }).catch((e) => host.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  return host;
}

/** Import des commandes depuis un Google Sheet (partagé en lecture) ou un tableau collé en CSV. */
function importCard() {
  const out = h('div', { role: 'status' });
  const url = h('input', { type: 'url', placeholder: 'https://docs.google.com/spreadsheets/d/…', maxlength: 300, 'aria-label': 'Lien de votre Google Sheet' });
  const csv = h('textarea', { rows: 4, placeholder: 'Ou collez ici votre tableau (copié depuis Excel / Sheets)', 'aria-label': 'Tableau collé en CSV' });
  get('/seller/sheet').then((r) => { if (r.sheet) url.value = r.sheet.url; }).catch(() => {});
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,.txt', 'aria-label': 'Fichier Excel ou CSV' });
  const csvQuote = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const downloadRejected = (errors) => {
    const head = ['ligne', 'nom', 'téléphone', 'quartier', 'adresse', 'produit', 'quantité', 'prix', 'confirmé', 'note', 'motif du rejet'];
    const lines = errors.map((e) => [e.line, e.row?.name, e.row?.phone, e.row?.zone, e.row?.address, e.row?.product, e.row?.qty, e.row?.price, e.row?.confirmed, e.row?.note, e.message].map(csvQuote).join(','));
    const url = URL.createObjectURL(new Blob(['\ufeff' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: 'lignes-rejetees.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const rejectedBlock = (errors) => errors.length > 0 && h('div', { class: 'mt' }, ...errors.slice(0, 30).map((e) => h('div', { class: 'small' }, `Ligne ${e.line} : ${e.message}`)),
    h('button', { class: 'btn btn-sm btn-ghost mt', type: 'button', onclick: () => downloadRejected(errors) }, 'Télécharger les lignes rejetées'));
  const show = (r) => out.replaceChildren(
    h('div', { class: r.errors.length ? 'notice warn' : 'notice ok' }, `${r.created} commande(s) créée(s), ${r.duplicates} déjà importée(s), ${r.errors.length} ligne(s) rejetée(s).`),
    rejectedBlock(r.errors));
  const STATUS = { ok: ['À créer', 'ok'], duplicate: ['Déjà importée', 'grey'], error: ['Rejetée', 'bad'] };
  const showPreview = (r, body) => out.replaceChildren(
    h('div', { class: r.errors.length ? 'notice warn' : 'notice ok' }, `Aperçu : ${r.created} commande(s) à créer, ${r.duplicates} déjà importée(s), ${r.errors.length} ligne(s) rejetée(s). Rien n'est encore créé.`),
    table(['Ligne', 'Client', 'Produit', 'Statut'], r.preview.map((x) => [x.line, x.name, `${x.product || '—'}${x.qty ? ` × ${x.qty}` : ''}`, x.status === 'error' ? h('span', {}, badge('Rejetée', 'bad'), h('div', { class: 'small muted' }, x.message)) : badge(...STATUS[x.status])])),
    r.created > 0 ? h('button', { class: 'btn btn-gold mt', type: 'button', onclick: action(async () => { show(await post('/seller/import', body)); }, {}) }, `Importer ${r.created} commande(s)`) : h('p', { class: 'small muted mt' }, 'Aucune commande à créer. Corrigez votre tableau puis refaites un aperçu.'),
    rejectedBlock(r.errors));
  const toBase64 = (buf) => { let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
  const save = action(async () => { await post('/seller/sheet', { url: url.value.trim() }); }, { ok: 'Lien enregistré' });
  // L'état de l'import reste affiché dans la page (et pas seulement en petit message qui disparaît)
  const run = action(async () => {
    out.replaceChildren(h('div', { class: 'notice' }, 'Lecture en cours… un Google Sheet peut prendre jusqu\'à 30 secondes.'));
    try {
      let body;
      const f = file.files?.[0];
      if (f) {
        if (f.size > 550_000) throw new Error('Fichier trop volumineux (550 Ko maximum).');
        body = /\.xlsx$/i.test(f.name) ? { xlsx: toBase64(await f.arrayBuffer()) } : { csv: await f.text() };
      } else if (csv.value.trim()) body = { csv: csv.value };
      else {
        if (!url.value.trim()) throw new Error('Choisissez un fichier, collez votre tableau, ou collez le lien de votre Google Sheet.');
        await post('/seller/sheet', { url: url.value.trim() });   // le lien collé est enregistré automatiquement
        body = {};
      }
      showPreview(await post('/seller/import', { ...body, dry_run: true }), body);
    } catch (e) { out.replaceChildren(h('div', { class: 'notice bad' }, e?.message || 'La lecture a échoué. Réessayez.')); }
  }, {});
  const MODEL = 'nom\ttéléphone\tquartier\tadresse\tproduit\tquantité\tprix\tconfirmé\nMamadou Diallo\t620000001\tRatoma\tPrès du marché\tMontre\t1\t150000\toui';
  const copyModel = async () => { try { await navigator.clipboard.writeText(MODEL); toast('Modèle copié : collez-le dans la case A1 de votre Google Sheet', 'ok'); } catch { csv.value = MODEL.replace(/\t/g, ','); toast('Modèle placé dans la case « tableau collé » ci-dessous', 'ok'); } };
  return h('div', { class: 'card' }, h('h2', {}, 'Importer des commandes (Excel, CSV ou Google Sheet)'),
    h('p', { class: 'small muted' }, 'Une ligne = une commande. En-têtes attendus : nom, téléphone, quartier ou ville, adresse, produit, quantité, prix, confirmé (oui/non). Un produit qui n\'est pas dans le catalogue est traité comme votre propre produit (le prix est alors obligatoire). Les lignes déjà importées sont ignorées.'),
    h('p', { class: 'small muted' }, 'Votre Google Sheet doit être partagé avec « Toute personne disposant du lien » en lecture seule.'),
    h('label', { class: 'f' }, h('span', {}, 'Lien de votre Google Sheet'), url),
    h('div', { class: 'gap' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: save }, 'Enregistrer le lien'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: copyModel }, 'Copier le modèle')),
    h('p', { class: 'small muted' }, 'Pas sûr des colonnes ? « Copier le modèle », puis collez-le dans la case A1 de votre Google Sheet : les titres sont sur la ligne 1 et vos commandes à partir de la ligne 2.'),
    h('label', { class: 'f mt' }, h('span', {}, 'Ou un fichier Excel (.xlsx) ou CSV'), file),
    h('label', { class: 'f mt' }, h('span', {}, 'Ou tableau collé (CSV)'), csv),
    h('button', { class: 'btn btn-gold mt', type: 'button', onclick: run }, 'Voir l\'aperçu avant d\'importer'), out);
}

const STEPS = [
  ['identity', 'Faire vérifier mon identité', 'profile'],
  ['payout', 'Indiquer mon numéro Orange / MTN pour les retraits', 'profile'],
  ['price', 'Fixer mon prix de vente sur un produit', 'catalog'],
  ['link', 'Créer mon lien de vente et le partager', 'catalog'],
  ['order', 'Recevoir ou saisir ma première commande', 'new'],
];

/** Liste « pour bien démarrer » : disparaît quand tout est fait. */
export function startCard(goTo) {
  const host = h('div');
  get('/seller/start').then(({ steps, complete }) => {
    if (complete) return;
    const done = STEPS.filter(([k]) => steps[k]).length;
    host.replaceChildren(h('div', { class: 'card' },
      h('h3', {}, `Pour bien démarrer (${done}/${STEPS.length})`),
      STEPS.map(([k, label, to]) => h('div', { class: 'list-item' },
        h('span', { class: steps[k] ? 'step-done' : 'step-todo' }, icon(steps[k] ? 'checkCircle' : 'clock', 20)),
        h('div', { class: 'grow' }, label),
        !steps[k] && goTo && h('button', { class: 'btn btn-ghost', onclick: () => goTo(to) }, 'Y aller'))),
      h('button', { class: 'btn btn-ghost mt', onclick: showGuide }, icon('book', 18), 'Guide du vendeur')));
  }).catch(() => {});
  return host;
}

export function showGuide() {
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h('div', { class: 'modal' },
      h('h2', {}, 'Guide du vendeur'),
      h('h3', {}, '1. Choisir un produit'), h('p', {}, 'Dans Catalogue, choisissez un produit et fixez votre prix de vente. Votre gain = prix de vente − prix fournisseur − frais de livraison − commission.'),
      h('h3', {}, '2. Trouver des clients'), h('p', {}, 'Créez un lien de vente et partagez-le (WhatsApp, Facebook, TikTok). Le client remplit son nom, son téléphone et son quartier.'),
      h('h3', {}, '3. Le call center appelle'), h('p', {}, 'Chaque commande est confirmée par téléphone. Vous suivez les appels dans Commandes.'),
      h('h3', {}, '4. Livraison et paiement'), h('p', {}, 'Le livreur encaisse à la livraison. Votre gain arrive dans le Portefeuille après validation de la caisse.'),
      h('h3', {}, '5. Retirer votre argent'), h('p', {}, 'Dans Portefeuille, demandez un retrait vers votre numéro Orange ou MTN.'),
      h('button', { class: 'btn btn-ghost btn-block mt', onclick: () => overlay.remove() }, 'Fermer')));
  document.body.append(overlay);
}

/** Stock du vendeur gardé à l'entrepôt Wallindirain : annonce, comptage par le magasinier, quantités libres. */
export function sellerDeposits() {
  return liveView(() => get('/seller/deposits'), ({ deposits, storage_fee }, refresh) => {
    const announce = action(async () => {
      const v = await ask({ title: 'Envoyer du stock à Wallindirain', text: 'Annoncez ce que vous envoyez. Le magasinier le comptera à la réception : seul le nombre compté sera disponible pour vos commandes.', submit: 'Annoncer',
        fields: [{ name: 'name', label: 'Nom du produit', type: 'text', maxlength: 120 }, { name: 'qty', label: 'Quantité envoyée', type: 'number', inputmode: 'numeric', value: 1 }] });
      if (!v) return;
      await post('/seller/deposits', { name: v.name, qty: Number(v.qty) });
    }, { ok: 'Dépôt annoncé : le magasinier va le compter', refresh });
    return h('div', {}, h('h1', {}, 'Mon stock chez Wallindirain'),
      h('div', { class: 'notice' }, 'Ce stock reste à vous. Wallindirain le garde, et les livreurs le récupèrent à l\'entrepôt quand vous créez une commande avec « Mon propre produit ». Vos gains ne changent pas.',
        storage_fee > 0 ? ' Des frais de stockage sont prévus : ils vous seront annoncés avant toute facturation.' : ' Le stockage est gratuit pour le moment.'),
      h('button', { class: 'btn btn-gold btn-block mt', type: 'button', onclick: announce }, 'Envoyer du stock'),
      deposits.length ? deposits.map((d) => h('div', { class: 'card' },
        h('div', { class: 'order-head' }, h('h3', {}, d.name), d.status === 'stored' ? badge('Reçu', 'ok') : badge('En attente de comptage', 'warn')),
        kv(d.status === 'stored'
          ? [['Annoncé', d.announced_qty], ['Compté', d.qty], ['Réservé', d.reserved_qty], ['Disponible', d.free_qty, 'key'], d.count_note && ['Note de l\'entrepôt', d.count_note], ...(d.losses || []).map((l) => [`Retiré le ${fmtDate(l.at)}`, `${l.qty} unité(s) : ${l.note}`])]
          : [['Annoncé', d.announced_qty, 'key'], ['Date', fmtDate(d.created_at)]]),
        d.status === 'announced' && h('div', { class: 'mt' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: action(async () => { const v = await ask({ title: `Corriger : ${d.name}`, text: 'Possible tant que le magasinier n\'a pas compté le dépôt.', submit: 'Enregistrer', fields: [{ name: 'name', label: 'Nom du produit', value: d.name }, { name: 'qty', label: 'Quantité envoyée', type: 'number', inputmode: 'numeric', value: d.announced_qty }] }); if (v) await post(`/seller/deposits/${d.id}/edit`, { name: v.name, qty: Number(v.qty) }); }, { ok: 'Dépôt corrigé', refresh }) }, 'Corriger')))) : empty('📦', 'Aucun stock envoyé pour le moment'));
  });
}
