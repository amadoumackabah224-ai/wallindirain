// Assistant d'aide : répond aux questions fréquentes sur l'utilisation de Wallindirain.
// Ce n'est PAS une intelligence artificielle générative : il compare la question à une base de réponses écrites à l'avance
// (aucun service extérieur, aucune question enregistrée). Quand il ne sait pas, il oriente vers l'équipe.
const ALL = ['visitor', 'seller', 'supplier', 'agent', 'call_chief', 'courier', 'warehouse', 'admin'];
const STAFF = ['agent', 'call_chief', 'courier', 'warehouse', 'admin'];

const KB = [
  { roles: ALL, k: ['mot de passe oublie', 'oublie', 'perdu mot de passe', 'reinitialiser mot de passe', 'connexion impossible', 'je ne peux pas me connecter'],
    a: 'Mot de passe oublié : sur l\'écran de connexion, touchez « Mot de passe oublié » et suivez les étapes (un code vous est envoyé par message). Si le message n\'arrive pas, écrivez à l\'équipe avec le bouton « Écrire à l\'équipe » : un administrateur vous enverra un mot de passe temporaire par message, que vous changerez ensuite dans Profil.', team: true },
  { roles: ALL, k: ['compte bloque', 'bloque', 'verrouille', 'trop de tentatives', 'locked'],
    a: 'Après plusieurs mots de passe erronés, le compte est bloqué quelques minutes pour vous protéger. Patientez puis réessayez, ou écrivez à l\'équipe pour qu\'un administrateur le débloque.', team: true },
  { roles: ['visitor', 'supplier'], k: ['compte pas active', 'pas active', 'en attente', 'validation', 'attend la validation', 'fournisseur pas active', 'activer'],
    a: 'Le compte d\'un fournisseur est créé « en attente » : un administrateur doit le valider (Utilisateurs → Activer) avant la première connexion. Ensuite, chaque produit doit lui aussi être validé avant d\'apparaître chez les vendeurs. Si l\'attente est longue, écrivez à l\'équipe.', team: true },
  { roles: ALL, k: ['changer mot de passe', 'modifier mot de passe', 'nouveau mot de passe'],
    a: 'Allez dans l\'onglet Profil → « Changer mon mot de passe » : saisissez l\'ancien, puis le nouveau (8 caractères au moins, avec lettres et chiffres).' },
  { roles: ALL, k: ['photo', 'avatar', 'photo de profil'],
    a: 'Onglet Profil → « Photo de profil » : choisissez une image, elle est réduite automatiquement. La photo est facultative et visible seulement de vous et de l\'administration.' },
  { roles: ['seller', 'supplier', 'agent', 'call_chief', 'courier'], k: ['changer numero', 'numero de versement', 'numero de depot', 'orange money', 'mtn', 'momo', 'modifier numero'],
    a: 'Onglet Profil → « Numéro de versement » : choisissez l\'opérateur, saisissez le nouveau numéro et confirmez avec votre mot de passe. L\'ancien numéro reçoit un message d\'alerte. Impossible tant qu\'un retrait est en attente.' },
  { roles: ['seller', 'supplier', 'agent', 'call_chief', 'courier'], k: ['retrait', 'retirer', 'argent', 'payer', 'paiement', 'portefeuille', 'solde', 'virement'],
    a: 'Portefeuille → « Demander un retrait » : le montant doit atteindre le minimum indiqué, votre identité doit être vérifiée, et un code reçu par message confirme la demande. L\'administration envoie ensuite l\'argent sur votre numéro Orange Money ou MTN MoMo et joint la capture du transfert, que vous retrouvez dans votre portefeuille.' },
  { roles: ['seller', 'supplier'], k: ['piece identite', 'identite', 'verification', 'cni', 'passeport'],
    a: 'Avant le premier retrait, l\'administration doit vérifier votre pièce d\'identité. Saisissez simplement son numéro dans Portefeuille (aucune photo n\'est demandée). Après vérification, elle ne peut plus être modifiée.' },
  { roles: ['seller'], k: ['lien', 'partager', 'vendre', 'commande client', 'catalogue', 'produit'],
    a: 'Choisissez un produit validé dans le catalogue, fixez votre prix de vente, puis partagez votre lien personnel : le client y laisse son nom, son téléphone et son adresse. Il ne voit jamais le fournisseur. Un conseiller l\'appelle pour confirmer.' },
  { roles: ['seller'], k: ['marge', 'gain', 'benefice', 'combien je gagne', 'prix de vente'],
    a: 'Votre gain = prix de vente − prix du fournisseur − marge de la plateforme − frais de livraison. Les montants exacts figurent sur chaque commande. Ils sont figés à la création de la commande.' },
  { roles: ['supplier'], k: ['ajouter produit', 'nouveau produit', 'produit refuse', 'valider produit', 'arrivage', 'stock', 'envoyer stock'],
    a: 'Ajoutez votre produit avec votre prix : l\'administration le valide. Annoncez ensuite un arrivage ; le magasinier compte les articles reçus et seul le stock compté devient vendable.' },
  { roles: ['agent', 'call_chief'], k: ['appel', 'prendre commande', 'confirmer', 'injoignable', 'refuse', 'client ne repond pas'],
    a: 'Prenez une commande dans « À appeler », appelez le client, puis choisissez le résultat : Confirmée, Injoignable (elle retourne dans la file, avec une limite d\'essais) ou Refusée. Un client qui refuse plusieurs fois est signalé aux autres conseillers.' },
  { roles: ['courier'], k: ['livrer', 'livraison', 'colis', 'valider livraison', 'code client', 'code livraison'],
    a: 'Ouvrez le colis, partez en livraison, encaissez le montant puis validez « Livré ». Selon le réglage de l\'administration, le client peut devoir vous donner un code à 4 chiffres. Si le client refuse, indiquez-le : le colis retourne au stock.' },
  { roles: ['courier'], k: ['caisse', 'cash', 'remettre', 'verser', 'capture', 'transfert client', 'espece', 'especes'],
    a: 'Onglet Caisse : l\'argent encaissé est à remettre. Vous pouvez le remettre en espèces (comptage par l\'administration) ou par transfert avec une capture d\'écran. Si le client a payé par transfert, déclarez-le avec sa capture. Un manque constaté est déduit de votre rémunération.' },
  { roles: ['warehouse'], k: ['compter', 'arrivage', 'stock', 'reception', 'inventaire'],
    a: 'Onglet Arrivages : comptez ce qui est réellement reçu et saisissez la quantité. Elle remplace la quantité annoncée par le fournisseur et rend le stock vendable.' },
  { roles: ['admin'], k: ['activer', 'valider fournisseur', 'utilisateur', 'creer compte', 'agent', 'livreur', 'suspendre'],
    a: 'Utilisateurs : créez les comptes du personnel, activez les fournisseurs en attente, suspendez, débloquez ou réinitialisez un mot de passe. Chaque action sensible est enregistrée dans le journal.' },
  { roles: ['admin'], k: ['retrait', 'payer retrait', 'capture', 'preuve', 'remise', 'confirmer remise', 'caisse'],
    a: 'Retraits : envoyez l\'argent depuis votre compte Orange Money / MTN MoMo sur le numéro affiché, puis cliquez « Payer » et joignez la capture du transfert. Remises : confirmez ou rejetez les remises des livreurs après avoir comparé la capture et le montant reçu.' },
  { roles: ['admin'], k: ['reinitialiser', 'remise a zero', 'effacer', 'tout effacer', 'donnees de test', 'repartir'],
    a: 'Onglet Données → « Remise à zéro » : efface commandes, argent, appels, arrivages et messages, en gardant les comptes, produits et réglages. Il faut taper REINITIALISER et saisir votre mot de passe. L\'opération est irréversible.' },
  { roles: ALL, k: ['confidentialite', 'donnees personnelles', 'supprimer mon compte', 'supprimer mes donnees', 'cookie', 'rgpd', 'droits'],
    a: 'Vos droits (accès, correction, suppression, opposition) s\'exercent via le formulaire « Mes données » ou en écrivant à l\'équipe. Les textes complets sont dans les pages légales : Confidentialité, Conditions, Cookies, Retours.' },
  { roles: ALL, k: ['contact', 'appeler', 'urgence', 'urgent', 'parler a quelqu un', 'humain', 'support', 'aide'],
    a: 'Pour une urgence ou une question que je ne sais pas traiter, écrivez à l\'équipe avec le bouton « Écrire à l\'équipe » : un administrateur vous répond.', team: true }
];

