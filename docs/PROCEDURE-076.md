# Migration 076 : session longue

Une personne reste connectée tant qu'elle revient régulièrement : la session se prolonge à chaque utilisation (30 jours d'inactivité, 7 jours pour l'administration). Elle ne se déconnecte que si elle clique sur « Se déconnecter », change son mot de passe, ou reste absente plus longtemps. Aucune donnée supprimée. Retour arrière : `docs/retour-arriere-076.sql` (les sessions retombent à 12 h au plus).

Appareil partagé : la personne doit utiliser « Se déconnecter ».
