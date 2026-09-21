// Tests d'API de bout en bout : socle du filet de sécurité (Priorité 1).
// Décrit le comportement ACTUEL. Doit passer avant et après chaque découpage.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  createClient,
  setupCleanInstance,
  openTestDb,
  decryptField,
  DEFAULT_ADMIN_PASSWORD
} from './helpers/harness.mjs';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  const s = await setupCleanInstance(server.baseUrl);
  admin = s.client;
});

after(async () => {
  await server?.stop();
});

describe('Authentification et protection CSRF', () => {
  test('une route protégée sans session renvoie 401', async () => {
    const anon = createClient(server.baseUrl);
    const r = await anon.get('/api/patients');
    assert.equal(r.status, 401);
  });

  test('le login admin réussit et pose les cookies session et CSRF', async () => {
    const c = createClient(server.baseUrl);
    const r = await c.login('admin', DEFAULT_ADMIN_PASSWORD);
    assert.equal(r.status, 200);
    assert.ok(c.cookies.has('os_session'), 'cookie de session attendu');
    assert.ok(c.cookies.has('os_csrf'), 'cookie CSRF attendu');
  });

  test('le mauvais mot de passe est refusé', async () => {
    const c = createClient(server.baseUrl);
    const r = await c.login('admin', 'mauvais-mot-de-passe');
    assert.equal(r.status, 401);
  });

  test('une écriture sans jeton CSRF valide est rejetée (403)', async () => {
    const c = createClient(server.baseUrl);
    await c.login('admin', DEFAULT_ADMIN_PASSWORD);
    // en-tête CSRF explicitement vide : ne correspond pas au cookie os_csrf
    const r = await c.request('POST', '/api/patients', {
      body: { sex: 'Homme', lastName: 'Csrf', firstName: 'Test', consentSigned: true },
      headers: { 'x-csrf-token': '' }
    });
    assert.equal(r.status, 403);
  });
});

describe('Parcours patient et consultation, round-trip de chiffrement', () => {
  let patientId;

  test('crée un patient et le relit déchiffré via l API', async () => {
    const created = await admin.post('/api/patients', {
      sex: 'Femme',
      lastName: 'Durand',
      firstName: 'Alice',
      consentSigned: true
    });
    assert.equal(created.status, 201);
    patientId = created.body?.patient?.id;
    assert.ok(Number.isInteger(patientId) && patientId > 0, 'id patient attendu');

    const read = await admin.get(`/api/patients/${patientId}`);
    assert.equal(read.status, 200);
    assert.ok(read.raw.includes('Durand'), 'le nom doit revenir déchiffré dans la réponse');
  });

  test('le nom du patient est chiffré au repos dans SQLite', async () => {
    const db = openTestDb(server);
    const row = db.prepare('SELECT cipher_full_name FROM patients WHERE id = ?').get(patientId);
    db.close();
    assert.ok(row && row.cipher_full_name, 'ligne patient attendue');
    assert.ok(!String(row.cipher_full_name).includes('Durand'), 'le nom ne doit pas être lisible en clair dans la base');
    assert.ok(decryptField(server.dataKey, row.cipher_full_name).includes('Durand'), 'le nom doit se déchiffrer avec la clé');
  });

  test('crée une consultation et relit son titre déchiffré', async () => {
    const created = await admin.post(`/api/patients/${patientId}/consultations`, {
      startedAt: '2026-01-15T10:00:00.000Z',
      title: 'Lombalgie aigue',
      practitioner: 'Dr Test',
      reasonItems: [],
      heightCm: null,
      weightKg: null,
      evaBefore: 3,
      evaAfter: 1,
      profile: 'Adulte',
      important: false,
      motifMainHtml: '<p>mal de dos</p>',
      testsHtml: '',
      schemaHtml: '',
      treatmentsHtml: '',
      remarksHtml: ''
    });
    assert.equal(created.status, 201);

    const list = await admin.get(`/api/patients/${patientId}/consultations`);
    assert.equal(list.status, 200);
    assert.ok(list.raw.includes('Lombalgie aigue'), 'le titre doit revenir déchiffré');
  });

  test('le titre de consultation est chiffré au repos', async () => {
    const db = openTestDb(server);
    const row = db.prepare('SELECT title FROM consultations WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(patientId);
    db.close();
    assert.ok(row && row.title, 'consultation attendue');
    assert.ok(!String(row.title).includes('Lombalgie'), 'le titre ne doit pas être en clair dans la base');
    assert.ok(decryptField(server.dataKey, row.title).includes('Lombalgie'), 'le titre doit se déchiffrer');
  });
});
