// Messages WhatsApp : les messages sont envoyés avec des modèles approuvés (obligatoire hors fenêtre de 24 h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhatsappPayload } from '../src/messenger.js';

const cfg = { whatsappLang: 'fr', whatsappTemplateCode: 'wld_code', whatsappTemplateInfo: 'wld_info', whatsappCodeButton: false };

test('code de livraison / retrait / mot de passe : modèle « code » avec le code seul', () => {
  for (const [template, body, code] of [
    ['delivery_code', 'Wallindirain : votre commande WLD-1 arrive. Code de livraison : 4821. Donnez-le au livreur.', '4821'],
    ['withdrawal_code', 'Wallindirain : code de retrait de 50 000 GNF : 123456', '123456'],
    ['password_reset', 'Wallindirain : votre code de réinitialisation est 654321. Il expire dans 15 minutes.', '654321']]) {
    const p = buildWhatsappPayload({ to: '624390707', body, template }, cfg);
    assert.equal(p.type, 'template'); assert.equal(p.to, '224624390707');
    assert.equal(p.template.name, 'wld_code'); assert.equal(p.template.language.code, 'fr');
    assert.deepEqual(p.template.components, [{ type: 'body', parameters: [{ type: 'text', text: code }] }]);
  }
});

test('bouton « Copier le code » ajouté si le modèle est de catégorie Authentification', () => {
  const p = buildWhatsappPayload({ to: '624390707', body: 'Wallindirain : votre code de réinitialisation est 654321.', template: 'password_reset' }, { ...cfg, whatsappCodeButton: true });
  assert.equal(p.template.components[1].sub_type, 'url'); assert.equal(p.template.components[1].parameters[0].text, '654321');
});

test('autres messages : modèle « info », texte sur une seule ligne, jamais de texte libre', () => {
  const p = buildWhatsappPayload({ to: '624390707', body: 'Wallindirain : retrait payé.\nMontant :\t50 000 GNF', template: 'withdrawal_paid' }, cfg);
  assert.equal(p.template.name, 'wld_info');
  assert.equal(p.template.components[0].parameters[0].text, 'retrait payé. Montant : 50 000 GNF');
  assert.equal(p.text, undefined);
});

test('message de code sans code reconnaissable : envoyé comme information (jamais de plantage)', () => {
  const p = buildWhatsappPayload({ to: '624390707', body: 'texte inattendu', template: 'password_reset' }, cfg);
  assert.equal(p.template.name, 'wld_info');
});
