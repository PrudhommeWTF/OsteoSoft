// Intégrité de la facturation : unicité du numéro (pas de doublon, y compris en
// concurrence) et création de base. La numérotation est fournie par le client ;
// le serveur garantit l'unicité (contrôle applicatif + contrainte UNIQUE).
//
// Note : l'immutabilité complète (annuler et remplacer plutôt que supprimer) et
// les totaux encaissés par date d'encaissement feront l'objet d'une tranche
// dédiée, car l'annulation actuelle supprime la facture (à corriger, décision
// produit et comptable en cours).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

let server;
let admin;
let patientId;

function invoiceBody(invoiceNumber, overrides = {}) {
  const amountCents = overrides.amountCents ?? 5000;
  const issuedAt = overrides.issuedAt ?? '2026-03-01T10:00:00.000Z';
  return {
    patientId,
    invoiceNumber,
    amountCents,
    status: 'payee',
    issuedAt,
    currency: 'EUR',
    paymentMethod: 'Espèces',
    lineItems: [{ label: 'Consultation', quantity: 1, unitAmountHtCents: amountCents, vatRate: 0, displayOrder: 0 }],
    payments: [{ amountCents, paidAt: issuedAt, currency: 'EUR', paymentMethod: 'Espèces' }],
    ...overrides
  };
}

before(async () => {
  server = await startTestServer();
  const { client } = await setupCleanInstance(server.baseUrl);
  admin = client;
  const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'PatienteFacture', firstName: 'Claire', consentSigned: true });
  assert.equal(pa.status, 201);
  patientId = pa.body?.patient?.id;
  assert.ok(Number.isInteger(patientId));
});

after(async () => {
  await server?.stop();
});

describe('Intégrité de la facturation', () => {
  test('crée une facture et la relit', async () => {
    const created = await admin.post('/api/billing/invoices', invoiceBody('2026-000001'));
    assert.equal(created.status, 201);
    const invoiceId = created.body?.invoiceId;
    assert.ok(Number.isInteger(invoiceId));

    const read = await admin.get(`/api/billing/invoices/${invoiceId}`);
    assert.equal(read.status, 200);
    assert.ok(read.raw.includes('2026-000001'), 'le numéro de facture doit être relu');
  });

  test('un numéro de facture en double est refusé (409)', async () => {
    const n = '2026-000100';
    assert.equal((await admin.post('/api/billing/invoices', invoiceBody(n))).status, 201);
    const dup = await admin.post('/api/billing/invoices', invoiceBody(n));
    assert.equal(dup.status, 409, 'un numéro déjà utilisé doit être rejeté');
  });

  test('deux créations concurrentes du même numéro: une seule réussit', async () => {
    const n = '2026-000200';
    const [r1, r2] = await Promise.all([
      admin.post('/api/billing/invoices', invoiceBody(n)),
      admin.post('/api/billing/invoices', invoiceBody(n))
    ]);
    const codes = [r1.status, r2.status].sort();
    assert.deepEqual(codes, [201, 409], 'exactement une création réussie, une refusée, jamais deux factures au même numéro');
  });

  test('des numéros distincts créent des factures distinctes', async () => {
    const a = await admin.post('/api/billing/invoices', invoiceBody('2026-000300'));
    const b = await admin.post('/api/billing/invoices', invoiceBody('2026-000301'));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.invoiceId, b.body.invoiceId);
  });
});
