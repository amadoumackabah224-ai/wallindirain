# Design system Wallindirain (refonte de l'interface)

Marque : **bleu nuit** `#0B1B3B` et **or** `#D4AF37` (logo). Tout est dans `frontend/css/app.css` (jetons en haut du fichier) ; aucun style écrit dans les pages (la politique de sécurité du site l'interdit), aucune ressource externe.

## Jetons
| Jeton | Usage |
|---|---|
| `--navy`, `--navy-2/3`, `--navy-950` | Menu, en-têtes, boutons principaux |
| `--gold`, `--gold-2`, `--gold-3` | Action importante, repères, soldes sur fond sombre |
| `--paper` `#F3F5FA`, `--white`, `--line` | Fond, cartes, séparateurs |
| `--ok` vert · `--warn` ambre · `--bad` rouge · `--info` bleu | Toujours le même sens, partout |
| Rayons `--r-sm 8 / --r 12 / --r-lg 16 / --r-xl 22` · Ombres `--sh-1/2/3` | Cartes, fenêtres |
| Police | **Inter** (fichier dans `frontend/assets/fonts`, licence libre OFL), repli sur la police du téléphone |

## Couleurs de l'argent (tableau de bord vendeur)
Disponible = **vert** (point vert, grand montant) · En attente de déblocage = **ambre** · Gains attendus = **bleu** · Réservé / déjà retiré = **gris**.

## Navigation
- **Téléphone (< 700 px)** : barre du bas (4 onglets principaux + « Plus » qui contient tout le reste, le profil et « Quitter »). Le vendeur a le bouton « Nouvelle » au centre.
- **Tablette (700–1023 px)** : rail d'icônes à gauche.
- **Ordinateur (≥ 1024 px)** : menu latéral complet, onglets regroupés (ex. administrateur : Pilotage, Opérations, Finances, Système).
- Les onglets, leurs clés et les adresses `#/app/…` sont inchangés ; seul l'onglet `dash` (Accueil) a été ajouté pour le vendeur.

## Composants (`frontend/js/ui.js`, `icons.js`, `charts.js`)
Boutons `btn / btn-gold / btn-ghost / btn-ok / btn-bad / btn-sm`, champs, `badge` (avec point de couleur), `card` et `panel`, `metric`, `empty()` (icône + message + action), `pageHead()`, `table()` (devient une liste de cartes sur téléphone), fenêtres `ask()` / `confirmBox()` (feuille qui monte sur téléphone), `toast`, silhouettes de chargement (`skeleton`), `columnChart()` et `segmentBar()` (graphiques sans bibliothèque), `icon('nom')` (jeu d'icônes SVG).

## Revenir en arrière
La version d'avant la refonte porte l'étiquette Git **`avant-refonte-ui`** (`git checkout avant-refonte-ui`). La refonte ne touche que `frontend/` : base de données, API, droits et règles métier ne sont pas modifiés.
