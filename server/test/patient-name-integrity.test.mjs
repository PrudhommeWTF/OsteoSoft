// Integrite du nom patient : un nom ou prenom ne doit jamais pouvoir devenir
// vide, ni a la creation ni a la mise a jour. Une valeur composee uniquement
// d'espaces passait le controle min(1) puis etait reduite a du vide par le trim
// du serveur, ce qui blanchissait le nom. La mise a jour partielle (champ omis)
// reste autorisee et conserve la valeur existante.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'NomInitial', firstName: 'Prenom', consentSigned: true });
  patientId = pa.body?.patient?.id;
});

after(async () => {
  await server?.stop();
});

describe('Integrite du nom patient', () => {
  test('creation : un nom uniquement compose d espaces est refuse (400)', async () => {
    const r = await admin.post('/api/patients', { sex: 'Femme', lastName: '   ', firstName: 'X', consentSigned: true });
    assert.equal(r.status, 400, `refus attendu, obtenu ${r.status}`);
  });

  test('mise a jour : blanchir le nom par des espaces est refuse (400)', async () => {
    const r = await admin.put(`/api/patients/${patientId}`, { lastName: '   ' });
    assert.equal(r.status, 400, `refus attendu, obtenu ${r.status}`);
  });

  test('mise a jour : blanchir via fullName vide (espaces) est refuse (400)', async () => {
    const r = await admin.put(`/api/patients/${patientId}`, { fullName: '   ' });
    assert.equal(r.status, 400, `refus attendu, obtenu ${r.status}`);
  });

  test('mise a jour partielle (nom omis) reste acceptee et conserve le nom', async () => {
    const r = await admin.put(`/api/patients/${patientId}`, { mobilePhone: '06 01 02 03 04' });
    assert.ok(r.status === 200 || r.status === 204, `mise a jour partielle attendue OK, obtenu ${r.status}`);
    const read = await admin.get(`/api/patients/${patientId}`);
    assert.equal(read.status, 200);
    assert.ok(read.raw.includes('NomInitial'), 'le nom existant doit etre conserve');
  });

  test('mise a jour : un nouveau nom valide est accepte', async () => {
    const r = await admin.put(`/api/patients/${patientId}`, { lastName: 'NouveauNom', firstName: 'Prenom' });
    assert.ok(r.status === 200 || r.status === 204, `mise a jour attendue OK, obtenu ${r.status}`);
  });
});
