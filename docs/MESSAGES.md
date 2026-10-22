# Envoyer de vrais messages aux clients (WhatsApp)

## Pourquoi des « modèles »
Quand c'est Wallindirain qui écrit en premier (code de livraison, alerte…), WhatsApp **interdit le texte libre** : il faut utiliser des **modèles de message approuvés à l'avance par Meta**. L'application envoie donc deux modèles :

| Modèle | Sert pour | Variable |
|---|---|---|
| `wld_code` | code de livraison, code de retrait, mot de passe oublié | `{{1}}` = le code |
| `wld_info` | confirmation de commande, retrait payé, réponse du support, mot de passe temporaire, alertes | `{{1}}` = le texte du message |

## Mise en place (compte Meta, environ une à deux semaines avec la vérification)
1. Créez un compte **Meta Business** (business.facebook.com) et une application « Business » sur developers.facebook.com avec le produit **WhatsApp**.
2. Ajoutez un **numéro dédié** à WhatsApp Business (pas un numéro déjà utilisé sur WhatsApp ordinaire). Faites la **vérification de l'entreprise** demandée par Meta (documents de la société).
3. Dans **WhatsApp Manager → Modèles de message**, créez en **français** :
   - `wld_code`, catégorie **Authentification** : « votre code est {{1}} » (Meta ajoute le texte de sécurité et le bouton « Copier le code »). Si vous choisissez cette catégorie, mettez `WHATSAPP_CODE_BUTTON=1`.
   - `wld_info`, catégorie **Utilitaire** : « Wallindirain - Information sur votre commande ou votre compte : {{1}} ».
   Attendez l'approbation (quelques minutes à quelques heures). Si Meta classe un modèle autrement que prévu, gardez la catégorie qu'il impose.
4. Créez un **jeton d'accès permanent** (utilisateur système) et notez l'**identifiant du numéro** (Phone number ID).
5. Sur Render → Environment :
   - `MESSAGE_PROVIDER` = `whatsapp`
   - `WHATSAPP_TOKEN` = le jeton
   - `WHATSAPP_PHONE_ID` = l'identifiant du numéro
   - (facultatif) `WHATSAPP_TEMPLATE_CODE`, `WHATSAPP_TEMPLATE_INFO`, `WHATSAPP_LANG`, `WHATSAPP_CODE_BUTTON`
   - **Supprimez `SHOW_TEST_CODES`** : le serveur refuse de démarrer avec un vrai fournisseur.
6. Dans Wallindirain, activez ensuite le code de livraison si vous le voulez (réglage « code de livraison »).

## Coût et limites
- Meta facture à la conversation (selon le pays et le type de message) ; il y a un petit quota gratuit chaque mois. Vérifiez la grille tarifaire de Meta pour la Guinée avant de lancer.
- Le client doit avoir WhatsApp sur ce numéro. Sinon l'envoi échoue : l'écran administrateur (Journal → Messages) affiche « Échec » avec la raison, et l'équipe appelle le client.
- Après un envoi réussi, les codes sont effacés du texte conservé dans la base.
- Les e-mails sont une option séparée (voir `docs/EMAIL.md`).
