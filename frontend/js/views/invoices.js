// Factures et documents numérotés : facture de livraison (client), facture de services (vendeur), relevé (fournisseur), reçu de retrait.
// Les documents sont émis à la demande, numérotés et figés côté serveur. Ici : affichage, impression / PDF, listes, vue d'ensemble de la finance.
import { h, ask, fmtGNF, fmtDate, fmtPhone, liveView, action, table, badge, empty, toast, pageHead, kv, printNode, ROLE_LABEL } from '../ui.js';
import { get, post } from '../api.js';

export const KIND_LABEL = { delivery: 'Facture de livraison', seller_services: 'Facture de services', supplier_statement: 'Relevé fournisseur', withdrawal_receipt: 'Reçu de retrait' };
const KIND_TONE = { delivery: 'info', seller_services: 'warn', supplier_statement: 'ok', withdrawal_receipt: 'grey' };
const day = (d) => d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
const iso = (d) => d.toISOString().slice(0, 10);

// ---------- Le document ----------
export function invoiceDoc(inv) {
  const d = inv.data, is = d.issuer || {};
  const statement = inv.kind === 'seller_services' || inv.kind === 'supplier_statement';
  const lines = d.lines || [];
  const head = h('header', { class: 'inv-head' }, h('img', { class: 'inv-logo', src: '/assets/logo-gold.png', alt: '' }),
    h('div', { class: 'inv-issuer' }, h('b', {}, is.name || 'Wallindirain'), is.address && h('div', {}, is.address), (is.phone || is.email) && h('div', {}, [is.phone && `Tél. ${fmtPhone(is.phone)}`, is.email].filter(Boolean).join(' · ')),
      (is.nif || is.rccm) && h('div', {}, [is.nif && `NIF : ${is.nif}`, is.rccm && `RCCM : ${is.rccm}`].filter(Boolean).join(' · '))));
  const who = d.recipient || {};
  const meta = h('div', { class: 'inv-meta' },
    h('div', {}, h('h1', {}, d.title), h('div', { class: 'inv-no' }, `N° ${inv.number}`), h('div', {}, `Émis le ${day(inv.issued_at)}`),
      d.period && h('div', {}, `Période : du ${day(d.period.from)} au ${day(d.period.to)}`), d.order_ref && h('div', {}, `Commande : ${d.order_ref}`), d.date && !statement && h('div', {}, `${inv.kind === 'delivery' ? 'Livrée' : 'Payé'} le ${day(d.date)}`)),
    h('div', { class: 'inv-box' }, h('h3', {}, inv.kind === 'delivery' ? 'Facturé à' : 'Titulaire'), h('b', {}, who.name), who.phone && h('div', {}, fmtPhone(who.phone)), who.address && h('div', {}, who.address),
      d.seller && h('div', { class: 'sub' }, `Vendu par ${d.seller}`)));
  const money = (n) => h('td', { class: 'num' }, fmtGNF(n));
  const body = statement
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Réf.', 'Désignation', 'Montant'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
        h('tbody', {}, lines.map((l) => h('tr', {}, h('td', {}, day(l.date)), h('td', {}, l.ref || ''), h('td', {}, l.label, l.parts?.length ? h('div', { class: 'sub' }, l.parts.map((p) => `${p.k} ${fmtGNF(p.v)}`).join(' · ')) : null), money(l.amount)))))
    : h('table', {}, h('thead', {}, h('tr', {}, ['Désignation', 'Qté', 'Montant'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', {}, lines.map((l) => h('tr', {}, h('td', {}, l.label, l.ref ? h('div', { class: 'sub' }, `Réf. ${l.ref}`) : null), h('td', { class: 'num' }, l.qty ?? ''), money(l.amount)))));
  return h('article', { class: 'inv' }, head, meta, body,
    h('div', { class: 'inv-total' }, h('span', {}, inv.kind === 'supplier_statement' ? 'Solde net' : 'Total'), h('span', {}, fmtGNF(inv.total))),
    inv.kind === 'delivery' && h('div', {}, h('span', { class: 'inv-stamp' }, 'PAYÉE'), h('div', { class: 'inv-note' }, `Règlement : ${d.payment || 'à la livraison'}, le ${day(d.paid_on)}.`)),
    inv.kind === 'withdrawal_receipt' && h('div', {}, h('span', { class: 'inv-stamp' }, 'PAYÉ'), h('div', { class: 'inv-note' }, `Demandé le ${day(d.requested_on)} · payé le ${day(d.paid_on)} via ${d.payment}${d.payment_ref ? ` · référence ${d.payment_ref}` : ''}.`)),
    d.note && h('div', { class: 'inv-note' }, d.note),
    h('div', { class: 'inv-foot' }, is.footer && h('div', {}, is.footer), h('div', {}, `Document numéroté ${inv.number}, établi par ${is.name || 'Wallindirain'} et non modifiable.`)));
}

/** Ouvre un document dans une fenêtre, avec impression / enregistrement en PDF. */
export async function openInvoice(id) {
  const { invoice } = await get(`/invoices/${id}`);
  const doc = invoiceDoc(invoice);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay inv-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal inv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${invoice.number}` },
      h('div', { class: 'inv-bar' }, h('button', { class: 'btn btn-gold', type: 'button', onclick: () => printNode(invoiceDoc(invoice), { invoice: true }) }, 'Imprimer / enregistrer en PDF'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Fermer')), doc));
  document.body.append(overlay); document.addEventListener('keydown', onKey);
}
const openSafe = (id) => openInvoice(id).catch((e) => toast(e.message, 'bad'));

/** Bouton « Reçu » d'un retrait payé : émet le reçu (une seule fois) puis l'ouvre. */
export const receiptButton = (withdrawalId) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: action(async () => { const r = await post('/invoices/withdrawal', { withdrawal_id: withdrawalId }); await openInvoice(r.id); }) }, 'Reçu');

const periodFields = () => {
  const now = new Date(), first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return [{ name: 'from', label: 'Du', type: 'date', value: iso(first) }, { name: 'to', label: 'Au (jusqu\'à hier au plus tard)', type: 'date', value: iso(last) }];
};
const docTable = (invoices, { showUser = false } = {}) => table(['N°', 'Type', 'Émis le', showUser ? 'Titulaire' : 'Détail', 'Total', ''], invoices.map((i) => [
  h('b', { class: 'mono' }, i.number), badge(KIND_LABEL[i.kind], KIND_TONE[i.kind]), fmtDate(i.issued_at),
  showUser ? h('div', {}, i.user_name, h('div', { class: 'small muted' }, ROLE_LABEL[i.user_role] || '', i.order_ref ? ` · ${i.order_ref}` : '', i.period_from ? ` · ${day(i.period_from)} → ${day(i.period_to)}` : '')) : (i.order_ref || (i.period_from ? `${day(i.period_from)} → ${day(i.period_to)}` : '—')),
  h('b', {}, fmtGNF(i.total)), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openSafe(i.id) }, 'Ouvrir')]), { empty: empty('receipt', 'Aucun document pour le moment') });

// ---------- Vendeur et fournisseur ----------
export function myInvoices(role) {
  const seller = role === 'seller';
  return liveView(async () => ({ ...(await get('/invoices')), ...(seller ? await get('/seller/delivered-orders') : { orders: [] }) }), ({ invoices, orders }, refresh) => {
    const statement = action(async () => {
      const v = await ask({ title: seller ? 'Facture de services' : 'Relevé de mes ventes', text: seller ? 'Frais de livraison, call center, plateforme, retours et abonnement des commandes livrées sur la période. Un document couvre une période une seule fois.' : 'Ventes, frais de retour et compensations de la période. Un relevé couvre une période une seule fois.', submit: 'Créer le document', fields: periodFields() });
      if (!v) return;
      const r = await post('/invoices/statement', { period_from: v.from, period_to: v.to });
      await refresh(); await openInvoice(r.id);
    });
    const clientInvoice = (o) => action(async () => { const r = await post('/invoices/delivery', { order_id: o.id }); await refresh(); await openInvoice(r.id); });
    return h('div', {}, pageHead('Factures', seller ? 'Factures clients, factures de services et reçus de retrait' : 'Relevés de ventes et reçus de retrait'),
      h('div', { class: 'card' }, h('h2', {}, seller ? 'Facture de services par période' : 'Relevé de ventes par période'),
        h('p', { class: 'muted small' }, 'Les documents sont numérotés et ne peuvent plus être modifiés une fois créés. Vous pouvez les imprimer ou les enregistrer en PDF.'),
        h('button', { class: 'btn btn-gold', type: 'button', onclick: statement }, 'Créer pour une période')),
      seller && h('div', { class: 'card' }, h('h2', {}, 'Factures clients (commandes livrées)'),
        table(['Livrée le', 'Commande', 'Produit', 'Client', 'Total', ''], orders.map((o) => [fmtDate(o.delivered_at), h('b', {}, o.ref), `${o.product_name} × ${o.qty}`, o.customer_name, fmtGNF(o.sale_total),
          o.invoice_id ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openSafe(o.invoice_id) }, `Voir ${o.invoice_number}`) : h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: clientInvoice(o) }, 'Créer la facture')]),
          { empty: empty('package', 'Aucune commande livrée pour le moment') })),
      h('div', { class: 'card' }, h('h2', {}, 'Mes documents'), docTable(invoices)));
  });
}

// ---------- Administrateur : vue d'ensemble pour la finance, journal des documents, informations de l'entreprise ----------
export function adminInvoices() {
  const now = new Date();
  let from = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to = iso(now), kind = '', search = '';
  const host = h('div', {});
  const show = () => host.replaceChildren(h('div', {}, pageHead('Factures et finance', 'Vue d\'ensemble des chiffres, journal des documents numérotés, informations de l\'entreprise'), filters(), summary(), journal(), company()));
  const filters = () => h('div', { class: 'card' }, h('div', { class: 'form-grid' },
    h('label', { class: 'f' }, h('span', {}, 'Du'), h('input', { type: 'date', value: from, onchange: (e) => { from = e.target.value; show(); } })),
    h('label', { class: 'f' }, h('span', {}, 'Au'), h('input', { type: 'date', value: to, onchange: (e) => { to = e.target.value; show(); } }))));
  const summary = () => liveView(() => get(`/admin/finance?${new URLSearchParams({ from, to })}`), ({ summary: s }) => {
    const row = (label, value, hint) => [label, h('b', {}, value), hint ? h('span', { class: 'small muted' }, hint) : ''];
    const rows = [
      row('Livraisons réalisées', String(s.deliveries.count)), row('Total encaissé auprès des clients', fmtGNF(s.deliveries.sale_total), 'montant des commandes livrées'),
      row('Frais de livraison', fmtGNF(s.deliveries.delivery_fees)), row('Frais du centre d\'appel', fmtGNF(s.deliveries.call_fees)), row('Frais de plateforme', fmtGNF(s.deliveries.platform_fees)), row('Marge sur les produits', fmtGNF(s.deliveries.margin)),
      row('Gains des vendeurs', fmtGNF(s.ledger.seller_gain), 'inscrits aux portefeuilles'), row('Paiements des fournisseurs', fmtGNF(s.ledger.supplier_payment), 'inscrits aux portefeuilles'),
      row('Rémunérations de l\'équipe', fmtGNF(s.ledger.team_pay)), row('Revenu de la plateforme', fmtGNF(s.ledger.platform_revenue)), row('Abonnements encaissés', fmtGNF(s.ledger.subscriptions)),
      row('Retours réceptionnés', String(s.returns)), row('Retraits payés', `${s.withdrawals_paid.count} · ${fmtGNF(s.withdrawals_paid.total)}`), row('Retraits en attente (à ce jour)', `${s.withdrawals_waiting.count} · ${fmtGNF(s.withdrawals_waiting.total)}`),
      ...Object.entries(s.invoices).map(([k, x]) => row(`Documents émis : ${KIND_LABEL[k]}`, `${x.count} · ${fmtGNF(x.total)}`))];
    const sheet = () => h('div', { class: 'inv' }, h('h1', {}, 'Synthèse financière'), h('p', {}, `Période : du ${day(s.period.from)} au ${day(s.period.to)} · éditée le ${day(new Date())}`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Indicateur'), h('th', { class: 'num' }, 'Valeur'))), h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r[0]), h('td', { class: 'num' }, r[1].textContent))))));
    return h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Vue d\'ensemble'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => printNode(sheet(), { invoice: true }) }, 'Imprimer la synthèse')),
      h('p', { class: 'muted small' }, 'Totaux lus dans les commandes livrées, les portefeuilles, les retraits et les documents émis. Rien n\'est calculé en dehors de ces données.'),
      table(['Indicateur', 'Valeur', ''], rows, { empty: empty('chart', 'Aucune donnée') }));
  });
  const journal = () => liveView(() => get(`/invoices?${new URLSearchParams({ from, to, limit: 500, ...(kind && { kind }), ...(search && { q: search }) })}`), ({ invoices }, refresh) => {
    const chip = (k, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(kind === k), onclick: () => { kind = k; show(); } }, label);
    const issueDelivery = action(async () => { const v = await ask({ title: 'Facture de livraison', text: 'Référence d\'une commande livrée.', submit: 'Créer / ouvrir', fields: [{ name: 'ref', label: 'Référence (ex. WLD-1001)' }] }); if (!v) return; const r = await post('/invoices/delivery', { ref: v.ref.trim() }); await refresh(); await openInvoice(r.id); });
    const issueStatement = action(async () => {
      const { users } = await get('/admin/users');
      const people = users.filter((u) => ['seller', 'supplier'].includes(u.role) && u.status === 'active');
      if (!people.length) { toast('Aucun vendeur ou fournisseur actif', 'bad'); return; }
      const v = await ask({ title: 'Relevé pour un compte', submit: 'Créer le document', fields: [{ name: 'user_id', label: 'Vendeur ou fournisseur', type: 'select', options: people.map((u) => [u.id, `${u.full_name} (${ROLE_LABEL[u.role]})`]) }, ...periodFields()] });
      if (!v) return;
      const r = await post('/invoices/statement', { user_id: v.user_id, period_from: v.from, period_to: v.to }); await refresh(); await openInvoice(r.id);
    });
    const qs = new URLSearchParams({ from, to, ...(kind && { kind }) });
    const sheet = () => h('div', { class: 'inv' }, h('h1', {}, 'Journal des documents'), h('p', {}, `Du ${day(from)} au ${day(to)}`),
      h('table', {}, h('thead', {}, h('tr', {}, ['N°', 'Type', 'Date', 'Titulaire', 'Total'].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x)))),
        h('tbody', {}, invoices.map((i) => h('tr', {}, h('td', {}, i.number), h('td', {}, KIND_LABEL[i.kind]), h('td', {}, fmtDate(i.issued_at)), h('td', {}, i.user_name), h('td', { class: 'num' }, fmtGNF(i.total)))))));
    const searchBox = h('input', { type: 'search', placeholder: 'N°, nom, commande…', value: search, 'aria-label': 'Chercher un document', onchange: (e) => { search = e.target.value.trim(); show(); } });
    return h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Journal des documents'),
      h('a', { class: 'btn btn-sm btn-ghost', href: `/api/admin/invoices/export?${qs}`, download: 'journal-factures.csv' }, 'Exporter (CSV)'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => printNode(sheet(), { invoice: true }) }, 'Imprimer')),
      h('div', { class: 'chips mb' }, chip('', 'Tous'), chip('delivery', 'Factures de livraison'), chip('seller_services', 'Services vendeurs'), chip('supplier_statement', 'Relevés fournisseurs'), chip('withdrawal_receipt', 'Reçus de retrait')),
      h('div', { class: 'gap mb' }, h('label', { class: 'f grow' }, searchBox), h('button', { class: 'btn btn-ghost', type: 'button', onclick: issueDelivery }, 'Facture d\'une commande'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: issueStatement }, 'Relevé d\'un compte')),
      docTable(invoices, { showUser: true }));
  });
  const company = () => liveView(() => get('/admin/company'), ({ company: c }, refresh) => {
    const edit = action(async () => {
      const v = await ask({ title: 'Informations de l\'entreprise', text: 'Elles apparaissent en en-tête des nouveaux documents. Ce qui est vide n\'est pas imprimé. Les documents déjà émis ne changent pas.', submit: 'Enregistrer',
        fields: [{ name: 'legal_name', label: 'Nom de l\'entreprise', value: c.legal_name || '' }, { name: 'address', label: 'Adresse', value: c.address || '', required: false }, { name: 'phone', label: 'Téléphone', value: c.phone || '', required: false },
          { name: 'email', label: 'E-mail', value: c.email || '', required: false }, { name: 'nif', label: 'NIF', value: c.nif || '', required: false }, { name: 'rccm', label: 'RCCM', value: c.rccm || '', required: false },
          { name: 'footer_note', label: 'Mention de bas de page', type: 'textarea', value: c.footer_note || '', maxlength: 400 }] });
      if (v) await post('/admin/company', v);
    }, { ok: 'Informations enregistrées', refresh });
    return h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Informations de l\'entreprise (en-tête des documents)'), h('button', { class: 'btn btn-sm btn-gold', type: 'button', onclick: edit }, 'Modifier')),
      kv([['Nom', c.legal_name || '—'], ['Adresse', c.address || '—'], ['Téléphone', c.phone || '—'], ['E-mail', c.email || '—'], ['NIF', c.nif || '—'], ['RCCM', c.rccm || '—'], ['Mention de bas de page', c.footer_note || '—']]),
      (!c.nif || !c.rccm || !c.address) && h('p', { class: 'notice warn small' }, 'Renseignez votre adresse, NIF et RCCM : ce sont les mentions habituelles d\'une facture. Rien n\'est inventé, ce qui est vide n\'est pas imprimé.'));
  });
  show();
  return host;
}


// ---------- Comptabilité de la société : états simples à imprimer (chiffres de l'entreprise seulement, aucune donnée personnelle) ----------
export function adminAccounting() {
  const now = new Date();
  let from = iso(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))), to = iso(now), picked = null;
  const host = h('div', {});
  const show = () => host.replaceChildren(h('div', {}, pageHead('Comptabilité de la société', 'Journal, compte de résultat et trésorerie, à imprimer. Uniquement les chiffres de l\'entreprise.'), body()));
  const body = () => liveView(() => get(`/admin/accounting?${new URLSearchParams({ from, to, ...(picked && { accounts: picked.join(',') }) })}`), ({ accounting: a }) => {
    if (!picked) picked = a.selected;
    const sel = new Set(picked);
    const lines = [...a.automatic.map((x) => ({ day: x.day, label: x.label, note: x.count > 1 ? `${x.count} opérations` : '', side: x.side, amount: x.amount })),
      ...a.manual.map((x) => ({ day: x.day, label: x.label, note: x.note || '', side: x.side, amount: x.amount }))].sort((p, q) => String(p.day).localeCompare(String(q.day)));
    const group = (side) => { const m = new Map(); for (const l of lines) if (l.side === side) m.set(l.label, (m.get(l.label) || 0) + Number(l.amount)); return [...m]; };
    const rev = group('revenue'), chg = group('charge');
    const c = a.company || {};
    const sheet = () => h('div', { class: 'inv' },
      h('header', { class: 'inv-head' }, h('img', { class: 'inv-logo', src: '/assets/logo-gold.png', alt: '' }),
        h('div', { class: 'inv-issuer' }, h('b', {}, c.legal_name || 'Wallindirain'), c.address && h('div', {}, c.address), (c.nif || c.rccm) && h('div', {}, [c.nif && `NIF : ${c.nif}`, c.rccm && `RCCM : ${c.rccm}`].filter(Boolean).join(' · ')))),
      h('h1', {}, 'États comptables simplifiés'), h('p', {}, `Période : du ${day(a.period.from)} au ${day(a.period.to)} · édité le ${day(new Date())}`),
      h('h2', {}, 'Compte de résultat'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Libellé'), h('th', { class: 'num' }, 'Montant'))), h('tbody', {},
        h('tr', {}, h('th', { colspan: 2 }, 'Produits')), rev.map(([l, m]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, fmtGNF(m)))), h('tr', {}, h('td', {}, h('b', {}, 'Total des produits')), h('td', { class: 'num' }, h('b', {}, fmtGNF(a.revenue)))),
        h('tr', {}, h('th', { colspan: 2 }, 'Charges')), chg.map(([l, m]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, fmtGNF(m)))), h('tr', {}, h('td', {}, h('b', {}, 'Total des charges')), h('td', { class: 'num' }, h('b', {}, fmtGNF(a.charges)))),
        h('tr', {}, h('td', {}, h('b', {}, a.result >= 0 ? 'Bénéfice de la période' : 'Perte de la période')), h('td', { class: 'num' }, h('b', {}, fmtGNF(a.result)))))),
      h('h2', {}, 'Trésorerie'),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', {}, 'Comptes de l\'entreprise au début de la période'), h('td', { class: 'num' }, fmtGNF(a.treasury.accounts_open))),
        h('tr', {}, h('td', {}, 'Comptes de l\'entreprise à la fin de la période'), h('td', { class: 'num' }, fmtGNF(a.treasury.accounts_close))),
        h('tr', {}, h('td', {}, 'Solde du portefeuille de la plateforme à la fin'), h('td', { class: 'num' }, fmtGNF(a.treasury.platform_wallet))))),
      h('h2', {}, 'Journal des écritures'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Libellé'), h('th', {}, 'Détail'), h('th', { class: 'num' }, 'Produit'), h('th', { class: 'num' }, 'Charge'))),
        h('tbody', {}, lines.map((l) => h('tr', {}, h('td', {}, day(l.day)), h('td', {}, l.label), h('td', {}, l.note), h('td', { class: 'num' }, l.side === 'revenue' ? fmtGNF(l.amount) : ''), h('td', { class: 'num' }, l.side === 'charge' ? fmtGNF(l.amount) : ''))))),
      h('p', { class: 'small' }, 'Document établi à partir des données de la plateforme, sans aucune information personnelle sur les clients ni les utilisateurs. Aucune règle fiscale n\'y est appliquée : à faire valider par un expert-comptable avant tout dépôt officiel.'));
    const accountBoxes = a.accounts.length ? h('div', { class: 'chips mb' }, a.accounts.map((x) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(sel.has(x.id)), onclick: () => { if (sel.has(x.id)) sel.delete(x.id); else sel.add(x.id); picked = [...sel]; show(); } }, x.name))) : h('p', { class: 'muted small' }, 'Aucun compte « Mes finances » : seuls les chiffres automatiques de la plateforme sont inclus.');
    return h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, h('span', {}, 'Du'), h('input', { type: 'date', value: from, onchange: (e) => { from = e.target.value; show(); } })),
        h('label', { class: 'f' }, h('span', {}, 'Au'), h('input', { type: 'date', value: to, onchange: (e) => { to = e.target.value; show(); } }))),
        h('p', { class: 'small muted' }, 'Comptes de « Mes finances » à inclure (vos écritures saisies à la main) :'), accountBoxes),
      h('div', { class: 'card' }, h('div', { class: 'gap' }, h('h2', { class: 'grow' }, 'Résultat de la période'), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => printNode(sheet(), { invoice: true }) }, 'Imprimer / PDF')),
        table(['Produits', 'Charges', a.result >= 0 ? 'Bénéfice' : 'Perte'], [[h('b', {}, fmtGNF(a.revenue)), h('b', {}, fmtGNF(a.charges)), h('b', {}, fmtGNF(a.result))]], { empty: empty('chart', 'Aucune donnée') }),
        h('p', { class: 'muted small' }, 'Les revenus de la plateforme sont inscrits automatiquement en totaux par jour. Aucun nom, téléphone ni numéro de commande n\'apparaît.')),
      h('div', { class: 'card' }, h('h2', {}, 'Journal'), table(['Date', 'Libellé', 'Détail', 'Produit', 'Charge'], lines.map((l) => [day(l.day), l.label, l.note, l.side === 'revenue' ? fmtGNF(l.amount) : '', l.side === 'charge' ? fmtGNF(l.amount) : '']), { empty: empty('chart', 'Aucune écriture sur la période') })));
  });
  show();
  return host;
}
