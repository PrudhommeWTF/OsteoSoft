// Numérotation des factures : fonctions pures (préfixe/largeur selon le format,
// formatage, extraction de suffixe) et attribution séquentielle liée à la base
// (createBillingService.allocateNextInvoiceNumber), y compris le garde-fou sur
// les numéros déjà présents.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildInvoiceNumberParts,
  formatInvoiceNumber,
  parseInvoiceNumberSuffix,
  createBillingService
} from '../lib/billing.mjs';

describe('buildInvoiceNumberParts', () => {
  const d = new Date('2026-03-09T10:00:00.000Z');
  test('mappe chaque format vers préfixe et largeur', () => {
    assert.deepEqual(buildInvoiceNumberParts('AAAA-XXXXXX', d), { prefix: '2026', digits: 6 });
    assert.deepEqual(buildInvoiceNumberParts('AAAAMM-XXXXXX', d), { prefix: '202603', digits: 6 });
    assert.deepEqual(buildInvoiceNumberParts('AAAAMMJJ-XXXXXX', d), { prefix: '20260309', digits: 6 });
    assert.deepEqual(buildInvoiceNumberParts('AAAAMM-XXXX : RAZ mensuelle (déconseillé)', d), { prefix: '202603', digits: 4 });
    assert.deepEqual(buildInvoiceNumberParts('AAAA-XXXX : RAZ annuel', d), { prefix: '2026', digits: 4 });
  });

  test('format inconnu : repli sur le format par jour', () => {
    assert.deepEqual(buildInvoiceNumberParts('inconnu', d), { prefix: '20260309', digits: 6 });
  });
});

describe('formatInvoiceNumber / parseInvoiceNumberSuffix', () => {
  test('formate avec zéro-padding', () => {
    assert.equal(formatInvoiceNumber('2026', 6, 7), '2026-000007');
    assert.equal(formatInvoiceNumber('202603', 4, 42), '202603-0042');
  });

  test('extrait le suffixe pour le bon préfixe, 0 sinon', () => {
    assert.equal(parseInvoiceNumberSuffix('2026-000007', '2026'), 7);
    assert.equal(parseInvoiceNumberSuffix('2026-000007', '2025'), 0, 'préfixe différent');
    assert.equal(parseInvoiceNumberSuffix('2026-ABC', '2026'), 0, 'suffixe non numérique');
    assert.equal(parseInvoiceNumberSuffix(null, '2026'), 0);
  });
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, office_id INTEGER, invoice_number TEXT NOT NULL UNIQUE);
    CREATE TABLE invoice_number_sequences (
      office_id INTEGER NOT NULL, period_key TEXT NOT NULL, last_value INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (office_id, period_key)
    );
  `);
  return db;
}

const noopDeps = {
  encryptSensitiveField: (v) => v,
  decryptSensitiveField: (v) => v,
  safeDecryptField: (v) => v,
  readOfficePaymentMethods: () => []
};

describe('allocateNextInvoiceNumber (lié à la base)', () => {
  test('attribue une séquence continue par cabinet et période', () => {
    const db = makeDb();
    const { allocateNextInvoiceNumber } = createBillingService(db, noopDeps);
    const n1 = allocateNextInvoiceNumber({ officeId: 1, format: 'AAAA-XXXXXX', issuedAt: '2026-03-01T00:00:00Z' });
    const n2 = allocateNextInvoiceNumber({ officeId: 1, format: 'AAAA-XXXXXX', issuedAt: '2026-05-01T00:00:00Z' });
    assert.equal(n1, '2026-000001');
    assert.equal(n2, '2026-000002', 'même année => même séquence, incrémentée');
    db.close();
  });

  test('séquences indépendantes par cabinet et par période', () => {
    const db = makeDb();
    const { allocateNextInvoiceNumber } = createBillingService(db, noopDeps);
    assert.equal(allocateNextInvoiceNumber({ officeId: 1, format: 'AAAA-XXXXXX', issuedAt: '2026-01-01T00:00:00Z' }), '2026-000001');
    assert.equal(allocateNextInvoiceNumber({ officeId: 2, format: 'AAAA-XXXXXX', issuedAt: '2026-01-01T00:00:00Z' }), '2026-000001', 'autre cabinet => sa propre séquence');
    assert.equal(allocateNextInvoiceNumber({ officeId: 1, format: 'AAAA-XXXXXX', issuedAt: '2027-01-01T00:00:00Z' }), '2027-000001', 'autre année => nouvelle séquence');
    db.close();
  });

  test('garde-fou : ne réutilise pas un suffixe déjà présent en base', () => {
    const db = makeDb();
    const { allocateNextInvoiceNumber } = createBillingService(db, noopDeps);
    // Numéro préexistant (par exemple importé) non tracé par le compteur.
    db.prepare('INSERT INTO invoices (office_id, invoice_number) VALUES (?, ?)').run(1, '2026-000050');
    const next = allocateNextInvoiceNumber({ officeId: 1, format: 'AAAA-XXXXXX', issuedAt: '2026-02-01T00:00:00Z' });
    assert.equal(next, '2026-000051', 'reprend au-dessus du plus grand suffixe existant');
    db.close();
  });
});
