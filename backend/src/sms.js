// SMS par Nimba SMS (https://nimbasms.com). Les identifiants viennent des variables d'environnement du serveur
// (NIMBA_SERVICE_ID, NIMBA_SECRET_TOKEN, NIMBA_SENDER_NAME) : jamais en base ni dans le code. Voir docs/SMS.md.

export const smsConfigured = (cfg) => !!(cfg?.serviceId && cfg?.secretToken);

const auth = (cfg) => `Basic ${Buffer.from(`${cfg.serviceId}:${cfg.secretToken}`).toString('base64')}`;

/** Numéro guinéen à 9 chiffres (ou +indicatif…) vers le format attendu par Nimba. */
export function smsNumber(phone, cfg) {
  const p = String(phone);
  if (p.startsWith('+')) return p.slice(1);
  return cfg.phoneFormat === 'local' ? p : `224${p}`;
}

/** Envoie un SMS ; lève une erreur lisible en cas d'échec. Rend l'identifiant du message chez Nimba. */
export async function sendSms(cfg, { to, body }) {
  if (!smsConfigured(cfg)) throw new Error('SMS non configuré : NIMBA_SERVICE_ID et NIMBA_SECRET_TOKEN manquants');
  const payload = { to: [smsNumber(to, cfg)], message: String(body).slice(0, 1000) };
  if (cfg.senderName) payload.sender_name = cfg.senderName;
  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: { Authorization: auth(cfg), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Nimba SMS ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text).messageid || 'sent'; } catch { return 'sent'; }
}

/** Solde SMS du compte Nimba (ou null si indisponible). */
export async function smsBalance(cfg) {
  if (!smsConfigured(cfg)) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/accounts`, { headers: { Authorization: auth(cfg), Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = await res.json();
    return Number(j.sms_balance ?? j.balance ?? NaN) || (j.sms_balance === 0 ? 0 : null);
  } catch { return null; }
}
