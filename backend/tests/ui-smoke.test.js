// Test de fumée de l'interface : chaque rôle se connecte dans un vrai navigateur, ouvre tous ses écrans de navigation
// et on vérifie qu'aucun écran ne plante (erreur JavaScript) ni n'affiche « Erreur interne » ou « non autorisée ».
// Sans dépendance ajoutée : le test est ignoré si Playwright n'est pas installé sur la machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* ignoré plus bas */ }
const PW = 'Secret123';
let db, w, srv, base, browser;

before(async () => {
  if (!chromium) return;
  db = await freshDb('wld_ui'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_ui', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (srv) { srv.resetLimits(); await srv.close(); } if (db) { await db.owner.end(); await db.app.end(); } });

for (const role of ['admin', 'seller', 'supplier', 'courier', 'agent1', 'chief', 'warehouse']) {
  test(`écrans du rôle ${role} : aucun plantage`, { skip: !chromium && 'Playwright absent' }, async () => {
    const phone = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [w[role]])).rows[0].phone;
    const errors = [];
    for (const [label, size, sel] of [['ordinateur', { width: 1280, height: 800 }, '.side-nav .nav-item'], ['téléphone', { width: 390, height: 800 }, '.bnav .bnav-item']]) {
      const ctx = await browser.newContext({ viewport: size });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${label} : ${e}`));
      await page.goto(base + '/');
      const r = await page.request.post(base + '/api/auth/login', { data: { identifier: phone, password: PW }, headers: { 'x-wld': '1' } });
      assert.equal(r.status(), 200);
      await page.goto(base + '/');
      await page.waitForSelector(sel, { timeout: 8000 });
      if (process.env.UI_DEBUG) console.log(label, role, (await page.innerText('body')).slice(0, 400).replace(/\n/g, ' | '));
      const n = Math.min(await page.locator(sel).count(), 30);
      assert.ok(n >= 2, `peu d'entrées de navigation (${label}) pour ${role}`);
      for (let i = 0; i < n; i++) {
        const item = page.locator(sel).nth(i);
        if (!(await item.isVisible())) continue;
        const name = (await item.innerText()).trim();
        if (/Quitter|Plus/.test(name)) continue;
        await item.evaluate((el) => el.click());
        await page.waitForTimeout(600);
        const text = await page.innerText('body');
        assert.ok(!/Erreur interne|Action non autorisée/.test(text), `${role} (${label}) « ${name} » : message d'erreur affiché`);
      }
      await ctx.close();
    }
    assert.deepEqual(errors, [], `${role} : erreurs JavaScript`);
  });
}
