// Journal d'audit : la chaîne d'intégrité reste vérifiable après l'extraction du
// module (server/lib/audit.mjs), et une altération directe en base est détectée.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  // Génère quelques évènements audités (écritures CREATE chaînées).
  await admin.post('/api/patients', { sex: 'Homme', lastName: 'AuditA', firstName: 'X', consentSigned: true });
  await admin.post('/api/patients', { sex: 'Femme', lastName: 'AuditB', firstName: 'Y', consentSigned: true });
});

after(async () => {
  await server?.stop();
});

describe('Journal d audit, intégrité', () => {
  test('la chaîne est intègre après des écritures', async () => {
    const r = await admin.get('/api/audit-logs/integrity');
    assert.equal(r.status, 200);
    assert.equal(r.body.intact, true, 'la chaîne doit être intègre');
    assert.ok(r.body.checkedRows > 0, 'des lignes chaînées doivent exister');
  });

  test('une altération directe d une ligne en base est détectée', async () => {
    const db = new Database(server.dbPath);
    const target = db
      .prepare('SELECT id FROM audit_logs WHERE integrity_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get();
    db.prepare("UPDATE audit_logs SET action = 'TAMPERED' WHERE id = ?").run(target.id);
    db.close();

    const r = await admin.get('/api/audit-logs/integrity');
    assert.equal(r.status, 200);
    assert.equal(r.body.intact, false, 'l altération doit rompre la chaîne');
    assert.ok(r.body.brokenLinks.length >= 1, 'au moins un lien rompu signalé');
  });
});
