// Comptabilité : test de fumée de bout en bout. Garde l'extraction du module
// (getBillingOperationsData) contre une régression. Le registre des opérations
// n'avait aucune couverture directe. GET /api/billing/operations doit répondre
// 200 avec la structure attendue, y compris après la création d'une facture.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'ComptaA', firstName: 'C', consentSigned: true });
  const patientId = pa.body?.patient?.id;
  if (Number.isInteger(patientId)) {
    await admin.post('/api/billing/invoices', {
      patientId,
      invoiceNumber: '2026-090001',
      amountCents: 5000,
      status: 'payee',
      issuedAt: '2026-03-10T10:00:00.000Z',
      currency: 'EUR',
      paymentMethod: 'Espèces',
      lineItems: [{ label: 'Consultation', quantity: 1, unitAmountHtCents: 5000, vatRate: 0, displayOrder: 0 }],
      payments: [{ amountCents: 5000, paidAt: '2026-03-10T10:00:00.000Z', currency: 'EUR', paymentMethod: 'Espèces' }]
    });
  }
});

after(async () => {
  await server?.stop();
});

describe('Comptabilité, registre des opérations', () => {
  test('GET /api/billing/operations répond 200 avec la structure attendue', async () => {
    const r = await admin.get('/api/billing/operations?from=2026-03-01&to=2026-03-31');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.operations), 'operations est une liste');
    assert.ok(Array.isArray(r.body.summary), 'summary est une liste');
    assert.ok(r.body.stats && typeof r.body.stats === 'object', 'stats est présent');
    assert.equal(typeof r.body.stats.creditCents, 'number', 'creditCents est numérique');
    assert.equal(typeof r.body.stats.debitCents, 'number', 'debitCents est numérique');
    assert.equal(typeof r.body.stats.netCents, 'number', 'netCents est numérique');
  });

  test('une période sans opération renvoie un registre vide et cohérent', async () => {
    const r = await admin.get('/api/billing/operations?from=2000-01-01&to=2000-01-31');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.operations, [], 'aucune opération sur une période vide');
    assert.equal(r.body.stats.operationCount, 0);
  });
});
