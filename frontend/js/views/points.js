// Points de retrait multiples (migration 079) : lieux déclarés par le fournisseur ou le vendeur. Aucun stock ni frais par point.
import { h, ask, liveView, action, guide, pageHead, kv, confirmBox } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

export function pickupPointsView() {
  return liveView(() => Promise.all([get('/pickup-points'), get('/public/info')]), ([{ enabled, points }, info], refresh) => {
    if (!enabled) return h('div', {}, pageHead('Points de retrait', ''), guide('package', 'Plusieurs lieux de retrait', 'Fonction non activée', 'L\'administration n\'a pas encore activé les points de retrait.'));
    const fields = (p = {}) => [{ name: 'name', label: 'Nom du lieu', value: p.name || '' }, { name: 'zone', label: 'Quartier ou ville', type: 'select', value: p.zone || '', options: (info.communes || []).map((c) => [c.commune, c.commune]) }, { name: 'address', label: 'Adresse ou repère', value: p.address || '' }, { name: 'contact', label: 'Téléphone sur place (facultatif)', required: false, inputmode: 'tel', value: p.contact || '' }];
    const add = action(async () => { const v = await ask({ title: 'Nouveau point de retrait', submit: 'Ajouter', fields: fields() }); if (v) await post('/pickup-points', v); }, { ok: () => 'Point ajouté', refresh });
    const edit = (p) => action(async () => { const v = await ask({ title: `Modifier : ${p.name}`, submit: 'Enregistrer', fields: fields(p) }); if (v) await post('/pickup-points', { ...v, id: p.id }); }, { ok: () => 'Point modifié', refresh });
    const del = (p) => action(async () => { if (await confirmBox('Retirer ce point ?', p.name, 'Retirer', true)) await post(`/pickup-points/${p.id}/remove`, {}); }, { ok: () => 'Point retiré', refresh });
    return h('div', {}, pageHead('Points de retrait', 'Vos lieux de départ. Le stock reste compté en un seul total.'),
      h('div', { class: 'gap wrap' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: add }, [icon('plus', 16), ' Nouveau point'])),
      points.length === 0
        ? guide('package', 'Vos entrepôts et dépôts', 'Déclarez votre premier point', 'Ajoutez chaque lieu où le livreur peut récupérer vos colis. Vous pourrez ensuite choisir le bon lieu pour chaque produit.')
        : h('div', {}, points.map((p) => h('div', { class: 'card mt' }, h('h3', {}, p.name), kv([['Zone', p.zone], ['Adresse', p.address], p.contact && ['Contact', p.contact]]),
          h('div', { class: 'gap wrap' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: edit(p) }, 'Modifier'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: del(p) }, 'Retirer'))))));
  });
}
