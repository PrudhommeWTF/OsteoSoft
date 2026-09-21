// Cloisonnement au niveau consultation, et non-régression de l'IDOR corrigé en
// #97 (création de consultation par id de patient d'un autre cabinet).
//
// Montage avec les profils par défaut : "secretariat" peut créer des patients,
// "assistant" peut créer et lire des consultations. On sépare ainsi la
// permission (assistant l'a) du cloisonnement cabinet (le refus vient du cabinet).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, setupCleanInstance, createOffice, createUser } from './helpers/harness.mjs';

let server;
let asstA; // assistant, cabinet A
let asstB; // assistant, cabinet B
let patientA;

function consultationPayload(title) {
  return {
    startedAt: '2026-03-01T09:00:00.000Z',
    title,
    practitioner: 'Praticien',
    reasonItems: [],
    heightCm: null,
    weightKg: null,
    evaBefore: 0,
    evaAfter: 0,
    profile: 'Adulte',
    important: false,
    motifMainHtml: '',
    testsHtml: '',
    schemaHtml: '',
    treatmentsHtml: '',
    remarksHtml: ''
  };
}

before(async () => {
  server = await startTestServer();
  const { client: admin, officeId: officeA } = await setupCleanInstance(server.baseUrl);
  const officeB = await createOffice(admin, 'Cabinet B');

  await createUser(admin, { username: 'secr-a', password: 'test-secr-a-1', profileId: 'secretariat', officeIds: [officeA] });
  await createUser(admin, { username: 'asst-a', password: 'test-asst-a-1', profileId: 'assistant', officeIds: [officeA] });
  await createUser(admin, { username: 'asst-b', password: 'test-asst-b-1', profileId: 'assistant', officeIds: [officeB] });

  // Le secrétariat du cabinet A crée le patient (rattaché au cabinet A).
  const secrA = createClient(server.baseUrl);
  assert.equal((await secrA.login('secr-a', 'test-secr-a-1')).status, 200);
  const pa = await secrA.post('/api/patients', { sex: 'Femme', lastName: 'PatientA', firstName: 'Alice', consentSigned: true });
  assert.equal(pa.status, 201);
  patientA = pa.body?.patient?.id;
  assert.ok(Number.isInteger(patientA));

  asstA = createClient(server.baseUrl);
  assert.equal((await asstA.login('asst-a', 'test-asst-a-1')).status, 200);
  asstB = createClient(server.baseUrl);
  assert.equal((await asstB.login('asst-b', 'test-asst-b-1')).status, 200);
});

after(async () => {
  await server?.stop();
});

describe('Cloisonnement au niveau consultation', () => {
  test('un praticien du cabinet du patient crée et relit une consultation', async () => {
    const created = await asstA.post(`/api/patients/${patientA}/consultations`, consultationPayload('Consultation A'));
    assert.equal(created.status, 201);

    const list = await asstA.get(`/api/patients/${patientA}/consultations`);
    assert.equal(list.status, 200);
    assert.ok(list.raw.includes('Consultation A'), 'le praticien du cabinet doit voir la consultation');
  });

  test('un praticien d un autre cabinet ne peut pas lire les consultations (403)', async () => {
    const asB = await asstB.get(`/api/patients/${patientA}/consultations`);
    assert.equal(asB.status, 403, 'B (autre cabinet) ne doit pas lire les consultations du patient de A');
  });

  test('IDOR: un praticien d un autre cabinet ne peut pas créer de consultation (403) [régression #97]', async () => {
    // asst-b possède bien la permission create-consultation : le refus prouve le
    // cloisonnement cabinet, pas un manque de droit. C'est le correctif de #97.
    const attempt = await asstB.post(`/api/patients/${patientA}/consultations`, consultationPayload('Injection B'));
    assert.equal(attempt.status, 403, 'B ne doit pas pouvoir écrire une consultation sur le patient de A');
  });
});
