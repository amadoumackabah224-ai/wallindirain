// Pages légales (mentions, confidentialité, conditions, cookies, retours) servies sous /legal/.
// Les textes sont des modèles HTML dans backend/legal/ ; les {{CHAMPS}} sont remplacés par l'identité de l'éditeur
// (variables LEGAL_*). Un champ non renseigné s'affiche « À COMPLÉTER » : on ne publie jamais une information inventée.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'legal');

export const PAGES = [
  ['mentions-legales', 'Mentions légales'],
  ['confidentialite', 'Politique de confidentialité'],
  ['conditions', 'Conditions d\'utilisation'],
  ['cookies', 'Politique de cookies'],
  ['retours-remboursements', 'Retours et remboursements']
];

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
  const template = (slug) => {
    if (!cache.has(slug)) cache.set(slug, fs.readFileSync(path.join(dir, `${slug}.html`), 'utf8'));
    return cache.get(slug);
  };
  const nav = (current) => PAGES.map(([s, t]) => `<li><a href="/legal/${s}"${s === current ? ' aria-current="page"' : ''}>${esc(t)}</a></li>`).join('');

  function layout(title, description, body, current) {
    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Wallindirain</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#0B1B3B">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="/css/legal.css">
</head>
<body class="legal-body">
<a class="skip" href="#contenu">Aller au contenu</a>
<header class="legal-top"><div class="legal-in">
  <a href="/" class="legal-brand"><img src="/assets/logo-gold.png" alt="Wallindirain, retour à l'accueil" width="150" height="38"></a>
  <a class="btn btn-sm btn-gold" href="/">Ouvrir l'application</a>
</div></header>
<div class="legal-wrap">
  <nav class="legal-nav" aria-label="Pages légales"><ul>${nav(current)}</ul></nav>
  <main id="contenu" class="legal-main"><article>${body}</article></main>
</div>
<footer class="legal-foot"><div class="legal-in">
  <p>Wallindirain · version des textes : ${value('VERSION')} · contact : <a href="tel:+224${esc(cfg.contactPhone)}">${value('CONTACT_PHONE')}</a></p>
  <p><a href="/#/demande-donnees">Exercer mes droits sur mes données</a></p>
</div></footer>
</body>
</html>`;
  }

  /** Renvoie le HTML de la page, ou null si elle n'existe pas. */
  return function render(slug) {
    if (slug === '' || slug === 'index') {
      const items = PAGES.map(([s, t]) => `<li><a href="/legal/${s}">${esc(t)}</a></li>`).join('');
      return layout('Informations légales', 'Mentions légales, confidentialité, conditions d\'utilisation, cookies et retours de la plateforme Wallindirain.',
        `<h1>Informations légales</h1><p>Retrouvez ici les règles qui s'appliquent à l'utilisation de Wallindirain et à la protection de vos données.</p><ul>${items}</ul>`, '');
    }
    const page = PAGES.find(([s]) => s === slug);
    if (!page) return null;
    const body = template(slug).replace(/\{\{([A-Z_]+)\}\}/g, (_, t) => value(t));
    return layout(page[1], `${page[1]} de la plateforme Wallindirain.`, body, slug);
  };
}
