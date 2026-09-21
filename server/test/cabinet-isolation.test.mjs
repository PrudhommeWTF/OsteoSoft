// Cloisonnement inter-cabinets : le trou le plus sensible identifié à l'état des
// lieux. Un praticien du cabinet A ne doit jamais voir les données du cabinet B,
// y compris en visant directement un identifiant.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  createClient,
  setupCleanInstance,
  createOffice,
  createUser
} from './helpers/harness.mjs';

let server;
let clientA;
let clientB;
let patientA;
let patientB;

before(async () => {
  server = await startTestServer();
  const { client: admin, officeId: officeA } = await setupCleanInstance(server.baseUrl);
  assert.ok(Number.isInteger(officeA), 'cabinet A attendu depuis setup/office');

  const officeB = await createOffice(admin, 'Cabinet B');

  // Deux praticiens (profil secretariat : lecture et création de patients),
  // chacun rattaché à un seul cabinet.
  await createUser(admin, { username: 'prat-a', password: 'test-prat-a-1', profileId: 'secretariat', officeIds: [officeA] });
  await createUser(admin, { username: 'prat-b', password: 'test-prat-b-1', profileId: 'secretariat', officeIds: [officeB] });

  clientA = createClient(server.baseUrl);
  assert.equal((await clientA.login('prat-a', 'test-prat-a-1')).status, 200);
  clientB = createClient(server.baseUrl);
  assert.equal((await clientB.login('prat-b', 'test-prat-b-1')).status, 200);

  // Chaque praticien crée un patient : il est rattaché à son cabinet.
  const pa = await clientA.post('/api/patients', { sex: 'Femme', lastName: 'PatientA', firstName: 'Alice', consentSigned: true });
  assert.equal(pa.status, 201);
  patientA = pa.body?.patient?.id;
  assert.ok(Number.isInteger(patientA));

  const pb = await clientB.post('/api/patients', { sex: 'Homme', lastName: 'PatientB', firstName: 'Bob', consentSigned: true });
  assert.equal(pb.status, 201);
  patientB = pb.body?.patient?.id;
  assert.ok(Number.isInteger(patientB));
});

after(async () => {
  await server?.stop();
});

describe('Cloisonnement inter-cabinets', () => {
  test('chaque praticien accède à son propre patient (200)', async () => {
    assert.equal((await clientA.get(`/api/patients/${patientA}`)).status, 200);
    assert.equal((await clientB.get(`/api/patients/${patientB}`)).status, 200);
  });

  test('un praticien ne peut pas accéder au patient d un autre cabinet (403)', async () => {
    assert.equal((await clientA.get(`/api/patients/${patientB}`)).status, 403, 'A ne doit pas voir le patient de B');
    assert.equal((await clientB.get(`/api/patients/${patientA}`)).status, 403, 'B ne doit pas voir le patient de A');
  });

  test('la liste des patients est cloisonnée par cabinet', async () => {
    const la = await clientA.get('/api/patients');
    assert.equal(la.status, 200);
    assert.ok(la.raw.includes('PatientA'), 'A doit voir son patient dans la liste');
    assert.ok(!la.raw.includes('PatientB'), 'A ne doit pas voir le patient de B dans la liste');

    const lb = await clientB.get('/api/patients');
    assert.equal(lb.status, 200);
    assert.ok(lb.raw.includes('PatientB'), 'B doit voir son patient dans la liste');
    assert.ok(!lb.raw.includes('PatientA'), 'B ne doit pas voir le patient de A dans la liste');
  });

  test('un praticien ne peut pas agir en écriture sur le patient d un autre cabinet (403)', async () => {
    // withdraw-consent n'exige que read-patient-record, que B possède : le refus
    // vient donc du cloisonnement cabinet, pas d'un manque de permission. On ne
    // vise QUE le patient de l'autre cabinet, aucune donnée n'est modifiée.
    const r = await clientB.post(`/api/patients/${patientA}/withdraw-consent`, {});
    assert.equal(r.status, 403, 'B ne doit pas pouvoir agir sur le patient de A');
  });
});

