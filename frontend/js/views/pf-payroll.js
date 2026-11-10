// Paie des employés : salaire mensuel de chaque personne, qui est payé ce mois-ci, et « Payer » qui crée la dépense.
import { h, ask, confirmBox, action, toast, errToast, empty, badge, liveView, fmtGNF } from '../ui.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';

const ROLE = { agent: 'Agent call center', call_chief: 'Chef call center', courier: 'Livreur', warehouse: 'Magasinier', admin: 'Administrateur' };
const today = () => new Date().toISOString().slice(0, 10);
const monthNow = () => today().slice(0, 7);
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); const s = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1); };

export function payrollScreen({ go, head, card, isAdmin }) {
  let month = monthNow();
  const host = h('div', {});
  const render = (d, refresh) => {
    const askEmployee = async (e) => {
      const staff = isAdmin ? (await get('/pf/payroll/staff').catch(() => ({ staff: [] }))).staff : [];
      const v = await ask({ title: e ? 'Modifier l\'employé' : 'Nouvel employé', submit: 'Enregistrer', fields: [
        { name: 'name', label: 'Nom', maxlength: 80, value: e?.name || '' },
        { name: 'job', label: 'Poste (facultatif)', required: false, maxlength: 60, value: e?.job || '' },
        { name: 'monthly_amount', label: 'Salaire mensuel (GNF)', type: 'number', inputmode: 'numeric', value: e?.monthly_amount || '' },
        ...(staff.length ? [{ name: 'user_id', label: 'Relier à un membre de l\'équipe (facultatif)', type: 'select', required: false, options: [['', 'Aucun'], ...staff.map((s) => [s.id, `${s.full_name} · ${ROLE[s.role] || s.role}`])], value: e?.user_id || '' }] : [])] });
      if (!v) return false;
      await post('/pf/payroll', { id: e?.id, name: v.name, job: v.job || undefined, monthly_amount: Math.round(Number(v.monthly_amount)), user_id: v.user_id || undefined });
      return true;
    };
    const pay = async (e) => {
      const accs = (await get('/pf/accounts')).accounts.filter((a) => !a.archived_at && !a.auto && (!a.currency || a.currency === 'GNF') && a.writable !== false);
      if (!accs.length) { toast('Créez d\'abord un compte en GNF pour payer les salaires.', 'bad'); return false; }
      const v = await ask({ title: `Payer ${e.name}`, text: `Salaire de ${monthName(d.month)} : une dépense « Employés » est enregistrée sur le compte choisi.`, submit: 'Payer', fields: [
        { name: 'account_id', label: 'Payer depuis', type: 'select', options: accs.map((a) => [a.id, `${a.name} · ${fmtGNF(a.balance)}`]), value: accs[0].id },
        { name: 'amount', label: 'Montant (GNF)', type: 'number', inputmode: 'numeric', value: e.monthly_amount },
        { name: 'paid_on', label: 'Date du paiement', type: 'date', value: today() }] });
      if (!v) return false;
      await post(`/pf/payroll/${e.id}/pay`, { month: d.month, account_id: v.account_id, amount: Math.round(Number(v.amount)), paid_on: v.paid_on });
      return true;
    };
    const run = (fn, ok) => action(fn, { ok: (r) => (r === false ? '' : ok), refresh });
    const unpay = (e) => action(async () => { if (await confirmBox('Annuler ce paiement ?', 'La dépense est annulée et le mois redevient « à payer ».', 'Annuler le paiement', true)) await post(`/pf/payroll/${e.id}/unpay`, { month: d.month }); }, { ok: 'Paiement annulé', refresh });
    const archive = (e) => action(async () => { if (await confirmBox(`Archiver ${e.name} ?`, 'Il n\'apparaît plus dans la paie des prochains mois. Les paiements passés sont conservés.', 'Archiver')) await post(`/pf/payroll/${e.id}/archive`, { archived: true }); }, { ok: 'Employé archivé', refresh });
    const nav = h('div', { class: 'pf-monthnav' },
      h('button', { class: 'pf-monthbtn', type: 'button', 'aria-label': 'Mois précédent', onclick: () => { month = shift(d.month, -1); refresh(); } }, '‹'),
      h('b', {}, monthName(d.month)),
      h('button', { class: 'pf-monthbtn', type: 'button', 'aria-label': 'Mois suivant', onclick: () => { month = shift(d.month, 1); refresh(); } }, '›'));
    const row = (e) => h('div', { class: `pf-emp${e.archived_at ? ' dim' : ''}` },
      h('div', { class: 'pf-row' }, h('span', { class: `pf-ico pf-c-${e.paid_amount != null ? 'green' : 'orange'}` }, icon('user', 22)),
        h('span', { class: 'pf-row-main' }, h('b', {}, e.name), h('span', { class: 'pf-amt' }, fmtGNF(e.paid_amount ?? e.monthly_amount)),
          h('small', {}, [e.job, e.staff_role && ROLE[e.staff_role], e.paid_amount != null ? `Payé le ${new Date(`${e.paid_on}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : 'À payer', e.archived_at && 'archivé'].filter(Boolean).join(' · ')))),
      h('div', { class: 'pf-emp-actions' },
        e.paid_amount == null && !e.archived_at && h('button', { class: 'btn btn-gold btn-sm', type: 'button', onclick: run(() => pay(e), 'Salaire payé') }, 'Payer'),
        e.paid_amount != null && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: unpay(e) }, 'Annuler le paiement'),
        !e.archived_at && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: run(() => askEmployee(e), 'Employé modifié') }, 'Modifier'),
        !e.archived_at && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: archive(e) }, 'Archiver')));
    const pro = d.tier === 'pro';
    host.replaceChildren(head('Paie des employés', { back: ['Plus', () => go('more')] }), h('div', { class: 'pf-pad' }, nav,
      h('section', { class: 'pf-card pf-sum' }, [['À payer', d.due], ['Payé', d.paid], ['Reste', d.unpaid]].map(([l, n]) => h('div', {}, h('small', {}, l), h('b', { class: l === 'Reste' && n > 0 ? 'neg' : '' }, fmtGNF(n))))),
      !pro && h('p', { class: 'pf-note' }, 'La paie des employés fait partie de la formule Pro.'),
      d.employees.length === 0 ? empty('users', 'Aucun employé. Ajoutez vos employés avec leur salaire mensuel : chaque mois, « Payer » enregistre la dépense pour vous.') : h('section', { class: 'pf-card flush' }, d.employees.map(row)),
      pro && h('button', { class: 'btn btn-gold btn-block', type: 'button', onclick: run(() => askEmployee(null), 'Employé ajouté') }, 'Ajouter un employé')));
  };
  return liveView(() => get(`/pf/payroll?month=${month}`), (d, refresh) => { render(d, refresh); return host; });
}
