# Verrouillage de l'application (sans migration)

## Ce que ça fait
- Dans **Mon profil → Verrouillage de l'application**, chaque personne peut activer un **code de 4 à 6 chiffres**. Désactivé par défaut. Aucun changement de base de données.
- L'application demande le code à l'ouverture, puis quand on la quitte plus longtemps que le délai choisi (tout de suite, 1, 5 ou 15 minutes).
- Si le téléphone le permet, **empreinte ou visage** peut déverrouiller à la place du code.
- Le code reste **sur le téléphone** (jamais envoyé sur Internet) ; seule son empreinte cryptographique (PBKDF2 + sel) y est gardée.
- Essais : 5 erreurs = attente (30 s puis plus), 10 erreurs = déconnexion forcée.
- **Code oublié** : « Se déconnecter » puis reconnexion avec le mot de passe ; le code est alors retiré.
- Le code est propre à chaque personne : sur un téléphone partagé, il s'efface si quelqu'un d'autre se connecte.

## Limite à connaître
Le verrouillage protège l'écran de l'application ; il ne remplace ni le mot de passe du compte ni le verrouillage du téléphone. L'empreinte ou le visage est vérifié par le téléphone lui-même.
