// Espace fournisseur : jamais de vendeur, de client ni de prix de vente.
import { h, ask, fmtDate, liveView, statusBadge, amount, action, kv, empty, badge, table, toast, photoStrip, confirmBox } from '../ui.js';
import { get, post } from '../api.js';

const PSTATUS = { pending: ['En attente de validation', 'warn'], approved: ['Validé', 'ok'], rejected: ['Refusé', 'bad'], archived: ['Archivé', 'grey'] };

export function supplierProducts() {
  return liveView(() => get('/supplier/products'), ({ products, arrivals }, refresh) => {
    const add = action(async () => {
      const v = await ask({ title: 'Proposer un produit', submit: 'Envoyer pour validation', fields: [
        { name: 'name', label: 'Nom du produit' }, { name: 'description', label: 'Description', type: 'textarea', required: false },
        { name: 'supplier_price', label: 'Votre prix par unité (GNF)', type: 'number', inputmode: 'numeric', hint: 'Le prix que vous recevez pour chaque produit livré.' },
        { name: 'storage', label: 'Stockage', type: 'select', options: [['wallindirain', 'Chez Wallindirain (recommandé : livraison plus rapide)'], ['supplier', 'Chez moi (je prépare les colis)']] },
        { name: 'stock_qty', label: 'Quantité en stock chez moi', type: 'number', required: false, hint: 'Seulement si le stock est chez vous.' },
        { name: 'pickup_detail', label: 'Où le livreur récupère le colis', required: false, hint: 'Seulement si le stock est chez vous : quartier, repère, téléphone sur place. Jamais montré aux vendeurs ni aux clients.' },
        { name: 'photo', type: 'image', label: 'Photo du produit', required: false, hint: 'Une bonne photo aide les vendeurs à vendre. Vous pourrez en ajouter jusqu\'à 4 ensuite. Évitez tout texte ou visage qui n\'a rien à voir avec le produit.' }] });
      if (!v) return;
      const created = await post('/supplier/products', { name: v.name, description: v.description, supplier_price: Number(v.supplier_price), storage: v.storage, stock_qty: Number(v.stock_qty || 0), pickup_detail: v.pickup_detail || undefined });
      let photoNote = '';
      if (v.photo) { try { await post(`/supplier/products/${created.id}/images`, { image: v.photo }); } catch (ex) { photoNote = ` La photo n'a pas pu être ajoutée (${ex.message}) : ajoutez-la depuis la fiche du produit.`; } }
      toast(created.message + photoNote, photoNote ? 'warn' : 'ok');
    }, { refresh });
    return h('div', {}, h('div', { class: 'gap mb' }, h('h1', { class: 'grow' }, 'Mes produits'), h('button', { class: 'btn btn-gold', onclick: add }, '+ Proposer un produit')),
      products.length ? h('div', { class: 'grid g2' }, products.map((p) => {
        const arrive = action(async () => { const v = await ask({ title: `Annoncer un arrivage : ${p.name}`, text: 'Le magasinier comptera les produits reçus. Seuls les produits comptés deviennent vendables.', submit: 'Annoncer', fields: [{ name: 'qty', label: 'Quantité envoyée', type: 'number', inputmode: 'numeric' }] }); if (v) await post(`/supplier/products/${p.id}/arrival`, { qty: Number(v.qty) }); }, { ok: 'Arrivage annoncé', refresh });
        const setStock = action(async () => { const v = await ask({ title: `Mon stock : ${p.name}`, text: `Déjà réservées : ${p.reserved_qty}`, submit: 'Enregistrer', fields: [{ name: 'qty', label: 'Quantité disponible chez moi', type: 'number', value: p.stock_qty }] }); if (v) await post(`/supplier/products/${p.id}/stock`, { qty: Number(v.qty) }); }, { ok: 'Stock mis à jour', refresh });
        const addPhoto = action(async () => {
          const v = await ask({ title: `Ajouter une photo : ${p.name}`, submit: 'Ajouter', fields: [{ name: 'photo', type: 'image', label: 'Photo du produit', hint: 'Photo nette, produit bien visible. 4 photos au maximum.' }] });
          if (v) await post(`/supplier/products/${p.id}/images`, { image: v.photo });
        }, { ok: 'Photo ajoutée', refresh });
        const delPhoto = (id) => action(async () => { if (await confirmBox('Supprimer cette photo ?', p.name, 'Supprimer', true)) { await post(`/supplier/images/${id}/delete`); return true; } }, { ok: (r) => (r ? 'Photo supprimée' : ''), refresh })();
        const setPickup = action(async () => { const v = await ask({ title: `Adresse de récupération : ${p.name}`, text: 'Où le livreur vient prendre le colis. Jamais montré aux vendeurs ni aux clients.', submit: 'Enregistrer', fields: [{ name: 'detail', label: 'Adresse', value: p.pickup_detail || '', required: false }] }); if (v) await post(`/supplier/products/${p.id}/pickup`, { detail: v.detail }); }, { ok: () => 'Adresse enregistrée', refresh });
        return h('div', { class: 'card' }, h('div', { class: 'order-head' }, h('h2', { class: 'grow' }, p.name), badge(...PSTATUS[p.status])), photoStrip(p.image_ids, { onDelete: delPhoto }), p.image_ids.length < 4 && h('button', { class: 'btn btn-sm btn-ghost', onclick: addPhoto }, p.image_ids.length ? 'Ajouter une photo' : 'Ajouter une photo (recommandé)'),
          kv([['Votre prix', amount(p.supplier_price), 'key'], ['Stockage', p.storage === 'wallindirain' ? 'Chez Wallindirain' : 'Chez vous'], p.storage === 'supplier' && ['Récupération du colis', p.pickup_detail || 'Adresse non indiquée'], ['En stock', p.stock_qty], ['Réservé', p.reserved_qty]]),
          p.status === 'approved' && h('div', { class: 'gap mt' }, p.storage === 'wallindirain' ? h('button', { class: 'btn btn-sm', onclick: arrive }, 'Annoncer un arrivage') : h('button', { class: 'btn btn-sm', onclick: setStock }, 'Mettre à jour mon stock'), p.storage === 'supplier' && h('button', { class: 'btn btn-sm btn-ghost', onclick: setPickup }, 'Adresse de récupération')));
      })) : empty('📦', 'Proposez votre premier produit'),
      arrivals.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Arrivages'), table(['Date', 'Produit', 'Annoncé', 'Compté'], arrivals.map((a) => [fmtDate(a.created_at), a.product_name, a.announced_qty, a.counted_qty ?? badge('en attente de comptage', 'warn')]))));
  });
}

export function supplierOrders() {
  return liveView(() => get('/supplier/orders'), ({ orders }) => h('div', {}, h('h1', {}, 'Colis'),
    h('div', { class: 'notice' }, 'Les colis sont identifiés uniquement par leur référence WLD. Préparez ceux marqués « à préparer » (stock chez vous).'),
    h('div', { class: 'card' }, table(['Référence', 'Produit', 'Quantité', 'À préparer', 'Statut', 'Date'], orders.map((o) => [h('b', {}, o.ref), o.product_name, o.qty, o.qty_to_prepare || '', statusBadge(o.status), fmtDate(o.created_at)]), { empty: empty('📭', 'Aucun colis pour le moment') }))), { poll: 30000 });
}
