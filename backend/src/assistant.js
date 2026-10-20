// Assistant d'aide : répond aux questions sur Wallindirain et sur le commerce en ligne (livraison, mobile money, marketing digital, sécurité…).
// Ce n'est PAS une intelligence artificielle générative : il compare la question à une base de réponses écrites à l'avance (kb.js).
// Aucun service extérieur, aucune question enregistrée. Quand il ne sait pas, il propose des sujets proches puis oriente vers l'équipe.
import { ALL, KB, CATS } from './kb.js';
export const STAFF = ['agent', 'call_chief', 'courier', 'warehouse', 'admin'];

const strip = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// racine d'un mot : tolère pluriels et conjugaisons (« livraisons » ~ « livraison »)
const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const STOP = new Set(['les', 'des', 'une', 'est', 'que', 'qui', 'pour', 'dans', 'sur', 'pas', 'par', 'mon', 'mes', 'ton', 'ses', 'comment', 'quoi', 'avec', 'sans', 'vous', 'nous', 'moi', 'qu', 'quel', 'quelle', 'faire', 'peut', 'puis', 'ete', 'etre', 'avoir', 'j ai', 'ai']);
const words = (s) => strip(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

const IDX = KB.map((e) => ({ ...e, kn: e.k.map(strip), tw: new Set(words(e.t).map(stem)) }));
const byId = new Map(IDX.map((e) => [e.id, e]));
const roleOf = (role) => (ALL.includes(role) ? role : 'visitor');
const visible = (e, r) => e.roles.includes(r);

function score(e, q, qstems) {
  let s = 0;
  for (const kw of e.kn) {
    if (q.includes(' ' + kw + ' ')) s += 4 + kw.split(' ').length;
    else if (q.includes(kw) && kw.length > 4) s += 3;
    else {
      const ks = words(kw).map(stem);
      if (ks.length && ks.every((w) => qstems.has(w))) s += 2 + ks.length;
      else if (ks.length === 1 && qstems.has(ks[0]) && ks[0].length >= 5) s += 1;
    }
  }
  for (const w of e.tw) if (qstems.has(w)) s += 1;
  return s;
}

const brief = (e) => ({ id: e.id, title: e.t });
const reply = (e, r) => ({
  found: true, id: e.id, title: e.t, text: e.a, team: !!e.team,
  related: (e.rel || []).map((id) => byId.get(id)).filter((x) => x && visible(x, r)).map(brief)
});

export function answer(role, question) {
  const r = roleOf(role);
  const q = ' ' + strip(question) + ' ';
  const qstems = new Set(words(question).map(stem));
  const ranked = IDX.filter((e) => visible(e, r)).map((e) => [e, score(e, q, qstems)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] >= 3) {
    const out = reply(ranked[0][0], r);
    // propose aussi les sujets voisins qui ont bien marqué
    const extra = ranked.slice(1, 4).filter(([, s]) => s >= 3).map(([e]) => brief(e));
    out.related = [...out.related, ...extra.filter((x) => !out.related.some((y) => y.id === x.id))].slice(0, 3);
    return out;
  }
  return {
    found: false, team: true,
    text: 'Je n\'ai pas trouvé de réponse précise à cette question. Essayez avec d\'autres mots, choisissez un sujet ci-dessous, ou écrivez à l\'équipe : un administrateur vous répondra.',
    related: ranked.slice(0, 3).map(([e]) => brief(e))
  };
}

/** Réponse directe à un sujet choisi dans le menu. */
export function topic(role, id) {
  const r = roleOf(role); const e = byId.get(String(id));
  return e && visible(e, r) ? reply(e, r) : null;
}

/** Thèmes et sujets visibles par ce rôle (menu de l'assistant). */
export function topics(role) {
  const r = roleOf(role);
  return CATS.map(([key, label]) => ({ key, label, items: IDX.filter((e) => e.cat === key && visible(e, r) && !e.hide).map(brief) })).filter((c) => c.items.length);
}

export function suggestions(role) {
  const r = roleOf(role);
  const set = {
    visitor: ['C\'est quoi Wallindirain ?', 'Mot de passe oublié', 'Comment créer un compte ?'],
    seller: ['Comment vendre plus ?', 'Comment retirer mon argent ?', 'Vendre avec WhatsApp'],
    supplier: ['Comment ajouter un produit ?', 'Comment annoncer un arrivage ?', 'Comment retirer mon argent ?'],
    agent: ['Comment traiter un appel ?', 'Bien mener l\'appel de confirmation', 'Comment retirer mon argent ?'],
    call_chief: ['Comment traiter un appel ?', 'Le client ne répond pas', 'Comment retirer mon argent ?'],
    courier: ['Comment remettre la caisse ?', 'Valider une livraison', 'Conseils pour bien livrer'],
    warehouse: ['Comment compter un arrivage ?', 'Emballage et état du colis'],
    admin: ['Comment payer un retrait ?', 'Régler les frais', 'Remise à zéro']
  };
  return set[r];
}
