// Textes légaux (mentions, confidentialité, conditions, cookies, retours) : lus DANS l'application (/api/public/legal), aucune page externe.
// Les textes sont des modèles HTML dans backend/legal/ ; les {{CHAMPS}} sont remplacés par l'identité de l'éditeur
// (variables LEGAL_*). Un champ non renseigné s'affiche « À COMPLÉTER » : on ne publie jamais une information inventée.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'legal');

// Chaque texte s'adresse à un public : « public » (tout visiteur) ou un rôle. Chacun ne voit que ses propres textes.
//   client, seller (vendeur), supplier (fournisseur), courier (livreur), team (agents, chefs du call center, magasinier)
export const DOCS = [
  { slug: 'mentions-legales', title: 'Mentions légales', audience: 'public' },
  { slug: 'cookies', title: 'Politique de cookies', audience: 'public' },
  { slug: 'conditions-client', title: 'Conditions d\'achat', audience: 'client' },
  { slug: 'confidentialite-client', title: 'Confidentialité', audience: 'client' },
  { slug: 'retours-remboursements', title: 'Retours et remboursements', audience: 'client' },
  { slug: 'conditions-vendeur', title: 'Conditions du vendeur', audience: 'seller' },
  { slug: 'confidentialite-vendeur', title: 'Confidentialité', audience: 'seller' },
  { slug: 'conditions-fournisseur', title: 'Conditions du fournisseur', audience: 'supplier' },
  { slug: 'confidentialite-fournisseur', title: 'Confidentialité', audience: 'supplier' },
  { slug: 'conditions-livreur', title: 'Conditions du livreur', audience: 'courier' },
  { slug: 'confidentialite-livreur', title: 'Confidentialité', audience: 'courier' },
  { slug: 'regles-equipe', title: 'Règles de l\'équipe', audience: 'team' },
  { slug: 'confidentialite-equipe', title: 'Confidentialité', audience: 'team' }
];
export const PAGES = DOCS.map((d) => [d.slug, d.title]);
export const AUDIENCE_LABEL = { client: 'Client', seller: 'Vendeur', supplier: 'Fournisseur', courier: 'Livreur', team: 'Équipe' };
// Ces trois publics lisent leurs textes AVANT d'avoir un compte (commande, inscription) : ils sont donc ouverts à tous.
// Les textes des livreurs et de l'équipe ne sont lisibles que connecté, avec le bon rôle (ou administrateur).
export const OPEN_AUDIENCES = ['client', 'seller', 'supplier'];

/** Public d'un rôle : administrateur = 'all' (voit tout), les autres rôles leur public, sinon null. */
export const audienceOf = (role) => ({ admin: 'all', seller: 'seller', supplier: 'supplier', courier: 'courier', agent: 'team', call_chief: 'team', warehouse: 'team' })[role] || null;

/** Textes qu'un public peut consulter : les textes publics + les siens ('all' = tous). */
export const docsFor = (audience) => DOCS.filter((d) => d.audience === 'public' || audience === 'all' || d.audience === audience);

/** Un visiteur (audience null) ou un connecté peut-il lire ce texte ? */
export const canRead = (slug, viewerAudience) => {
  const d = DOCS.find((x) => x.slug === slug);
  if (!d) return false;
  return d.audience === 'public' || OPEN_AUDIENCES.includes(d.audience) || viewerAudience === 'all' || viewerAudience === d.audience;
};

