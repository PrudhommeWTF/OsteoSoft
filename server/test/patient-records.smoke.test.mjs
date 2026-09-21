// Patients/consultations liés à la base (server/lib/patient-records.mjs) : test de
// fumée du cycle complet écriture chiffrée -> relecture déchiffrée d'une
// consultation (motifs et sections), qui garde l'extraction contre une
// régression. Le déchiffrement par section/motif passe par les primitives
// extraites (getConsultationSections/getConsultationReasonItems).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Homme', lastName: 'DossierA', firstName: 'D', consentSigned: true });
  patientId = pa.body?.patient?.id;
});

after(async () => {
  await server?.stop();
});

describe('Dossier patient, consultation chiffrée', () => {
  test('crée une consultation avec motifs et sections, puis la relit', async () => {
    assert.ok(Number.isInteger(patientId), 'patient de test créé');

    const created = await admin.post(`/api/patients/${patientId}/consultations`, {
      startedAt: '2026-04-01T09:00:00.000Z',
      title: 'Bilan initial',
      practitioner: 'Praticien',
      reasonItems: [{ label: 'Lombalgie', value: 'aigüe', important: true }],
      profile: 'Adulte',
      important: false,
      motifMainHtml: '<p>Douleur lombaire</p>',
      testsHtml: '',
      schemaHtml: '',
      treatmentsHtml: '<p>Manipulation</p>',
      remarksHtml: ''
    });
    assert.ok([200, 201].includes(created.status), `création attendue 200/201, obtenu ${created.status} (${created.raw?.slice(0, 200)})`);

    const list = await admin.get(`/api/patients/${patientId}/consultations`);
    assert.equal(list.status, 200);
    // Les contenus chiffrés doivent être relus en clair (déchiffrement des
    // sections et motifs via les primitives extraites).
    assert.ok(list.raw.includes('Lombalgie'), 'le motif est relu en clair');
    assert.ok(list.raw.includes('Douleur lombaire'), 'la section motif est relue en clair');
    assert.ok(list.raw.includes('Manipulation'), 'la section traitement est relue en clair');
  });
});
