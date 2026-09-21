// Sauvegardes chiffrées : fonctions pures de chiffrement/déchiffrement d'archive
// (aller-retour, mauvaise phrase de passe, format), puis test de fumée de bout en
// bout (export chiffré -> restauration chiffrée) qui vérifie l'archive
// autoportante et le refus en cas de clé de données divergente.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackupArchive, decryptBackupArchive, isEncryptedBackupArchive } from '../lib/backup.mjs';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

describe('Chiffrement d archive (fonctions pures)', () => {
  const passphrase = 'phrase-de-passe-forte-123';

  test('aller-retour : déchiffre ce qui a été chiffré', () => {
    const clear = Buffer.from('contenu du zip de sauvegarde', 'utf8');
    const encrypted = encryptBackupArchive(clear, passphrase);
    assert.ok(isEncryptedBackupArchive(encrypted), 'magie reconnue');
    assert.ok(!encrypted.equals(clear), 'la sortie est bien chiffrée');
    const decrypted = decryptBackupArchive(encrypted, passphrase);
    assert.ok(decrypted.equals(clear), 'le clair est restitué');
  });

  test('une mauvaise phrase de passe échoue', () => {
    const encrypted = encryptBackupArchive(Buffer.from('secret'), passphrase);
    assert.throws(() => decryptBackupArchive(encrypted, 'mauvaise-phrase-123'), /incorrecte|corrompue/);
  });

  test('une phrase de passe trop courte est refusée au chiffrement', () => {
    assert.throws(() => encryptBackupArchive(Buffer.from('x'), 'court'), /trop courte/);
  });

  test('un buffer non chiffré n est pas reconnu comme archive chiffrée', () => {
    assert.equal(isEncryptedBackupArchive(Buffer.from('PK\u0003\u0004 zip')), false);
    assert.throws(() => decryptBackupArchive(Buffer.from('pas une archive'), passphrase), /format non reconnu/);
  });
});

describe('Sauvegarde chiffrée, bout en bout', () => {
  let server;
  let admin;

  before(async () => {
    server = await startTestServer();
    admin = (await setupCleanInstance(server.baseUrl)).client;
    await admin.post('/api/patients', { sex: 'Femme', lastName: 'SauvegardeA', firstName: 'S', consentSigned: true });
  });

  after(async () => {
    await server?.stop();
  });

  const passphrase = 'phrase-de-passe-tres-solide-2026';
  // Une seule archive exportée est réutilisée : les opérations lourdes sont
  // limitées en débit (max 5 par fenêtre), on économise donc les appels.
  let archiveBase64 = '';

  test('export chiffré : renvoie une archive chiffrée reconnue', async () => {
    const r = await admin.postBinary('/api/data-management/backup/encrypted', { passphrase });
    assert.equal(r.status, 200);
    assert.ok(isEncryptedBackupArchive(r.buffer), 'l archive porte la magie de chiffrement');
    // Le contenu ne doit pas être un ZIP en clair (pas d en-tête PK).
    assert.notEqual(r.buffer.subarray(0, 2).toString('latin1'), 'PK', 'pas un ZIP en clair');
    archiveBase64 = r.buffer.toString('base64');
  });

  test('export refuse une phrase de passe trop courte', async () => {
    const r = await admin.post('/api/data-management/backup/encrypted', { passphrase: 'court' });
    assert.equal(r.status, 400);
  });

  // Note : ce test précède la restauration réussie ci-dessous, car une
  // restauration régénère les mots de passe (dont admin) et invaliderait la
  // session utilisée pour les requêtes suivantes.
  test('restauration refuse une mauvaise phrase de passe', async () => {
    const restore = await admin.post('/api/data-management/restore/encrypted', {
      archiveBase64,
      passphrase: 'mauvaise-phrase-de-passe-999'
    });
    assert.equal(restore.status, 400, 'phrase de passe incorrecte rejetée');
  });

  test('restauration chiffrée : aller-retour complet', async () => {
    const restore = await admin.post('/api/data-management/restore/encrypted', {
      archiveBase64,
      passphrase
    });
    assert.equal(restore.status, 200, `restauration attendue 200 (${restore.raw?.slice(0, 200)})`);
    assert.ok(Array.isArray(restore.body?.tempPasswords), 'des mots de passe temporaires sont renvoyés');
  });
});
