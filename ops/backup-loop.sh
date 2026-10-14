#!/bin/sh
# Lance backup.sh chaque jour à BACKUP_HOUR_UTC (heure UTC = heure de Conakry).
set -u
HOUR="${BACKUP_HOUR_UTC:-2}"
while true; do
  NOW_H="$(date -u +%H | sed 's/^0//')"; NOW_M="$(date -u +%M | sed 's/^0//')"
  : "${NOW_H:=0}" "${NOW_M:=0}"
  WAIT=$(( ( (HOUR - NOW_H + 24) % 24 ) * 3600 - NOW_M * 60 ))
  [ "$WAIT" -le 0 ] && WAIT=$(( WAIT + 86400 ))
  echo "Prochaine sauvegarde dans ${WAIT}s"
  sleep "$WAIT"
  sh /ops/backup.sh || echo "ÉCHEC DE LA SAUVEGARDE" >&2
done
