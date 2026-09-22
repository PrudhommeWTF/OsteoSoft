// Motif de rendez-vous facultatif.
//
// L'interface affiche le motif comme "(facultatif)" mais le serveur le refusait
// vide (schema reason >= 1), ce qui empechait de creer un rendez-vous sans motif
// alors que l'interface l'y autorise. Le motif doit etre reellement optionnel.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'MotifTest', firstName: 'M', consentSigned: true });
  patientId = pa.body?.patient?.id;
});

after(async () => {
  await server?.stop();
});

describe('Motif de rendez-vous facultatif', () => {
  test('un rendez-vous sans motif est accepte (201)', async () => {
    const r = await admin.post('/api/appointments', {
      patientId,
      startsAt: '2026-06-02T09:00:00.000Z',
      status: 'A confirmer'
      // pas de champ reason
    });
    assert.equal(r.status, 201, `creation attendue 201, obtenu ${r.status} (${r.raw?.slice(0, 200)})`);
  });

  test('un motif vide est egalement accepte (201)', async () => {
    const r = await admin.post('/api/appointments', {
      patientId,
      startsAt: '2026-06-02T10:00:00.000Z',
      status: 'A confirmer',
      reason: ''
    });
    assert.equal(r.status, 201, `creation attendue 201, obtenu ${r.status} (${r.raw?.slice(0, 200)})`);
  });

  test('un motif renseigne reste conserve et relu', async () => {
    const r = await admin.post('/api/appointments', {
      patientId,
      startsAt: '2026-06-02T11:00:00.000Z',
      status: 'A confirmer',
      reason: 'Bilan postural'
    });
    assert.equal(r.status, 201);
    const list = await admin.get('/api/appointments?from=2026-06-01&to=2026-06-30');
    assert.equal(list.status, 200);
    assert.ok(list.raw.includes('Bilan postural'), 'le motif renseigne doit etre relu');
  });
});
