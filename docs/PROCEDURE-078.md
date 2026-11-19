# Migration 078 : proformas

Un devis du vendeur pour un client. **Il ne touche ni le stock, ni l'argent, ni les statistiques.** À la confirmation du client, le vendeur le transforme en commande : la commande est créée par la fonction existante (mêmes contrôles de prix, de stock et de risque, faits à ce moment-là).

- Réglage `feature_proformas`, éteint par défaut (Réglages > Fonctions).
- Validité 1 à 60 jours (15 par défaut) ; une proforma expirée ne peut plus être transformée.
- Transformer deux fois ne crée qu'une commande. Une proforma transformée ne peut plus être annulée.
- Le vendeur voit les siennes ; l'administration voit tout en lecture seule.
- Retour arrière : `docs/retour-arriere-078.sql` (refusé s'il existe des proformas).
