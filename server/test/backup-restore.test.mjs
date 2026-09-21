// Sauvegarde et restauration, avec la propriété la plus importante pour toi :
// une sauvegarde restaurée AVEC la clé se déchiffre entièrement ; SANS la bonne
// clé, rien ne se lit. La sauvegarde elle-même ne contient que du ciphertext.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  setupCleanInstance,
  downloadBackup,
  openTestDb,
  decryptField
} from './helpers/harness.mjs';

const PATIENT_NAME = 'DurandSauvegarde';

let source;
let backup; // { manifest, data }

before(async () => {
  source = await startTestServer();
  const { client } = await setupCleanInstance(source.baseUrl);
  const pa = await client.post('/api/patients', { sex: 'Femme', lastName: PATIENT_NAME, firstName: 'Alice', consentSigned: true });
  assert.equal(pa.status, 201);
  backup = await downloadBackup(client);
});

after(async () => {
  await source?.stop();
});

describe('Sauvegarde et restauration', () => {
  test('la sauvegarde ne contient pas le nom en clair', () => {
    const json = JSON.stringify(backup.data);
    assert.ok(!json.includes(PATIENT_NAME), 'la sauvegarde ne doit contenir que du ciphertext pour le nom');
  });

  // Note : après une restauration, le serveur régénère des mots de passe
  // temporaires et impose leur changement (must_change_password), ce qui bloque
  // les routes authentifiées. La preuve du (dé)chiffrement se fait donc au repos,
  // directement sur la base restaurée (le round-trip API est couvert par api-core).

  test('restauration avec la même clé : les données restaurées se déchiffrent', async () => {
    const target = await startTestServer({ dataKey: source.dataKey });
    try {
      const { client } = await setupCleanInstance(target.baseUrl);
      const restore = await client.post('/api/data-management/restore', backup);
      assert.equal(restore.status, 200, 'la restauration doit réussir');

      const db = openTestDb(target);
      const row = db.prepare('SELECT cipher_full_name FROM patients WHERE cipher_full_name IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      db.close();
      assert.ok(row && row.cipher_full_name, 'patient restauré attendu');
      assert.ok(!String(row.cipher_full_name).includes(PATIENT_NAME), 'au repos, le nom reste chiffré');
      assert.ok(decryptField(target.dataKey, row.cipher_full_name).includes(PATIENT_NAME), 'le nom se déchiffre avec la clé');
    } finally {
      await target.stop();
    }
  });

  test('restauration avec une clé différente : rien ne se déchiffre', async () => {
    const target = await startTestServer(); // clé aléatoire, différente de la source
    try {
      const { client } = await setupCleanInstance(target.baseUrl);
      const restore = await client.post('/api/data-management/restore', backup);
      assert.equal(restore.status, 200);

      const db = openTestDb(target);
      const row = db.prepare('SELECT cipher_full_name FROM patients WHERE cipher_full_name IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      db.close();
      assert.ok(row && row.cipher_full_name, 'ciphertext restauré attendu');
      assert.ok(!String(row.cipher_full_name).includes(PATIENT_NAME), 'le nom ne doit jamais être en clair');
      assert.throws(
        () => decryptField(target.dataKey, row.cipher_full_name),
        'le déchiffrement avec une mauvaise clé doit échouer'
      );
    } finally {
      await target.stop();
    }
  });
});
