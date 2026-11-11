// Boutique : vendre en deux touches, produits et stock, clôture de caisse.
import { h, ask, confirmBox, action, toast, errToast, empty, badge, liveView, fmtGNF } from '../ui.js';
import { get, post } from '../api.js';
import { postOffline, warmCache } from '../offline.js';
import { icon } from '../icons.js';

const today = () => new Date().toISOString().slice(0, 10);
const pct = (m, p) => (p > 0 ? `${Math.round((m * 100) / p)} %` : '—');

export function shopScreen({ go, head, card }) {
  let tab = 'sell'; let cart = new Map(); // item_id -> qty
  const host = h('div', {});
  const render = (d, refresh) => {
    const items = d.items.filter((i) => !i.archived_at);
    const byId = new Map(items.map((i) => [i.id, i]));
    const pro = d.tier === 'pro';
    const paint = () => render(d, refresh);
    const cartTotal = () => [...cart].reduce((n, [id, q]) => n + (byId.get(id)?.price || 0) * q, 0);
    const cartCount = () => [...cart.values()].reduce((n, q) => n + q, 0);
    const gnfAccounts = async () => (await get('/pf/accounts')).accounts.filter((a) => !a.archived_at && !a.auto && (!a.currency || a.currency === 'GNF') && a.writable !== false);

    const add = (i) => { const q = (cart.get(i.id) || 0) + 1; if (i.stock != null && q > i.stock) { toast(`Il n'en reste que ${i.stock}.`, 'bad'); return; } cart.set(i.id, q); paint(); };
    const less = (i) => { const q = (cart.get(i.id) || 0) - 1; if (q <= 0) cart.delete(i.id); else cart.set(i.id, q); paint(); };

    const checkout = action(async () => {
      const accs = await gnfAccounts();
      if (!accs.length) { toast('Créez d\'abord un compte en GNF (caisse, Orange Money…).', 'bad'); return false; }
      const v = await ask({ title: `Encaisser ${fmtGNF(cartTotal())}`, text: [...cart].map(([id, q]) => `${q}× ${byId.get(id)?.name}`).join(', '), submit: 'Encaisser', fields: [{ name: 'account_id', label: 'Argent reçu sur', type: 'select', options: accs.map((a) => [a.id, a.name]), value: accs[0].id }] });
      if (!v) return false;
      const r = await postOffline('/pf/shop/sales', { account_id: v.account_id, occurred_on: today(), lines: [...cart].map(([item_id, qty]) => ({ item_id, qty })) }, `Vente ${fmtGNF(cartTotal())}`);
      cart = new Map(); return r;
    }, { ok: (r) => (r === false ? '' : r.queued ? 'Pas de réseau : vente gardée sur votre téléphone, envoyée dès que le réseau revient.' : `Vente enregistrée : ${fmtGNF(r.total)}`), refresh });

    const askItem = async (i) => {
      const v = await ask({ title: i ? 'Modifier le produit' : 'Nouveau produit', submit: 'Enregistrer', fields: [
        { name: 'name', label: 'Nom du produit', maxlength: 80, value: i?.name || '' },
        { name: 'price', label: 'Prix de vente (GNF)', type: 'number', inputmode: 'numeric', value: i?.price || '' },
        { name: 'cost', label: 'Prix d\'achat (GNF) : pour connaître votre bénéfice', type: 'number', inputmode: 'numeric', required: false, value: i?.cost ?? '' },
        { name: 'stock', label: 'Quantité en stock (laissez vide si vous ne comptez pas)', type: 'number', inputmode: 'numeric', required: false, value: i?.stock ?? '' },
        { name: 'low_stock', label: 'Prévenez-moi quand il en reste…', type: 'number', inputmode: 'numeric', required: false, value: i?.low_stock || '' }] });
      if (!v) return false;
      await post('/pf/shop/items', { id: i?.id, name: v.name, price: Math.round(Number(v.price)), cost: Math.round(Number(v.cost || 0)), stock: v.stock === '' ? null : Math.round(Number(v.stock)), low_stock: Math.round(Number(v.low_stock || 0)) });
      return true;
    };
    const restock = async (i) => {
      const accs = await gnfAccounts();
      const v = await ask({ title: `Réapprovisionner ${i.name}`, text: 'Le stock augmente. Choisissez un compte pour noter aussi la dépense d\'achat.', submit: 'Ajouter au stock', fields: [
        { name: 'qty', label: 'Quantité reçue', type: 'number', inputmode: 'numeric' },
        { name: 'unit_cost', label: 'Prix d\'achat unitaire (GNF)', type: 'number', inputmode: 'numeric', required: false, value: i.cost || '' },
        { name: 'account_id', label: 'Payé avec', type: 'select', required: false, options: [['', 'Ne pas noter la dépense'], ...accs.map((a) => [a.id, a.name])], value: '' }] });
      if (!v) return false;
      await post(`/pf/shop/items/${i.id}/restock`, { qty: Math.round(Number(v.qty)), unit_cost: v.unit_cost === '' ? null : Math.round(Number(v.unit_cost)), account_id: v.account_id || undefined });
      return true;
    };
    const run = (fn, ok) => action(fn, { ok: (r) => (r === false ? '' : ok), refresh });
    const voidSale = (s) => action(async () => { if (await confirmBox('Annuler cette vente ?', 'L\'argent est retiré du compte et les produits remis en stock.', 'Annuler la vente', true)) await post(`/pf/shop/sales/${s.id}/void`); }, { ok: 'Vente annulée', refresh });

    const summary = card(null, h('div', { class: 'pf-sum' }, [['Ventes du jour', fmtGNF(d.today.total)], ['Bénéfice', fmtGNF(d.today.margin)], ['Nombre', String(d.today.count)]].map(([l, n]) => h('div', {}, h('small', {}, l), h('b', {}, n)))));
    const sell = () => [summary,
      items.length === 0 ? empty('bag', 'Ajoutez vos produits (onglet Produits) pour vendre en deux touches.') : h('div', { class: 'shop-grid' }, items.map((i) => {
        const q = cart.get(i.id) || 0; const out = i.stock != null && i.stock <= 0;
        return h('div', { class: `shop-tile${q ? ' on' : ''}${out ? ' out' : ''}` },
          h('button', { class: 'shop-add', type: 'button', disabled: out, onclick: () => add(i), 'aria-label': `Ajouter ${i.name}` }, h('b', {}, i.name), h('span', {}, fmtGNF(i.price)), i.stock != null && h('small', {}, out ? 'Épuisé' : `Stock : ${i.stock}`)),
          q > 0 && h('div', { class: 'shop-qty' }, h('button', { type: 'button', onclick: () => less(i), 'aria-label': 'Retirer un' }, '−'), h('b', {}, String(q)), h('button', { type: 'button', onclick: () => add(i), 'aria-label': 'Ajouter un' }, '+')));
      })),
      d.sales.length > 0 && h('h3', { class: 'pf-sub' }, 'VENTES DU JOUR'),
      d.sales.length > 0 && h('section', { class: 'pf-card flush' }, d.sales.map((s) => h('div', { class: 'pf-row' }, h('span', { class: 'pf-row-main' }, h('b', {}, (s.lines || []).map((l) => `${l.qty}× ${l.name}`).join(', ')), h('span', { class: 'pf-amt pos' }, fmtGNF(s.total)),
        h('small', {}, `${new Date(s.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${s.account_name}`)), h('button', { class: 'pf-mini', type: 'button', onclick: voidSale(s) }, 'Annuler'))))];
    const products = () => [d.low_stock > 0 && h('p', { class: 'pf-note warn' }, `${d.low_stock} produit(s) bientôt en rupture.`),
      h('section', { class: 'pf-card flush' }, d.items.length === 0 ? [h('p', { class: 'pf-note' }, 'Aucun produit pour le moment.')] : d.items.map((i) => h('div', { class: `pf-emp${i.archived_at ? ' dim' : ''}` },
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-row-main' }, h('b', {}, i.name), h('span', { class: 'pf-amt' }, fmtGNF(i.price)),
          h('small', {}, [i.cost > 0 ? `Marge ${fmtGNF(i.price - i.cost)} (${pct(i.price - i.cost, i.price)})` : 'Prix d\'achat non indiqué', i.stock != null ? `Stock : ${i.stock}` : 'Stock non suivi', i.stock != null && i.stock <= i.low_stock && !i.archived_at && 'à racheter', i.archived_at && 'archivé'].filter(Boolean).join(' · ')))),
        h('div', { class: 'pf-emp-actions' }, !i.archived_at && h('button', { class: 'btn btn-gold btn-sm', type: 'button', onclick: run(() => restock(i), 'Stock mis à jour') }, 'Réapprovisionner'),
          !i.archived_at && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: run(() => askItem(i), 'Produit modifié') }, 'Modifier'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: action(async () => { await post(`/pf/shop/items/${i.id}/archive`, { archived: !i.archived_at }); }, { ok: i.archived_at ? 'Produit rétabli' : 'Produit archivé', refresh }) }, i.archived_at ? 'Rétablir' : 'Archiver'))))),
      h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: run(() => askItem(null), 'Produit ajouté') }, 'Ajouter un produit')];
    const cash = () => { const box = h('div', {}); get('/pf/accounts').then(async (a) => {
        const accs = a.accounts.filter((x) => !x.archived_at && !x.auto && (!x.currency || x.currency === 'GNF'));
        const closes = (await get('/pf/shop/closes')).closes;
        if (!accs.length) { box.replaceChildren(empty('bank', 'Créez d\'abord un compte en GNF.')); return; }
        const sel = h('select', { class: 'pf-entry-sel pf-tools-sel', 'aria-label': 'Compte' }, accs.map((x) => h('option', { value: x.id }, x.name)));
        const counted = h('input', { class: 'pf-entry-sel', type: 'number', inputmode: 'numeric', placeholder: 'Montant compté', 'aria-label': 'Montant compté' });
        const out = h('p', { class: 'pf-note' }, '');
        const save = action(async () => {
          if (counted.value === '') { toast('Saisissez le montant compté.', 'bad'); return false; }
          const r = await post('/pf/shop/close', { account_id: sel.value, counted: Math.round(Number(counted.value)) });
          out.textContent = r.diff === 0 ? `Caisse juste : ${fmtGNF(r.expected)}.` : `Attendu ${fmtGNF(r.expected)} · compté ${fmtGNF(r.counted)} · écart ${r.diff > 0 ? '+' : '−'}${fmtGNF(Math.abs(r.diff))}.`;
          return r;
        }, { ok: (r) => (r === false ? '' : 'Clôture enregistrée'), refresh: null });
        box.replaceChildren(card('Clôture de caisse', h('p', { class: 'pf-note' }, 'Comptez l\'argent du compte, saisissez le montant : Wallindirain le compare à ce qu\'il devrait y avoir.'),
          h('div', { class: 'pf-entry-list' }, h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Compte'), sel), h('label', { class: 'pf-entry-row' }, h('span', { class: 'grow' }, 'Compté'), counted)), out,
          h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: save }, 'Enregistrer la clôture')),
          closes.length > 0 && h('section', { class: 'pf-card flush' }, closes.map((c) => h('div', { class: 'pf-row' }, h('span', { class: 'pf-row-main' }, h('b', {}, `${new Date(`${c.day}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${c.account_name}`),
            h('span', { class: `pf-amt ${c.diff < 0 ? 'neg' : c.diff > 0 ? 'pos' : ''}` }, c.diff === 0 ? 'Juste' : `${c.diff > 0 ? '+' : '−'}${fmtGNF(Math.abs(c.diff))}`), h('small', {}, `Attendu ${fmtGNF(c.expected)} · compté ${fmtGNF(c.counted)}`))))));
      }).catch(errToast); return [box]; };
    const views = { sell, products, cash };
    const tabs = h('div', { class: 'wallet-tabs', role: 'group' }, [['sell', 'Vendre'], ['products', 'Produits'], ['cash', 'Caisse']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; paint(); } }, l)));
    const bar = tab === 'sell' && cartCount() > 0 && h('div', { class: 'shop-cart' }, h('span', {}, h('b', {}, `${cartCount()} article(s)`), ` · ${fmtGNF(cartTotal())}`), h('button', { class: 'btn btn-gold', type: 'button', onclick: checkout }, 'Encaisser'));
    host.replaceChildren(head('Boutique', { back: ['Plus', () => go('more')], eye: true }), h('div', { class: 'pf-pad' }, !pro && h('p', { class: 'pf-note' }, 'La boutique fait partie de la formule Pro.'), tabs, ...views[tab]().filter(Boolean)), bar || h('span', {}));
  };
  return liveView(() => get('/pf/shop'), (d, refresh) => { render(d, refresh); return host; });
}
