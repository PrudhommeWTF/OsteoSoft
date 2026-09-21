// Import WebOsteo : import initial correct, puis idempotence (aucun doublon au
// second passage). Utilise un fichier SQLite WebOsteo SYNTHÉTIQUE, données
// entièrement fictives (aucune donnée patient réelle).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, setupCleanInstance, openTestDb } from './helpers/harness.mjs';

// Construit une base WebOsteo minimale (patient, consultation, facture, paiement,
// remise chèque) et renvoie son contenu en base64.
function buildWebosteoBase64() {
  const dir = mkdtempSync(join(tmpdir(), 'weo-fixture-'));
  const p = join(dir, 'webosteo.sqlite');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE patient (id INTEGER, nom TEXT, prenom TEXT, date_naissance TEXT, sexe TEXT);
    CREATE TABLE consultation (id INTEGER, patient INTEGER, date_consult TEXT, titre TEXT, motif TEXT, traitement TEXT, createdby TEXT);
    CREATE TABLE personne (id INTEGER, type_entite TEXT, id_entite INTEGER);
    CREATE TABLE facture (id INTEGER, personne_client INTEGER, date_facture TEXT, montant_ttc REAL, etat_paiement TEXT, numero_formatte TEXT, devise TEXT, id_consultation INTEGER);
    CREATE TABLE facture_ligne (id_facture INTEGER, libelle TEXT, quantite REAL, montant_ht_unitaire REAL, taux_tva REAL, ordre INTEGER);
    CREATE TABLE paiement (id INTEGER, date_paiement TEXT, montant REAL, moyen_paiement TEXT, paiement_banque TEXT, cheque_emetteur TEXT, id_remise_cheque INTEGER);
    CREATE TABLE paiement_facture (id_facture INTEGER, id_paiement INTEGER);
    CREATE TABLE remise_cheque (id INTEGER, montant_cheques REAL, date_remise TEXT, banque TEXT, reference TEXT);
    CREATE TABLE remise_especes (id INTEGER, montant REAL, date_remise TEXT);
  `);
  db.prepare('INSERT INTO patient VALUES (?,?,?,?,?)').run(1, 'Testpatient', 'Fictif', '19900101', 'f');
  db.prepare('INSERT INTO consultation VALUES (?,?,?,?,?,?,?)').run(1, 1, '202401151000', 'Consultation test', 'Motif fictif', 'Traitement fictif', 'Dr Test');
  db.prepare('INSERT INTO personne VALUES (?,?,?)').run(1, 'patient', 1);
  db.prepare('INSERT INTO facture VALUES (?,?,?,?,?,?,?,?)').run(1, 1, '20240115', 50.0, 'paye', 'WEO-0001', 'EUR', 1);
  db.prepare('INSERT INTO facture_ligne VALUES (?,?,?,?,?,?)').run(1, 'Consultation', 1, 50.0, 0, 0);
  db.prepare('INSERT INTO paiement VALUES (?,?,?,?,?,?,?)').run(1, '20240115', 50.0, 'cheque', 'Banque Test', '12345', 1);
  db.prepare('INSERT INTO paiement_facture VALUES (?,?)').run(1, 1);
  db.prepare('INSERT INTO remise_cheque VALUES (?,?,?,?,?)').run(1, 50.0, '20240116', 'Banque Test', 'REM-0001');
  // remise_especes reste vide, mais doit exister pour l'approche deux-tables.
  db.close();
  const b64 = readFileSync(p).toString('base64');
  rmSync(dir, { recursive: true, force: true });
  return b64;
}

let server;
let admin;
let officeId;
let weoBase64;

function importWebosteo() {
  return admin.post('/api/data-management/webosteo-import', {
    officeId,
    contentBase64: weoBase64,
    fileName: 'webosteo.sqlite'
  });
}

function tableCounts() {
  const db = openTestDb(server);
  const one = (sql) => db.prepare(sql).get().n;
  const counts = {
    patients: one('SELECT COUNT(*) n FROM patients'),
    consultations: one('SELECT COUNT(*) n FROM consultations'),
    invoices: one('SELECT COUNT(*) n FROM invoices'),
    invoicePayments: one('SELECT COUNT(*) n FROM invoice_payments'),
    accountingDeposits: one('SELECT COUNT(*) n FROM accounting_deposits')
  };
  db.close();
  return counts;
}

before(async () => {
  server = await startTestServer();
  const s = await setupCleanInstance(server.baseUrl);
  admin = s.client;
  officeId = s.officeId;
  weoBase64 = buildWebosteoBase64();
});

after(async () => {
  await server?.stop();
});

describe('Import WebOsteo', () => {
  test('le premier import crée les entités attendues', async () => {
    const r = await importWebosteo();
    assert.equal(r.status, 200, `import échoué: ${r.raw?.slice(0, 200)}`);
    assert.ok(r.body.importedPatients >= 1, 'au moins un patient importé');
    assert.ok(r.body.importedConsultations >= 1, 'au moins une consultation importée');
    assert.ok(r.body.importedInvoices >= 1, 'au moins une facture importée');
    assert.ok(r.body.importedDeposits >= 1, 'au moins une remise importée');
    assert.equal((r.body.errors ?? []).length, 0, 'aucune erreur d import');
  });

  test('un second import du même fichier ne crée aucun doublon', async () => {
    const before = tableCounts();
    const r = await importWebosteo();
    assert.equal(r.status, 200);
    const after = tableCounts();
    assert.deepEqual(after, before, 'les effectifs doivent être identiques après un second import (idempotence)');
  });
});
