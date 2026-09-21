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

// Suffixe numérique d'un numéro de facture (partie après le dernier tiret).
function invoiceSuffix(invoiceNumber) {
  const value = String(invoiceNumber ?? '');
  return Number(value.slice(value.lastIndexOf('-') + 1));
}

describe('Numérotation attribuée par le serveur', () => {
  test('crée une facture, le serveur attribue le numéro et on le relit', async () => {
    const created = await admin.post('/api/billing/invoices', invoiceBody());
    assert.equal(created.status, 201);
    const invoiceId = created.body?.invoiceId;
    const invoiceNumber = created.body?.invoiceNumber;
    assert.ok(Number.isInteger(invoiceId));
    assert.match(String(invoiceNumber), /^2026-\d{6}$/, 'numéro au format AAAA-XXXXXX pour une facture datée 2026');

    const read = await admin.get(`/api/billing/invoices/${invoiceId}`);
    assert.equal(read.status, 200);
    assert.ok(read.raw.includes(invoiceNumber), 'le numéro attribué par le serveur doit être relu');
  });

  test('le numéro envoyé par le client est ignoré', async () => {
    // Deux factures avec le MÊME numéro client : le serveur attribue quand même
    // deux numéros distincts (le numéro client n'a aucun effet).
    const a = await admin.post('/api/billing/invoices', invoiceBody('MEME-NUMERO-CLIENT'));
    const b = await admin.post('/api/billing/invoices', invoiceBody('MEME-NUMERO-CLIENT'));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.invoiceNumber, b.body.invoiceNumber, 'numéros serveur distincts malgré un numéro client identique');
    assert.notEqual(a.body.invoiceNumber, 'MEME-NUMERO-CLIENT');
  });

  test('les numéros se suivent sans trou', async () => {
    const a = await admin.post('/api/billing/invoices', invoiceBody());
    const b = await admin.post('/api/billing/invoices', invoiceBody());
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(invoiceSuffix(b.body.invoiceNumber), invoiceSuffix(a.body.invoiceNumber) + 1, 'incrément de 1, sans trou');
  });

  test('deux créations concurrentes reçoivent des numéros distincts', async () => {
    const [r1, r2] = await Promise.all([
      admin.post('/api/billing/invoices', invoiceBody()),
      admin.post('/api/billing/invoices', invoiceBody())
    ]);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.notEqual(r1.body.invoiceNumber, r2.body.invoiceNumber, 'jamais deux factures au même numéro, même en concurrence');
  });
});

describe('Annulation conservatrice (facture émise non supprimée)', () => {
  test('annuler une facture la conserve en statut annulee, sans la supprimer', async () => {
    const created = await admin.post('/api/billing/invoices', invoiceBody());
    assert.equal(created.status, 201);
    const invoiceId = created.body.invoiceId;

    const cancelled = await admin.del(`/api/billing/invoices/${invoiceId}`);
    assert.equal(cancelled.status, 200);

    // La facture doit toujours exister, marquée annulée (pas un 404).
    const read = await admin.get(`/api/billing/invoices/${invoiceId}`);
    assert.equal(read.status, 200, 'une facture annulée doit être conservée, pas supprimée');
    assert.ok(read.raw.includes('annulee'), 'la facture conservée doit porter le statut annulee');
  });

  test('le numéro d une facture annulée n est pas réutilisé (numérotation continue)', async () => {
    const created = await admin.post('/api/billing/invoices', invoiceBody());
    assert.equal(created.status, 201);
    const cancelledNumber = created.body.invoiceNumber;
    assert.equal((await admin.del(`/api/billing/invoices/${created.body.invoiceId}`)).status, 200);

    // La facture suivante reçoit un numéro strictement supérieur : le numéro de la
    // facture annulée n'est pas réattribué, la séquence continue sans trou.
    const next = await admin.post('/api/billing/invoices', invoiceBody());
    assert.equal(next.status, 201);
    assert.notEqual(next.body.invoiceNumber, cancelledNumber, 'le numéro annulé ne doit pas être réattribué');
    assert.equal(invoiceSuffix(next.body.invoiceNumber), invoiceSuffix(cancelledNumber) + 1, 'la séquence continue après l annulation');
  });
});
