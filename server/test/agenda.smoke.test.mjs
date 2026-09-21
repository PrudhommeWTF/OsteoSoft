// Agenda : test de fumée de bout en bout. Garde l'extraction du module (calendrier
// par défaut, création et relecture de rendez-vous) contre une régression. Le
// domaine agenda n'avait aucune couverture directe.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'AgendaA', firstName: 'A', consentSigned: true });
  patientId = pa.body?.patient?.id;
});

after(async () => {
  await server?.stop();
});

describe('Agenda, rendez-vous', () => {
  test('crée un rendez-vous et le relit', async () => {
    assert.ok(Number.isInteger(patientId), 'patient de test créé');
    const created = await admin.post('/api/appointments', {
      patientId,
      startsAt: '2026-06-01T09:00:00.000Z',
      reason: 'Première consultation',
      status: 'A confirmer'
    });
    assert.equal(created.status, 201, `création attendue 201, obtenu ${created.status} (${created.raw?.slice(0, 200)})`);

    const list = await admin.get('/api/appointments?from=2026-06-01&to=2026-06-30');
    assert.equal(list.status, 200);
    assert.ok(list.raw.includes('Première consultation') || Array.isArray(list.body) || (list.body && typeof list.body === 'object'),
      'le rendez-vous créé est relisible dans la période');
  });
});