/** Résumé de cinq lignes montré avant d'accepter, propre à chaque public. */
export const SUMMARY = {
  client: 'Pour livrer votre commande, nous gardons votre nom, votre téléphone et votre adresse. Vous payez en espèces au livreur, à la livraison. Nous n\'avons aucune donnée de carte bancaire. Vous pouvez demander à voir, corriger ou supprimer vos données (réponse sous 30 jours).',
  seller: 'Nous gardons votre nom, votre téléphone, votre numéro de versement et, avant votre premier retrait, une pièce d\'identité avec selfie. Vous gardez la différence entre votre prix de vente et vos coûts ; les frais sont affichés dans votre espace. Vous ne voyez jamais le fournisseur. Les retraits sont payés par l\'administration sur votre Orange Money ou MTN MoMo.',
  supplier: 'Nous gardons votre nom, votre téléphone, votre numéro de versement, vos produits et, avant votre premier retrait, une pièce d\'identité avec selfie. Vos produits sont validés par l\'administration. Vous ne voyez jamais le vendeur ni le client, et ils ne vous voient jamais.',
  courier: 'Vous encaissez l\'argent à la livraison et le reversez à Wallindirain. Un manque constaté à la caisse est déduit de votre rémunération. Vous voyez les coordonnées des clients de vos colis seulement pour les livrer.',
  team: 'Les coordonnées des clients ne servent qu\'à votre travail : confirmer, préparer ou suivre les commandes. Vous ne les copiez ni ne les partagez. Vos actions sont enregistrées, et les vendeurs ne voient jamais votre nom.'
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const frDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`; };

/** Champs de l'éditeur : [clé de config, libellé affiché si manquant] */
export const LEGAL_FIELDS = {
  NAME: ['name', 'raison sociale ou nom de l\'éditeur (LEGAL_NAME)'],
  FORM: ['form', 'forme juridique (LEGAL_FORM)'],
  ADDRESS: ['address', 'adresse du siège (LEGAL_ADDRESS)'],
  EMAIL: ['email', 'adresse e-mail de contact (LEGAL_EMAIL)'],
  RCCM: ['rccm', 'numéro RCCM (LEGAL_RCCM)'],
  NIF: ['nif', 'numéro d\'identification fiscale (LEGAL_NIF)'],
  DIRECTOR: ['director', 'directeur de la publication (LEGAL_DIRECTOR)'],
  HOSTING_REGION: ['hostingRegion', 'pays ou région des serveurs (HOSTING_REGION)'],
  RETURN_DAYS: ['returnDays', 'délai de réclamation après livraison (LEGAL_RETURN_DAYS)']
};

/** Liste des informations légales encore manquantes (affichée à l'administrateur). */
export function legalMissing(cfg) {
  return Object.values(LEGAL_FIELDS).filter(([k]) => !cfg.legal[k]).map(([, label]) => label);
}

export function createLegal(cfg) {
  const todo = (label) => `<mark class="todo">[À COMPLÉTER : ${esc(label)}]</mark>`;
  const value = (token) => {
    if (token === 'CONTACT_PHONE') return esc(cfg.contactPhone.replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4'));
    if (token === 'CONTACT_PHONE_RAW') return esc(cfg.contactPhone);
    if (token === 'DATE') return esc(frDate(cfg.legal.version));
    if (token === 'VERSION') return esc(cfg.legal.version);
    const f = LEGAL_FIELDS[token];
    if (!f) return todo(token);
    const v = cfg.legal[f[0]];
    if (!v) return todo(f[1]);
    return token === 'RETURN_DAYS' ? esc(`${v} jour${Number(v) > 1 ? 's' : ''}`) : esc(v);
  };
  const cache = new Map();
  const file = (folder, name) => {
    const key = `${folder}/${name}`;
    if (!cache.has(key)) cache.set(key, fs.readFileSync(path.join(dir, folder, `${name}.html`), 'utf8'));
    return cache.get(key);
  };
  // les morceaux communs (partials/) sont inclus avec {{include:nom}}, jusqu'à 3 niveaux
  const expand = (html, depth = 0) => (depth > 3 ? html : html.replace(/\{\{include:([a-z-]+)\}\}/g, (_, n) => expand(file('partials', n).trimEnd(), depth + 1)));
  const template = (slug) => expand(fs.readFileSync(path.join(dir, `${slug}.html`), 'utf8'));
  /** Contenu d'une page pour l'affichage DANS l'application : { slug, title, html, version }, ou null. */
  const content = (slug) => {
    const page = DOCS.find((d) => d.slug === slug);
    if (!page) return null;
    return { slug, title: page.title, audience: page.audience, version: cfg.legal.version, html: template(slug).replace(/\{\{([A-Z_]+)\}\}/g, (_, t) => value(t)) };
  };

  return { content };
}
