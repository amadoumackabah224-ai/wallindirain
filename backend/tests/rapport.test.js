// Le rapport de contrôle de production (017 à 023) : lecture seule, valide, résultats attendus sur une base saine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from './helpers.js';
import { splitSql } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let db;
before(async () => { db = await freshDb('wld_rapport'); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('rapport de production 017-023 : 6 requêtes en lecture seule, résultats attendus sur une base saine', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'rapport-production-023.sql'), 'utf8');
  const stmts = splitSql(sql);
  assert.equal(stmts.length, 6);
  assert.ok(stmts.every((s) => /^select/i.test(s)), 'uniquement des SELECT');
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(insert|update|delete|truncate|drop|alter|create)\b\s/i);
  const rows = []; for (const s of stmts) rows.push((await db.owner.query(s)).rows);
  assert.ok(rows[0][0].name >= '023' && rows[0].length >= 7);
  assert.equal(rows[1].length, 0); assert.equal(rows[2].length, 0);
  assert.deepEqual(rows[3].map((r) => r.table_name), ['courier_profiles', 'courier_zones', 'mission_offers', 'order_requests', 'product_images', 'tour_stops', 'tours']);
  assert.deepEqual(Object.values(rows[4][0]), [false, false, false, false, false]);
  assert.equal(rows[5].length, 1);
});
