# Cahier des charges v2.0 : correspondance, état réel et décisions

Légende : ✅ implémenté et **vérifié par un test automatique exécuté** · 🔶 implémenté, **non testé en conditions réelles** · ⛔ **non fait** (hors code ou à faire).

## Critères d'acceptation du pilote (§11)

| # | Critère | État | Où / test |
|---|---|---|---|
| 1 | Le vendeur ne voit jamais le fournisseur, et réciproquement | ✅ | `api.test.js` « parcours complet via HTTP + cloisonnement fournisseur / vendeur / client » |
| 2 | Deux agents ne prennent pas la même commande ; chaque appel porte le nom de son auteur | ✅ | `rules.test.js` « critère 2 » |
| 3 | Un livreur ne peut pas livrer sans le code (5 essais) | ✅ | « critère 3 » |
| 4 | Fournisseur + vendeur + Wallindirain = argent encaissé | ✅ | contrôle dans `_settle_delivery` à chaque livraison ; « cohérence comptable globale » |
| 5 | Retrait impossible sans identité vérifiée et sans code | ✅ | « critère 5 » |
| 6 | Écarts de caisse et retours défectueux débités à la bonne personne | ✅ | « critère 6 » et « retours : refus client, défectueux, abîmé » |
| 7 | Un tarif modifié ne change pas les commandes déjà créées | ✅ | « critère 7 » |
| 8 | Données restaurables depuis une sauvegarde, testée | ✅ en développement · 🔶 en production | `ops/restore-test.sh` ; restauration sur serveur PostgreSQL vierge jouée avec succès. À refaire sur le serveur réel. |

## Règles métier (§2 à §6)

| Règle | État |
|---|---|
| Trois formules A / B / C ; stock du vendeur consommé avant celui du catalogue ; annulation par le vendeur avant appel | ✅ |
| Prix vendeur = fournisseur + marge (15 %) ; prix de vente minimum ; exemple chiffré du cahier (résultat 38 000) | ✅ |
| Achat de stock payé d'avance depuis le portefeuille ; arrivage compté par le magasinier avant d'être vendable | ✅ |
| Tarifs par commune modifiables ; client à risque signalé ; commande identique en cours refusée | ✅ |
| Verrou d'appel, escalade après 5 injoignables, libération après 15 min | ✅ |
| Code de livraison à 4 chiffres, déblocage 48 h, caisse du livreur, retraits (min. 50 000, code à 6 chiffres) | ✅ |
| Sécurité : PBKDF2, sessions 12 h, blocage 15 min/5 échecs, droits côté serveur, journal, messages tracés | ✅ |
| Sauvegarde quotidienne **hors du serveur principal** | 🔶 sauvegarde quotidienne faite par le service `backup` ; **la copie hors serveur est à mettre en place** (voir `INSTALLATION.md`) |
| Envoi réel WhatsApp / SMS | 🔶 code présent, **jamais testé contre l'API Meta** ; par défaut les messages sont seulement enregistrés |
| HTTPS | 🔶 Caddy configuré (certificat automatique), **non démarré** pendant le développement |
| Retraits Orange Money / MTN MoMo automatiques | ⛔ paiement manuel en version 1, conformément au cahier |
| Indicateurs de suivi en temps réel | ⛔ tableau de bord actualisé à l'ouverture, pas de flux temps réel |
| Test de charge (phase 2) | ⛔ |
| Contrats, CGV, immatriculation, fiscalité, caution des livreurs | ⛔ hors code, avec un juriste |

## Hypothèses prises là où le cahier ne chiffre pas (à valider par la direction)

1. **Retour « défectueux »** : le fournisseur paie les frais de retour = le tarif de **livraison** de la commande (pas le call center). Le vendeur ayant du stock prépayé en est remboursé.
2. **Retour « abîmé en transport »** : Wallindirain paie au fournisseur le **prix fournisseur** × quantité et rembourse au vendeur son stock prépayé. Le cahier dit seulement « à la charge de Wallindirain ».
3. **Formule C (produit propre) retournée « défectueux »** : traité comme un refus du client (le vendeur paie livraison + call center), car il n'y a pas de fournisseur. **Formule C « abîmé »** : aucun mouvement d'argent.
4. **Frais de retour pour refus du client** = livraison + call center, comme écrit au §4.5.
5. **Clients à risque** : signalés après un refus à l'appel ou un retour pour refus du client (pas après un retour « défectueux » ou « abîmé », qui ne sont pas la faute du client).
6. **Rémunérations** : l'agent est crédité à la **confirmation** (même si la commande n'est pas livrée), le livreur à la **livraison**. Conséquence visible : le « Résultat Wallindirain » du tableau de bord peut être **négatif** tant que les commandes confirmées ne sont pas livrées (ex. −1 000 GNF avec une commande confirmée non livrée). C'est exact comptablement.
7. **Mélange de stocks** : une commande qui consomme à la fois du stock vendeur et du catalogue est enregistrée en formule « AB ».
8. **Ces personnes peuvent retirer** : vendeur, fournisseur, agent, chef, livreur (leurs rémunérations ou gains), après vérification d'identité.
9. **Un manque de caisse** peut rendre le portefeuille du livreur négatif : le solde négatif est compensé par ses prochaines rémunérations (aucun mécanisme de recouvrement automatique).
10. **Surplus de caisse** : enregistré dans le comptage, sans écriture d'argent.

## Décisions de la direction (§12) : valeurs actuelles, toutes modifiables dans « Réglages »

Marge 15 % pour tous les produits (pas de marge par catégorie ; la marge est toutefois fixable **produit par produit** par l'administrateur) · déblocage 48 h · agent 1 000 GNF, livreur 5 000 GNF · retrait minimum 50 000 GNF · frais de stockage : aucun · caution et statut des livreurs, calendrier de paiement, choix de l'hébergeur et du fournisseur WhatsApp : **à décider**.

## Écarts avec la demande initiale

- **React / TypeScript** : demandés, **non utilisés**. Ils nécessitent le registre npm, inaccessible depuis l'environnement de développement. L'interface est en JavaScript natif (modules ES) et le serveur en Node.js sans dépendance. Une migration vers React/TypeScript reste possible plus tard : l'API HTTP est indépendante de l'interface.
- **« Sans erreur de code »** : aucun logiciel ne peut en garantir l'absence. Ce qui est établi : 27 tests automatiques sur une vraie base, des scénarios SQL indépendants, un parcours navigateur sur chaque rôle sans erreur JavaScript. Une recette (test avec de vrais utilisateurs) pendant le pilote reste indispensable.
