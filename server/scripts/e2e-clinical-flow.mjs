// Scenario end-to-end HTTP : parcours clinique et comptable complet.
//
// Patient -> consultation -> facture -> livre des recettes -> annulation.
// Verifie la coherence entre modules : le serveur attribue le numero de facture
// (format AAAA-XXXXXX), l'encaissement apparait au livre des recettes, et son
// annulation le retire. Utilise le harnais de test (instance reelle, base SQLite
// temporaire et isolee) : ne touche jamais les donnees de developpement.

import { startTestServer, setupCleanInstance } from '../test/helpers/harness.mjs';
import { createScenario } from './e2e-lib.mjs';

const ISSUED_AT = '2026-06-10T10:00:00.000Z';
const AMOUNT_CENTS = 6000;

async function main() {
  const { check, section, finish } = createScenario('E2E parcours clinique');
  const server = await startTestServer();
  try {
    const { client: admin } = await setupCleanInstance(server.baseUrl);

    section('Patient et consultation');
    const pa = await admin.post('/api/patients', {
      sex: 'Homme',
      lastName: 'ParcoursClinique',
      firstName: 'Bruno',
      consentSigned: true
    });
    check('creation patient (201)', pa.status === 201, `statut ${pa.status}`);
    const patientId = pa.body?.patient?.id;

    const co = await admin.post(`/api/patients/${patientId}/consultations`, {
      startedAt: '2026-06-10T09:00:00.000Z',
      title: 'Consultation facturable',
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
    });
    check('creation consultation (201)', co.status === 201, `statut ${co.status}`);

    section('Facturation (numero attribue par le serveur)');
    const inv = await admin.post('/api/billing/invoices', {
      patientId,
      invoiceNumber: 'NUMERO-CLIENT',
      amountCents: AMOUNT_CENTS,
      status: 'payee',
      issuedAt: ISSUED_AT,
      currency: 'EUR',
      paymentMethod: 'Espèces',
      lineItems: [{ label: 'Consultation', quantity: 1, unitAmountHtCents: AMOUNT_CENTS, vatRate: 0, displayOrder: 0 }],
      payments: [{ amountCents: AMOUNT_CENTS, paidAt: ISSUED_AT, currency: 'EUR', paymentMethod: 'Espèces' }]
    });
    check('creation facture (201)', inv.status === 201, `statut ${inv.status}`);
    const invoiceId = inv.body?.invoiceId;
    const invoiceNumber = String(inv.body?.invoiceNumber ?? '');
    check('numero au format AAAA-XXXXXX attribue par le serveur', /^2026-\d{6}$/.test(invoiceNumber), invoiceNumber);
    check('numero client non repris tel quel', invoiceNumber !== 'NUMERO-CLIENT');

    section('Livre des recettes');
    const rec = await admin.get('/api/billing/recettes?from=2026-06-01&to=2026-06-30');
    check('livre des recettes accessible (200)', rec.status === 200, `statut ${rec.status}`);
    const entries = rec.body?.entries ?? [];
    check('l encaissement figure au livre', entries.some((e) => e.amountCents === AMOUNT_CENTS));

    section('Annulation de la facture');
    const del = await admin.del(`/api/billing/invoices/${invoiceId}`);
    check('annulation acceptee (200)', del.status === 200, `statut ${del.status}`);
    const rec2 = await admin.get('/api/billing/recettes?from=2026-06-01&to=2026-06-30');
    const entriesAfter = rec2.body?.entries ?? [];
    check('la recette est retiree du livre apres annulation', entriesAfter.every((e) => e.amountCents !== AMOUNT_CENTS));
  } finally {
    await server.stop();
  }
  finish();
}

main().catch((err) => {
  console.error('[E2E parcours clinique] Erreur inattendue :', err?.message ?? err);
  process.exitCode = 1;
});
