// Livraison à la demande : espace de l'expéditeur (demander une course, suivre, annuler) et liste côté administration.
import { h, fmtGNF, action, toast, errToast, empty, badge, liveView, table, confirmBox } from '../ui.js';
import { get, post } from '../api.js';

const STATUS = { new: ['À prendre en charge', 'warn'], assigned: ['Livreur désigné', 'info'], picked_up: ['Colis récupéré', 'info'], delivered: ['Livré', 'ok'], failed: ['Échec', 'bad'], cancelled: ['Annulé', 'grey'] };
const PAYER = { sender: 'Moi, au ramassage', receiver: 'Le destinataire, à la réception' };
const field = (label, input, hint) => h('label', { class: 'f' }, h('span', {}, label), input, hint && h('div', { class: 'hint' }, hint));
const day = (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Formulaire d'envoi : le prix s'affiche avant de confirmer et ne change plus ensuite. */
export function shipperSend({ goTo }) {
  const host = h('div', {}, h('div', { class: 'spinner' }));
  get('/shipper/places').then(({ places }) => {
    const froms = places.filter((p) => p.kind === 'from').map((p) => p.name);
    const tos = [...new Set(places.filter((p) => p.kind === 'to').map((p) => p.name))];
    if (!froms.length) { host.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Nouvel envoi'), empty('truck', 'Le service n\'a pas encore de tarif. Revenez bientôt.'))); return; }
    const from = h('select', { required: true }, froms.map((p) => h('option', { value: p }, p)));
    const fromAddr = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'Rue, repère, numéro de porte…' });
    const to = h('input', { type: 'text', required: true, maxlength: 60, list: 'dlv-to', placeholder: 'Tapez le quartier', autocomplete: 'off' });
    const toList = h('datalist', { id: 'dlv-to' }, tos.map((p) => h('option', { value: p })));
    const toAddr = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'Rue, repère, numéro de porte…' });
    const rname = h('input', { type: 'text', required: true, maxlength: 100 });
    const rphone = h('input', { type: 'tel', inputmode: 'numeric', required: true, maxlength: 16, placeholder: '6XX XX XX XX' });
    const desc = h('input', { type: 'text', required: true, maxlength: 300, placeholder: 'Ex. sac de vêtements, carton de chaussures' });
    const kg = h('input', { type: 'number', inputmode: 'decimal', required: true, min: 0.1, step: 0.1, placeholder: 'Poids en kg' });
    const decl = h('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '0' });
    const payer = h('select', {}, Object.entries(PAYER).map(([k, l]) => h('option', { value: k }, l)));
    const ack = h('input', { type: 'checkbox', required: true });
    const priceBox = h('div', { class: 'notice' }, 'Choisissez le quartier d\'arrivée et le poids pour voir le prix.');
    let t; let quote = null;
    const refreshPrice = () => { clearTimeout(t); quote = null; t = setTimeout(async () => {
      if (!to.value.trim() || !(Number(kg.value) > 0)) { priceBox.className = 'notice'; priceBox.textContent = 'Choisissez le quartier d\'arrivée et le poids pour voir le prix.'; return; }
      try { quote = (await get(`/shipper/quote?from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value.trim())}&kg=${encodeURIComponent(kg.value)}`)).quote; priceBox.className = 'notice ok'; priceBox.replaceChildren(h('b', {}, fmtGNF(quote.price)), ` · colis ${quote.weight_class === 'heavy' ? 'lourd' : 'léger'}`); }
      catch (e) { priceBox.className = 'notice warn'; priceBox.textContent = e.message || 'Ce trajet n\'a pas encore de tarif.'; }
    }, 350); };
    [from, to, kg].forEach((el) => el.addEventListener('input', refreshPrice));
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!quote) { toast('Vérifiez le trajet et le poids : le prix doit s\'afficher.', 'bad'); return; }
      if (!(await confirmBox(`Confirmer l'envoi à ${fmtGNF(quote.price)} ?`, `Course payée par : ${PAYER[payer.value].toLowerCase()}. Le prix ne changera plus.`, 'Confirmer'))) return;
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await post('/shipper/requests', { from: from.value, from_address: fromAddr.value, to: to.value.trim(), to_address: toAddr.value, receiver_name: rname.value, receiver_phone: rphone.value, description: desc.value, kg: Number(kg.value), declared_value: Number(decl.value || 0), payer: payer.value, ack: ack.checked });
        toast(`Demande ${r.ref} envoyée : ${fmtGNF(r.price)}`, 'ok'); goTo('mine');
      } catch (ex) { errToast(ex); } finally { btn.disabled = false; }
    } },
      h('h2', {}, 'Nouvel envoi'),
      h('h3', {}, 'Ramassage'), field('Quartier de départ', from), field('Adresse de ramassage', fromAddr),
      h('h3', {}, 'Livraison'), field('Quartier d\'arrivée', to), toList, field('Adresse de livraison', toAddr), field('Nom du destinataire', rname), field('Téléphone du destinataire', rphone),
      h('h3', {}, 'Colis'), field('Que contient le colis ?', desc), field('Poids (kg)', kg), field('Valeur déclarée en GNF (facultatif)', decl, 'Elle limite le remboursement en cas de perte ou de dommage.'), field('Qui paie la course ?', payer, 'Le paiement se fait en espèces au livreur.'),
      priceBox,
      h('label', { class: 'f check' }, ack, h('span', {}, 'Je confirme que le colis ne contient aucun objet interdit (armes, explosifs, drogues, produits dangereux, argent liquide…).')),
      h('button', { class: 'btn btn-gold btn-block', type: 'submit' }, 'Envoyer la demande'));
    host.replaceChildren(h('div', { class: 'card' }, form));
  }).catch(errToast);
  return host;
}