const strip = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const KB_N = KB.map((e) => ({ ...e, kn: e.k.map(strip) }));

export function answer(role, question) {
  const r = ALL.includes(role) ? role : 'visitor';
  const q = ' ' + strip(question) + ' ';
  const words = new Set(q.trim().split(' ').filter((w) => w.length > 2));
  let best = null; let bestScore = 0;
  for (const e of KB_N) {
    if (!e.roles.includes(r)) continue;
    let score = 0;
    for (const kw of e.kn) {
      if (q.includes(' ' + kw + ' ') || q.includes(kw)) score += 3 + kw.split(' ').length;
      else { const kws = kw.split(' ').filter((w) => w.length > 3); if (kws.length && kws.every((w) => words.has(w))) score += 2; }
    }
    if (score > bestScore) { best = e; bestScore = score; }
  }
  if (!best || bestScore < 3) {
    return { found: false, text: 'Je n\'ai pas trouvé de réponse écrite à cette question. Reformulez avec d\'autres mots, ou écrivez à l\'équipe : un administrateur vous répondra.', team: true };
  }
  return { found: true, text: best.a, team: !!best.team };
}

export function suggestions(role) {
  const r = ALL.includes(role) ? role : 'visitor';
  const set = {
    visitor: ['Mot de passe oublié', 'Mon compte fournisseur n\'est pas activé', 'Comment supprimer mes données ?'],
    seller: ['Comment partager mon lien ?', 'Comment retirer mon argent ?', 'Changer mon numéro de versement'],
    supplier: ['Mon produit n\'est pas visible', 'Comment annoncer un arrivage ?', 'Comment retirer mon argent ?'],
    agent: ['Comment traiter un appel ?', 'Le client ne répond pas', 'Comment retirer mon argent ?'],
    call_chief: ['Comment traiter un appel ?', 'Le client ne répond pas', 'Comment retirer mon argent ?'],
    courier: ['Comment remettre la caisse ?', 'Valider une livraison', 'Comment retirer mon argent ?'],
    warehouse: ['Comment compter un arrivage ?'],
    admin: ['Comment payer un retrait ?', 'Réinitialiser les données', 'Activer un fournisseur']
  };
  return set[r];
}
export { STAFF };
