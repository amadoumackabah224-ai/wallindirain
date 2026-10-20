# Conformité, données personnelles et accessibilité

> Ce document n'est **pas un avis juridique**. Il décrit ce que fait la plateforme, ce qui a été vérifié et ce qui reste à faire confirmer par un juriste guinéen avant la mise en service réelle.

## 1. Ce qui a été mis en place

| Sujet | Réalisation |
|---|---|
| Textes légaux | Lus **dans l'application** (fenêtre de lecture, avant et après connexion) via `/api/public/legal` — il n'existe plus de pages `/legal/` externes : mentions légales, confidentialité, conditions d'utilisation, cookies, retours et remboursements. Textes dans `backend/legal/`, identité de l'éditeur dans les variables `LEGAL_*` (Render). Un champ vide s'affiche « À COMPLÉTER » : rien d'inventé n'est publié. |
| Consentement | Case à cocher à l'inscription (conditions + confidentialité + 18 ans) et à la commande du client. La version acceptée et la date sont enregistrées (`consents`, ajout seul). Pour un client sans compte, seule une **empreinte SHA-256** du téléphone est gardée. |
| Droits des personnes | Formulaire public `/#/demande-donnees` → onglet admin **Données** ; clôture avec note ; anonymisation d'un compte (bouton dans Utilisateurs). |
| Conservation limitée | Purge automatique (au démarrage puis toutes les 6 h) : `fn_purge_old_data` et `fn_purge_support`. |
| Minimisation | Pièce d'identité : numéro + photos (recto, verso facultatif, selfie avec la pièce), demandées avant le premier retrait ; visibles du propriétaire et des administrateurs seulement ; chaque consultation par un administrateur est journalisée et visible de la personne ; effacées à l'anonymisation. Aucune IP en base, aucune géolocalisation, aucun cookie hors session. |
| Accessibilité | Lien d'évitement, repères `main`/`nav`, titres, `lang="fr"`, textes alternatifs sur toutes les images, tableaux avec `th scope`, fenêtres avec `aria-labelledby` et focus piégé, `noscript`, `robots.txt`, `llms.txt`. Contrôle automatique axe-core (WCAG 2 A/AA + bonnes pratiques) sur tous les écrans de tous les rôles : 0 violation. Contrastes recalculés : tous ≥ 4,5:1. |
| Cookies | Un seul cookie, `wld_session` (connexion, strictement nécessaire). **Pas de bandeau de consentement nécessaire** : aucun traceur, aucune mesure d'audience, aucune ressource externe. |

## 2. Inventaire des données collectées

| Donnée | Où | Pourquoi | Conservation |
|---|---|---|---|
| Nom, téléphone, commune, adresse, note du client | `orders` | Appel de confirmation, livraison | 5 ans après clôture, puis anonymisés (« Client anonymisé ») |
| Nom, téléphone, mot de passe (PBKDF2), équipe | `users` | Compte | Tant que le compte existe ; effacés à l'anonymisation |
| Numéro de la pièce d'identité | `users.identity_doc` | Vérification avant retrait | Idem |
| Photos de la pièce et selfie | `identity_documents` (colonnes `front`, `back`, `selfie`, illisibles directement) | KYC : vérifier l'identité avant versement | Jusqu'à anonymisation du compte |
| Opérateur et numéro de versement | `users` | Payer les retraits | Idem |
| Lien du Google Sheet du vendeur + lignes importées | `seller_sheets`, `sheet_imports`, `orders` | Créer des commandes depuis le tableur | Lien : tant que le vendeur le garde ; commandes : 5 ans |
| Photo de profil (facultative) | `avatars` | Reconnaissance dans l'application | Jusqu'à suppression / anonymisation |
| Écritures d'argent, retraits, caisses, captures de transfert | `wallet_entries`, `withdrawals`, `remittances`, `proofs`… | Comptabilité, preuve de paiement | Pièces comptables : conservées, sans nom après anonymisation |
| Appels (agent, résultat, note) | `calls` | Traçabilité | Avec la commande (5 ans) |
| Messages envoyés (WhatsApp / SMS) | `messages` | Prévenir, sécuriser | 90 jours ; codes masqués après envoi |
| Clients signalés | `risky_customers` | Alerter les conseillers | 24 mois |
| Journal des actions | `audit_log` | Sécurité, traçabilité | Conservé (aucun mot de passe) |
| Demandes sur les données | `data_requests` | Répondre | 1 an après traitement |
| Messages à l'équipe | `support_*` | Aide, mot de passe oublié | 1 an après fermeture |
| Consentements | `consents` | Preuve d'acceptation | Conservés |
| Session | cookie `wld_session` + `sessions` | Connexion | 12 h |

