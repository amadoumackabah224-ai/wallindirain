// Envoi des messages WhatsApp / SMS et des e-mails. Les messages sont déjà enregistrés en base (table messages,
// statut "queued") par les règles métier ; ce module les expédie via un fournisseur interchangeable.
//
// Pour brancher un autre fournisseur (SMS, etc.) : ajouter une fonction dans PROVIDERS
// qui reçoit { to, body, template } et lève une erreur en cas d'échec.

import { EMAIL_PROVIDERS } from './email.js';

/** Numéro guinéen à 9 chiffres -> format international sans "+" */
export const toInternational = (phone) => `224${phone}`;

const PROVIDERS = {
  // Aucun envoi réel : le message est simplement marqué "simulated" (visible dans l'espace administrateur).
  async simulated() { return 'simulated'; },

  // API officielle WhatsApp Business (Meta Cloud API).
  // IMPORTANT : hors fenêtre de 24 h, WhatsApp n'accepte que des modèles de message (templates)
  // préalablement approuvés par Meta. Voir docs/DEPLOIEMENT.md pour déclarer vos modèles.
  async whatsapp({ to, body }, cfg) {
    if (!cfg.whatsappToken || !cfg.whatsappPhoneId) throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_ID manquants');
    const res = await fetch(`https://graph.facebook.com/v20.0/${cfg.whatsappPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toInternational(to), type: 'text', text: { body } }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 'sent';
  }
};

export function startWorker({ db, cfg, log }) {
  const send = PROVIDERS[cfg.messaging.provider];
  if (!send) throw new Error(`Fournisseur de messages inconnu : ${cfg.messaging.provider}`);
  const emailCfg = cfg.email || { provider: 'simulated' };
  const sendEmail = EMAIL_PROVIDERS[emailCfg.provider];
  if (!sendEmail) throw new Error(`Fournisseur d'e-mails inconnu : ${emailCfg.provider}`);
  let stopped = false;

  async function flushMessages() {
    // Verrou de lignes : plusieurs instances ne s'envoient jamais le même message
    await db.tx(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM fn_messages_claim(20)');
      for (const m of rows) {
        try {
          const status = m.channel === 'email'
            ? await sendEmail({ to: m.to_email, subject: m.subject || 'Wallindirain', body: m.body, template: m.template }, emailCfg)
            : await send({ to: m.to_phone, body: m.body, template: m.template }, cfg.messaging);
          await tx.query('SELECT fn_message_mark($1, $2, NULL)', [m.id, status]);
        } catch (e) {
          log({ level: 'warn', msg: 'envoi de message échoué', id: m.id, err: String(e.message) });
          await tx.query('SELECT fn_message_mark($1, $2, $3)', [m.id, 'failed', String(e.message).slice(0, 300)]);
        }
      }
    });
  }
  const releaseLocks = () => db.query('SELECT fn_release_stale_locks() AS n');

  // Conservation limitée : purge des données périmées (voir politique de confidentialité), au démarrage puis toutes les 6 h
  const purge = async () => { const r = await db.query('SELECT fn_purge_old_data() AS r'); await db.query('SELECT fn_purge_support()'); log({ level: 'info', msg: 'purge des données périmées', ...r.rows[0].r }); };
  const purgeSafe = () => { if (!stopped) purge().catch((e) => log({ level: 'error', msg: 'purge', err: String(e) })); };

  const timers = [
    setTimeout(purgeSafe, 30_000),
    setInterval(purgeSafe, 6 * 3600_000),
    setInterval(() => { if (!stopped) flushMessages().catch((e) => log({ level: 'error', msg: 'worker messages', err: String(e) })); }, 3000),
    setInterval(() => { if (!stopped) releaseLocks().catch((e) => log({ level: 'error', msg: 'worker verrous', err: String(e) })); }, 60_000)
  ];
  timers.forEach((t) => t.unref());
  return { flushMessages, stop() { stopped = true; timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); } };
}
