// Proformas (migration 078) : devis du vendeur, sans effet sur le stock ni l'argent ; transformés en commande à la confirmation du client.
import { h, ask, fmtGNF, secret, fmtDate, liveView, action, table, badge, guide, pageHead, kv, toast, printNode, confirmBox } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '');
const STATUS = { open: ['Ouverte', 'info'], converted: ['Transformée en commande', 'ok'], cancelled: ['Annulée', 'grey'], expired: ['Expirée', 'warn'] };
const stBadge = (s) => badge(...(STATUS[s] || [s, 'grey']));

/** Document à imprimer ou envoyer au client (PDF via l'impression du téléphone). */
function proformaDoc(p, seller) {
  return h('div', { class: 'inv-doc' }, h('h1', {}, 'PROFORMA'), h('p', {}, `N° ${p.number}`),
    kv([['Date', day(p.created_at)], ['Valable jusqu\'au', day(p.valid_until)], ['Client', p.customer_name], ['Téléphone', p.customer_phone], ['Livraison', `${p.address}, ${p.commune}`], ['Vendeur', seller]]),
    h('table', { class: 'inv-lines' }, h('thead', {}, h('tr', {}, ['Désignation', 'Quantité', 'Prix unitaire', 'Total'].map((x) => h('th', {}, x)))),
      h('tbody', {}, h('tr', {}, h('td', {}, p.product), h('td', {}, String(p.qty)), h('td', {}, fmtGNF(p.unit_price)), h('td', {}, fmtGNF(p.total))))),
    h('p', {}, h('b', {}, `Total : ${fmtGNF(p.total)}`)), p.note ? h('p', {}, p.note) : null,
    h('p', { class: 'hint' }, 'Ce document est un devis : il ne vaut ni facture ni commande. Le paiement se fait à la livraison.'));
}

export function sellerProformas({ goTo, user } = {}) {
  return liveView(() => Promise.all([get('/seller/proformas'), get('/seller/catalog')]), ([{ enabled, proformas }, { products }], refresh) => {
    if (!enabled) return h('div', {}, pageHead('Proformas', ''), guide('book', 'Devis', 'Fonction non activée', 'L\'administration n\'a pas encore activé les proformas.'));
    const sellable = products.filter((p) => p.sale_price);
    const create = action(async () => {
      if (!sellable.length) { toast('Fixez d\'abord votre prix sur un produit du catalogue', 'bad'); return null; }
      const v = await ask({ title: 'Nouvelle proforma', text: 'Un devis pour votre client. Il ne réserve pas de stock et ne crée aucune commande.', submit: 'Créer', fields: [
        { name: 'product_id', label: 'Produit', type: 'select', options: sellable.map((p) => [p.id, `${p.name} (${fmtGNF(p.sale_price)})`]) },
        { name: 'qty', label: 'Quantité', type: 'number', inputmode: 'numeric', value: 1 },
        { name: 'customer_name', label: 'Nom du client ou de l\'entreprise' }, { name: 'customer_phone', label: 'Téléphone du client', inputmode: 'tel' },
        { name: 'commune', label: 'Quartier ou ville' }, { name: 'address', label: 'Adresse de livraison' },
        { name: 'days', label: 'Valable (jours)', type: 'number', inputmode: 'numeric', value: 15 }, { name: 'note', label: 'Note (facultatif)', required: false }] });
      if (!v) return null;
      const prod = sellable.find((p) => p.id === v.product_id);
      return post('/seller/proformas', { ...v, qty: Number(v.qty), days: Number(v.days), unit_price: prod.sale_price });
    }, { ok: 'Proforma créée', refresh });
    return h('div', {}, pageHead('Proformas', 'Devis pour vos clients, transformables en commande.'),
      h('div', { class: 'gap wrap' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: create }, [icon('plus', 16), ' Nouvelle proforma'])),
      proformas.length === 0
        ? guide('book', 'Vos devis, bien organisés', 'Votre première proforma commence ici', 'Créez un devis pour un client, envoyez-le en PDF, puis transformez-le en commande quand il confirme. Rien n\'est réservé avant.')
        : h('div', {}, proformas.map((p) => h('div', { class: 'card mt' },
            h('div', { class: 'row-top' }, h('b', { class: 'grow' }, p.number), stBadge(p.status)),
            kv([['Client', `${p.customer_name} · ${p.customer_phone}`], ['Produit', `${p.product} × ${p.qty}`], ['Total', secret(fmtGNF(p.total)), 'key'], ['Valable jusqu\'au', day(p.valid_until)], p.order_ref ? ['Commande', p.order_ref] : null]),
            h('div', { class: 'gap wrap mt' },
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => printNode(proformaDoc(p, user?.name || ''), { invoice: true }) }, 'Imprimer / PDF'),
              p.status === 'open' && h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: action(async () => {
                if (!(await confirmBox('Transformer en commande ?', 'Le client a confirmé : la commande sera créée et suivie comme les autres.', 'Créer la commande'))) return null;
                return post(`/seller/proformas/${p.id}/convert`, {});
              }, { ok: 'Commande créée', refresh }) }, 'Transformer en commande'),
              p.status === 'open' && h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => {
                if (!(await confirmBox('Annuler cette proforma ?', 'Elle ne pourra plus être transformée.', 'Annuler la proforma', true))) return null;
                return post(`/seller/proformas/${p.id}/cancel`, {});
              }, { ok: 'Proforma annulée', refresh }) }, 'Annuler'))))));
  });
}

export function adminProformas() {
  return liveView(() => get('/admin/proformas'), ({ enabled, totals, proformas }) => h('div', {},
    pageHead('Proformas', 'Devis des vendeurs (lecture seule).'),
    !enabled && h('div', { class: 'notice' }, 'Fonction éteinte : activez-la dans Réglages > Fonctions.'),
    kv([['Ouvertes', String(totals.open)], ['Transformées en commande', String(totals.converted)], ['Annulées ou expirées', String(totals.cancelled_or_expired)]]),
    table(['N°', 'Vendeur', 'Client', 'Produit', 'Total', 'Statut', 'Date'], proformas.map((p) => [p.number, p.seller, p.customer_name, `${p.product} × ${p.qty}`, secret(fmtGNF(p.total)), stBadge(p.status), fmtDate(p.created_at)]),
      { empty: guide('book', 'Devis des vendeurs', 'Aucune proforma', 'Les devis créés par les vendeurs apparaîtront ici.') })));
}
