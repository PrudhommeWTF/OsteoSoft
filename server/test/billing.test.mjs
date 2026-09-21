// Facturation (server/lib/billing.mjs) : fonctions pures. Les opérations liées à
// la base (détail, paiements, recalcul d'état) sont couvertes par les tests
// d'intégration billing-invoices.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBillingOperationId,
  normalizeBillingPaymentMethod,
  billingPaymentMethodMatchesDepositType,
  buildBillingDateRange,
  normalizeInvoiceLineItems,
  normalizeInvoicePayments,
  computeInvoiceStatusFromPayments
} from '../lib/billing.mjs';

describe('parseBillingOperationId', () => {
  test('décompose un identifiant valide', () => {
    assert.deepEqual(parseBillingOperationId('invoice:42'), { sourceType: 'invoice', sourceId: 42 });
    assert.deepEqual(parseBillingOperationId('deposit:7'), { sourceType: 'deposit', sourceId: 7 });
  });

  test('rejette un type inconnu ou un id invalide', () => {
    assert.equal(parseBillingOperationId('patient:1'), null);
    assert.equal(parseBillingOperationId('invoice:0'), null);
    assert.equal(parseBillingOperationId('invoice:-3'), null);
    assert.equal(parseBillingOperationId('invoice:abc'), null);
    assert.equal(parseBillingOperationId('invoice'), null);
    assert.equal(parseBillingOperationId(''), null);
  });
});

describe('Méthodes de paiement', () => {
  test('normalizeBillingPaymentMethod met en minuscules et retire les accents', () => {
    assert.equal(normalizeBillingPaymentMethod('Espèces'), 'especes');
    assert.equal(normalizeBillingPaymentMethod('  CHÈQUE '), 'cheque');
  });

  test('billingPaymentMethodMatchesDepositType associe méthode et type de remise', () => {
    assert.equal(billingPaymentMethodMatchesDepositType('Chèque', 'cheque'), true);
    assert.equal(billingPaymentMethodMatchesDepositType('chq', 'cheque'), true);
    assert.equal(billingPaymentMethodMatchesDepositType('Espèces', 'especes'), true);
    assert.equal(billingPaymentMethodMatchesDepositType('Liquide', 'especes'), true);
    assert.equal(billingPaymentMethodMatchesDepositType('Carte', 'cheque'), false);
    assert.equal(billingPaymentMethodMatchesDepositType('', 'especes'), false);
  });
});

describe('buildBillingDateRange', () => {
  test('utilise les dates fournies, bornées début et fin de journée', () => {
    const range = buildBillingDateRange('2024-03-10', '2024-03-20');
    assert.equal(range.from.getFullYear(), 2024);
    assert.equal(range.from.getHours(), 0);
    assert.equal(range.from.getMinutes(), 0);
    assert.equal(range.to.getHours(), 23);
    assert.equal(range.to.getMinutes(), 59);
    assert.ok(range.fromIso <= range.toIso);
  });

  test('retombe sur le mois courant si les dates sont invalides', () => {
    const range = buildBillingDateRange('', 'pas-une-date');
    assert.ok(range.from.getTime() <= range.to.getTime(), 'from avant to');
  });
});

describe('normalizeInvoiceLineItems', () => {
  test('conserve les lignes valides et ignore les invalides', () => {
    const items = normalizeInvoiceLineItems([
      { label: 'Séance', quantity: 2, unitAmountHtCents: 5000, vatRate: 0 },
      { label: '', quantity: 1, unitAmountHtCents: 100 }, // libellé vide -> ignorée
      { label: 'Négatif', quantity: 1, unitAmountHtCents: -1 } // montant négatif -> ignorée
    ], 6000);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Séance');
    assert.equal(items[0].quantity, 2);
  });

  test('produit une ligne de repli si aucune ligne valide', () => {
    const items = normalizeInvoiceLineItems([], 6000);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Consultation');
    assert.equal(items[0].unitAmountHtCents, 6000);
  });
});

describe('normalizeInvoicePayments', () => {
  test('conserve les paiements de montant positif', () => {
    const payments = normalizeInvoicePayments(
      [{ amountCents: 5000, paymentMethod: 'Carte' }, { amountCents: 0 }],
      null, 'EUR', 5000, '2024-01-01T00:00:00.000Z'
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amountCents, 5000);
    assert.equal(payments[0].currency, 'EUR');
  });

  test('crée un paiement de repli à partir de la méthode par défaut', () => {
    const payments = normalizeInvoicePayments([], 'Espèces', 'EUR', 6000, '2024-01-01T00:00:00.000Z');
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amountCents, 6000);
    assert.equal(payments[0].paymentMethod, 'Espèces');
  });

  test('renvoie une liste vide sans paiement ni méthode par défaut', () => {
    assert.deepEqual(normalizeInvoicePayments([], '', 'EUR', 6000, '2024-01-01T00:00:00.000Z'), []);
  });
});

describe('computeInvoiceStatusFromPayments', () => {
  test('impayee quand aucun paiement', () => {
    assert.equal(computeInvoiceStatusFromPayments(6000, [], ''), 'impayee');
  });

  test('annulee est conservé si demandé et aucun paiement', () => {
    assert.equal(computeInvoiceStatusFromPayments(6000, [], 'annulee'), 'annulee');
  });

  test('payee quand le total est couvert', () => {
    assert.equal(computeInvoiceStatusFromPayments(6000, [{ amountCents: 6000 }], ''), 'payee');
    assert.equal(computeInvoiceStatusFromPayments(6000, [{ amountCents: 7000 }], ''), 'payee');
  });

  test('partiellement_payee quand le paiement est inférieur au total', () => {
    assert.equal(computeInvoiceStatusFromPayments(6000, [{ amountCents: 2000 }], ''), 'partiellement_payee');
  });
});