**Non collecté** : géolocalisation, contacts, micro/caméra, carte bancaire, cookies publicitaires, outils d'analyse, données de santé ou de religion ; pas de reconnaissance faciale (le selfie est comparé à l'œil par un administrateur).

## 3. Ce qui a été vérifié, et ce qui ne l'a pas été

**Vérifié (sources consultées en octobre 2026)**
- Loi guinéenne **L/2016/037/AN** sur la cybersécurité et la protection des données personnelles : déclaration préalable (art. 5), exemptions (art. 6), autorisation pour certains traitements, dont les numéros d'identification nationaux ou téléphoniques, et pour les transferts hors CEDEAO (art. 7), sanctions lourdes.
- Aucune règle spécifique sur les cookies, et aucune obligation légale expresse de notification de violation, n'a été trouvée : la plateforme s'engage quand même à informer.

**Non vérifié / incertain**
- L'autorité de protection des données est mal identifiée et semble peu opérationnelle selon des sources de 2021-2022 : il faut **demander à un avocat** comment déposer la déclaration et obtenir le récépissé.
- Les textes sur la **protection du consommateur** (L/94/003/CTRN) et sur les **transactions électroniques** (L/2016/034/AN) n'ont pas pu être lus en entier. Un **droit légal de rétractation** pour la vente à distance n'a **pas** été confirmé : la page « Retours et remboursements » décrit ce que la plateforme fait réellement (délai `LEGAL_RETURN_DAYS`), pas un droit légal.
- Le traitement du **numéro de téléphone, de la pièce d'identité et de sa photo (donnée sensible)** peut exiger une **autorisation** (art. 7). Le **transfert vers Render / Neon** (hors CEDEAO) aussi. Ce sont les deux risques principaux.
- La clause « tribunaux de Conakry » et la répartition des coûts de retour sont des **choix du propriétaire**, à faire valider.

## 4. À faire avant la mise en service réelle

1. Renseigner dans Render : `LEGAL_NAME`, `LEGAL_FORM`, `LEGAL_ADDRESS`, `LEGAL_EMAIL`, `LEGAL_RCCM`, `LEGAL_NIF`, `LEGAL_DIRECTOR`, `HOSTING_REGION`, `LEGAL_RETURN_DAYS`. L'onglet « Tableau » de l'admin liste ce qui manque.
2. Faire relire les cinq pages légales par un avocat guinéen ; demander la déclaration / l'autorisation (téléphone, pièce d'identité, transfert hors CEDEAO).
3. Retirer `SHOW_TEST_CODES` (les codes ne doivent plus être lisibles) et brancher un vrai fournisseur de messages (`MESSAGING_PROVIDER`).
4. Faire la **remise à zéro des activités** (admin → Données) pour repartir avec de vraies informations.
5. Si le code de livraison est réactivé (Réglages), les commandes confirmées pendant qu'il était désactivé n'ont pas de code.

## 5. Assistant et messagerie
- L'assistant d'aide n'est **pas une IA générative** : il répond avec des textes écrits à l'avance (`backend/src/assistant.js`), n'envoie rien à un service extérieur et n'enregistre pas les questions.
- La messagerie avec l'équipe stocke nom, téléphone et messages (1 an après fermeture). L'aide (assistant et messagerie) est réservée aux personnes connectées ; avant connexion, seul le numéro de contact est affiché. Le **mot de passe temporaire** est envoyé par message, jamais écrit dans la conversation, et masqué dans le journal après envoi.