/** Mes envois : suivi et annulation tant que le colis n'est pas pris en charge. */
export function shipperRequests() {
  return liveView(() => get('/shipper/requests'), ({ requests }, refresh) => {
    if (!requests.length) return h('div', { class: 'card' }, h('h2', {}, 'Mes envois'), empty('truck', 'Aucun envoi pour le moment.'));
    return h('div', {}, h('h2', {}, 'Mes envois'), requests.map((r) => h('div', { class: 'card' },
      h('div', { class: 'gap' }, h('b', { class: 'grow' }, r.ref), badge(STATUS[r.status]?.[0] || r.status, STATUS[r.status]?.[1] || 'grey')),
      h('div', {}, `${r.from} → ${r.to}`), h('div', { class: 'small muted' }, `${r.receiver_name} · ${r.to_address}`),
      h('div', { class: 'small muted' }, `${r.description} · ${r.weight_kg} kg (${r.weight_class === 'heavy' ? 'lourd' : 'léger'}) · payé par ${PAYER[r.payer].toLowerCase()}`),
      h('div', { class: 'gap' }, h('b', { class: 'grow' }, fmtGNF(r.price)), h('span', { class: 'small muted' }, day(r.created_at)),
        r.status === 'new' && h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => { if (await confirmBox('Annuler cette demande ?', 'Elle ne sera pas livrée.', 'Annuler la demande', true)) await post(`/shipper/requests/${r.id}/cancel`); }, { ok: 'Demande annulée', refresh }) }, 'Annuler')))));
  });
}

/** Administration : demandes d'envoi reçues. */
export function adminDlvRequests() {
  let status = '';
  const host = h('div');
  const draw = () => host.replaceChildren(h('div', { class: 'chips' }, [['', 'Toutes'], ['new', 'À prendre'], ['delivered', 'Livrées'], ['cancelled', 'Annulées']].map(([k, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(status === k), onclick: () => { status = k; draw(); } }, l))),
    liveView(() => get(`/admin/dlv-requests${status ? `?status=${status}` : ''}`), ({ requests }) => (requests.length === 0 ? empty('truck', 'Aucune demande.') : h('div', { class: 'card' }, h('h2', {}, 'Livraisons à la demande'),
      table(['Réf.', 'Expéditeur', 'Trajet', 'Colis', 'Prix', 'État'], requests.map((r) => [r.ref, h('div', {}, r.shipper, h('div', { class: 'small muted' }, r.shipper_phone)), h('div', {}, `${r.from} → ${r.to}`, h('div', { class: 'small muted' }, `${r.receiver_name} · ${r.receiver_phone}`)),
        h('div', {}, r.description, h('div', { class: 'small muted' }, `${r.weight_kg} kg (${r.weight_class === 'heavy' ? 'lourd' : 'léger'}) · valeur ${fmtGNF(r.declared_value)}`)), h('div', {}, fmtGNF(r.price), h('div', { class: 'small muted' }, PAYER[r.payer])), badge(STATUS[r.status]?.[0] || r.status, STATUS[r.status]?.[1] || 'grey')]))))));
  draw();
  return host;
}
