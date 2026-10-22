// Envoi des e-mails (connexion par adresse e-mail, mot de passe oublié, vérification d'adresse).
// Les hébergeurs gratuits bloquent l'envoi SMTP : on passe par l'API HTTP d'un service d'envoi (Brevo).
// Les e-mails sont déjà enregistrés en base (table messages, canal « email ») ; ce module les expédie.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Met le texte brut dans une page HTML très simple (compatible avec toutes les messageries). */
export function toHtml(text) {
  const paras = String(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1b1b1b;max-width:520px">${paras}<p style="margin:18px 0 0;color:#666;font-size:13px">Wallindirain</p></div>`;
}

export const EMAIL_PROVIDERS = {
  // Aucun envoi réel (mode test) : le message est marqué « simulated »
  async simulated() { return 'simulated'; },

  // Brevo (https://www.brevo.com) : formule gratuite, aucun nom de domaine obligatoire (adresse d'expéditeur à vérifier)
  async brevo({ to, subject, body }, cfg) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: cfg.from, name: cfg.fromName },
        to: [{ email: to }],
        subject,
        textContent: body,
        htmlContent: toHtml(body)
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 'sent';
  }
};
