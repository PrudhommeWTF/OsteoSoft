// Paramètres cabinet (server/lib/office-settings.mjs) : fonctions pures de
// normalisation. Les lectures/écritures liées à la base restent dans index.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultOfficeOpeningHours,
  normalizeOfficeOpeningHours,
  parseOfficeOpeningHours,
  normalizeOfficeDefaultSessionDurationMinutes,
  normalizeOfficeDevise,
  normalizeOfficeInvoiceNumberFormat,
  normalizeOfficeInvoiceNumberingConfiguration,
  normalizeInvoiceTemplateLayoutJson,
  inferPaymentMethodSystemKey,
  normalizeOfficeIds
} from '../lib/office-settings.mjs';

describe('Horaires d ouverture', () => {
  test('createDefaultOfficeOpeningHours couvre les 7 jours, vides', () => {
    const h = createDefaultOfficeOpeningHours();
    for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      assert.deepEqual(h[day], []);
    }
  });

  test('normalizeOfficeOpeningHours ne garde que les plages HH:MM valides', () => {
    const h = normalizeOfficeOpeningHours({
      monday: [{ start: '08:00', end: '12:00' }, { start: '25:00', end: '99:99' }],
      badday: [{ start: '09:00', end: '10:00' }]
    });
    assert.equal(h.monday.length, 1, 'la plage invalide est retirée');
    assert.equal(h.monday[0].start, '08:00');
    assert.equal(h.badday, undefined, 'un jour inconnu est ignoré');
  });

  test('parseOfficeOpeningHours tolère un JSON invalide', () => {
    const h = parseOfficeOpeningHours('pas du json');
    assert.deepEqual(h.monday, []);
  });
});

describe('Réglages simples', () => {
  test('durée de séance bornée entre 15 et 90, défaut 60', () => {
    assert.equal(normalizeOfficeDefaultSessionDurationMinutes(30), 30);
    assert.equal(normalizeOfficeDefaultSessionDurationMinutes(5), 15);
    assert.equal(normalizeOfficeDefaultSessionDurationMinutes(200), 90);
    assert.equal(normalizeOfficeDefaultSessionDurationMinutes('abc'), 60);
  });

  test('devise limitée à une liste connue, défaut EUR', () => {
    assert.equal(normalizeOfficeDevise('usd'), 'USD');
    assert.equal(normalizeOfficeDevise('CHF'), 'CHF');
    assert.equal(normalizeOfficeDevise('yen'), 'EUR');
  });

  test('format de numéro de facture limité, défaut AAAA-XXXXXX', () => {
    assert.equal(normalizeOfficeInvoiceNumberFormat('AAAAMM-XXXXXX'), 'AAAAMM-XXXXXX');
    assert.equal(normalizeOfficeInvoiceNumberFormat('n importe quoi'), 'AAAA-XXXXXX');
  });

  test('configuration de numérotation : globale par défaut', () => {
    assert.equal(normalizeOfficeInvoiceNumberingConfiguration('Numérotation par praticien'), 'Numérotation par praticien');
    assert.equal(normalizeOfficeInvoiceNumberingConfiguration('autre'), 'Numérotation globale au cabinet');
  });
});

describe('Méthodes de paiement et cabinets', () => {
  test('inferPaymentMethodSystemKey déduit la clé système', () => {
    assert.equal(inferPaymentMethodSystemKey('Carte Bancaire'), 'cb');
    assert.equal(inferPaymentMethodSystemKey('CB'), 'cb');
    assert.equal(inferPaymentMethodSystemKey(''), null);
  });

  test('normalizeOfficeIds dédoublonne, filtre et applique le repli', () => {
    assert.deepEqual(normalizeOfficeIds([1, 2, 2, 0, '3', -1]).sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(normalizeOfficeIds([], 7), [7], 'repli si liste vide');
    assert.deepEqual(normalizeOfficeIds([], null), []);
  });
});

describe('Modèle de facture', () => {
  test('normalizeInvoiceTemplateLayoutJson produit un JSON avec les blocs et bornes', () => {
    const json = normalizeInvoiceTemplateLayoutJson(JSON.stringify({
      logo: { x: -50, y: 5, w: 200 } // valeurs hors bornes -> ramenées
    }));
    const parsed = JSON.parse(json);
    assert.ok(parsed.logo, 'le bloc logo est présent');
    assert.ok(parsed.logo.x >= 0, 'x borné à un minimum');
    assert.ok(parsed.logo.w <= 96, 'w borné à un maximum');
    // Un modèle vide reste un JSON valide et complet
    const empty = JSON.parse(normalizeInvoiceTemplateLayoutJson(null));
    assert.ok(empty.practitioner, 'les blocs par défaut sont présents');
  });
});
