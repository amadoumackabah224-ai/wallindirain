# Migration 074 : annonces en fenêtre

À déployer après la 073. Aucune donnée n'est modifiée ni supprimée. Éteint par défaut.

## Ce que ça fait
Une annonce = image (facultative), titre, texte, bouton (facultatif), public, dates, fréquence. Elle s'affiche en fenêtre à l'ouverture de l'application, avec une croix rouge pour fermer. L'administrateur voit combien de personnes l'ont vue, ont cliqué ou ont fermé.

## Mettre en service
1. Annonces (espace administrateur) : « Annonces en fenêtre » → **Nouvelle annonce** (elle est enregistrée en brouillon).
2. **Aperçu** pour voir le rendu, puis **Publier**.
3. Allumer l'interrupteur « Annonces en fenêtre » (aussi dans Réglages > Fonctions). Tant qu'il est éteint, rien ne s'affiche à personne.

## Règles de sécurité
- Le bouton ne peut ouvrir qu'une adresse **https** ou un écran de l'application (aucun autre type de lien).
- Image : JPEG, PNG ou WebP, 700 Ko au maximum ; elle est servie uniquement aux personnes connectées.
- Une annonce se met en brouillon ou à l'archive : rien n'est supprimé.

## Retour arrière
`docs/retour-arriere-074.sql` : refusé s'il existe des annonces (rien n'est perdu).
