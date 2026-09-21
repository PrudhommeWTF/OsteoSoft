// Livre des recettes (micro-BNC) : journal chronologique des recettes encaissées
// (trésorerie). Vérifie qu'un encaissement apparaît, qu'une facture annulée en
// est absente (paiements supprimés), le total, et l'export CSV.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

function paidInvoice(amountCents, paidAt) {
  return {
    patientId,
    amountCents,
    status: 'payee',
    issuedAt: paidAt,
    currency: 'EUR',
    paymentMethod: 'Espèces',
    lineItems: [{ label: 'Consultation', quantity: 1, unitAmountHtCents: amountCents, vatRate: 0, displayOrder: 0 }],
    payments: [{ amountCents, paidAt, currency: 'EUR', paymentMethod: 'Espèces' }]
  };
}

before(async () => {
  server = await startTestServer();
  admin = (await setupCleanInstance(server.baseUrl)).client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'RecetteA', firstName: 'R', consentSigned: true });
  patientId = pa.body?.patient?.id;
});

after(async () => {
  await server?.stop();
});

describe('Livre des recettes micro-BNC', () => {
  test('un encaissement apparaît dans le journal, avec le total', async () => {
    const created = await admin.post('/api/billing/invoices', paidInvoice(5000, '2026-04-05T10:00:00.000Z'));
    assert.equal(created.status, 201);

    const r = await admin.get('/api/billing/recettes?from=2026-04-01&to=2026-04-30');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.entries));
    const entry = r.body.entries.find((e) => e.invoiceNumber === created.body.invoiceNumber);
    assert.ok(entry, 'l encaissement doit figurer au livre');
    assert.equal(entry.amountCents, 5000);
    assert.equal(entry.patientName, 'RecetteA R', 'le client (nom patient) est déchiffré');
    assert.equal(entry.paymentMethod, 'Espèces');
    assert.ok(r.body.totalCents >= 5000, 'le total inclut l encaissement');
  });

  test('une facture annulée n apparaît pas (recette non conservée)', async () => {
    const created = await admin.post('/api/billing/invoices', paidInvoice(7000, '2026-05-05T10:00:00.000Z'));
    assert.equal(created.status, 201);
    assert.equal((await admin.del(`/api/billing/invoices/${created.body.invoiceId}`)).status, 200);

    const r = await admin.get('/api/billing/recettes?from=2026-05-01&to=2026-05-31');
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, 0, 'aucune recette : le paiement de la facture annulée est retiré');
    assert.equal(r.body.totalCents, 0);
  });

  test('trésorerie : daté par l encaissement, hors période exclu', async () => {
    await admin.post('/api/billing/invoices', paidInvoice(3000, '2026-06-15T10:00:00.000Z'));
    const r = await admin.get('/api/billing/recettes?from=2026-07-01&to=2026-07-31');
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, 0, 'un encaissement de juin n apparaît pas en juillet');
  });

  test('export CSV : en-tête, lignes et total', async () => {
    const r = await admin.getBinary('/api/billing/recettes?from=2026-04-01&to=2026-04-30&format=csv');
    assert.equal(r.status, 200);
    const text = r.buffer.toString('utf-8');
    assert.ok(text.includes('Date encaissement;Client;Numero facture'), 'en-tête CSV attendu');
    assert.ok(text.includes('TOTAL'), 'ligne de total présente');
    assert.ok(text.includes('RecetteA R'), 'le client figure dans le CSV');
  });
});
