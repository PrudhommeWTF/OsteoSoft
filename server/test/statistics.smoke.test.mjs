// Statistiques : test de fumée de bout en bout. Garde l'extraction du module
// (buildStatisticsPayload et ses dépendances injectées) contre une régression.
// GET /api/statistics doit répondre 200 avec la structure attendue, y compris
// après la création d'un patient et d'une consultation.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  // Un patient et une consultation pour que l'agrégation ait de la matière.
  const p = await admin.post('/api/patients', { sex: 'Femme', lastName: 'StatsA', firstName: 'Z', consentSigned: true });
  const patientId = p.body?.id ?? p.body?.patient?.id;
  if (patientId) {
    await admin.post('/api/consultations', { patientId, title: 'Bilan' });
  }
});

after(async () => {
  await server?.stop();
});

describe('Statistiques, tableau de bord', () => {
  test('GET /api/statistics répond 200 avec la structure attendue', async () => {
    const r = await admin.get('/api/statistics?years=3&consultationGranularity=month');
    assert.equal(r.status, 200);
    assert.ok(r.body && typeof r.body === 'object', 'un objet de statistiques est renvoyé');
    assert.ok(r.body.scope && typeof r.body.scope === 'object', 'la portée (scope) est présente');
  });

  test('GET /api/statistics accepte le mode consolidé', async () => {
    const r = await admin.get('/api/statistics?scopeMode=consolidated&years=5');
    assert.equal(r.status, 200);
    assert.ok(r.body.scope, 'portée présente en mode consolidé');
  });
});
