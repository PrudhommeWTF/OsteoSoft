// Import WebOsteo AVEC l'export « liste patients » : l'identite chiffree dans la
// sauvegarde est remplacee par le clair de l'export, rapproche par patient.id.
// Donnees entierement fictives.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, setupCleanInstance, createOffice, openTestDb, decryptField } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

// Faux blob chiffre WebOsteo : 2 octets par octet UTF-8 du clair (base64).
function fakeCipher(plain) {
  const n = Buffer.byteLength(plain, 'utf8') * 2;
  return Buffer.alloc(n, 0x2a).toString('base64');
}

// Base WebOsteo minimale avec DEUX patients : identite chiffree, prenom en clair.
function buildWeoBase64() {
  const dir = mkdtempSync(join(tmpdir(), 'weo-listing-'));
  const p = join(dir, 'webosteo.sqlite');
  const db = new Database(p);
  db.exec(`CREATE TABLE patient (id INTEGER, nom TEXT, prenom TEXT, date_naissance TEXT, sexe TEXT, telephone1 TEXT, telephone2 TEXT, email TEXT, code_postal TEXT, ville TEXT, secu TEXT, created TEXT);
           CREATE TABLE agenda (id INTEGER, patient INTEGER, libelle TEXT);`);
  // Alice DUPONT : nom chiffre (6 octets), tel chiffre, cp chiffre.
  db.prepare('INSERT INTO patient VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    101, fakeCipher('DUPONT'), 'Alice', '19900101', 'f', fakeCipher('0612345678'), '', fakeCipher('a@ex.test'), fakeCipher('75001'), fakeCipher('Paris'), '', '20200101');
  // Bob MARTIN.
  db.prepare('INSERT INTO patient VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    102, fakeCipher('MARTIN'), 'Bob', '19850615', 'm', fakeCipher('0700000000'), '', '', fakeCipher('69003'), fakeCipher('Lyon'), '', '20200202');
  db.close();
  const b64 = readFileSync(p).toString('base64');
  rmSync(dir, { recursive: true, force: true });
  return b64;
}

// Export « liste patients » (.xlsx) : identite EN CLAIR.
async function buildListingBase64() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Listing patient');
  ws.addRow(['Listing patient généré au : 25/09/2026']);
  ws.addRow(['Nom', 'Prénom', 'Sexe', 'Date de naissance', 'Téléphone portable', 'Téléphone fixe', 'Adresse email', 'Adresse 1', 'Adresse 2', 'Code postal', 'Ville', 'Numéro Sécurité Sociale', 'Créé le']);
  ws.addRow(['DUPONT', 'Alice', 'f', '01/01/1990', '06 12 34 56 78', '', 'alice@example.test', '', '', '75001', 'Paris', '', '01/01/2020']);
  ws.addRow(['MARTIN', 'Bob', 'm', '15/06/1985', '07 00 00 00 00', '', '', '', '', '69003', 'Lyon', '', '02/02/2020']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

let server, admin, officeId, weoBase64, listingBase64;

before(async () => {
  server = await startTestServer();
  const s = await setupCleanInstance(server.baseUrl);
  admin = s.client; officeId = s.officeId;
  weoBase64 = buildWeoBase64();
  listingBase64 = await buildListingBase64();
});
after(async () => { await server?.stop(); });

describe('Import WebOsteo avec export liste patients', () => {
  test('l identite en clair de l export remplace le champ chiffre', async () => {
    const r = await admin.post('/api/data-management/webosteo-import', {
      officeId, contentBase64: weoBase64, fileName: 'webosteo.sqlite',
      listingBase64, listingFileName: 'listing.xlsx'
    });
    assert.equal(r.status, 200, r.raw?.slice(0, 300));
    assert.equal(r.body.importedPatients, 2);
    assert.ok(r.body.listing, 'stats de rapprochement presentes');
    assert.equal(r.body.listing.matched, 2, 'les deux patients rapproches');

    const db = openTestDb(server);
    const rows = db.prepare('SELECT cipher_full_name, cipher_phone, cipher_medical_notes FROM patients ORDER BY id').all();
    const names = rows.map((x) => decryptField(server.dataKey, x.cipher_full_name));
    db.close();

    assert.ok(names.includes('DUPONT Alice'), `nom clair attendu, obtenu: ${JSON.stringify(names)}`);
    assert.ok(names.includes('MARTIN Bob'), `nom clair attendu, obtenu: ${JSON.stringify(names)}`);

    const alice = rows.find((x) => decryptField(server.dataKey, x.cipher_full_name) === 'DUPONT Alice');
    assert.equal(decryptField(server.dataKey, alice.cipher_phone), '06 12 34 56 78', 'telephone en clair depuis l export');
    const notes = JSON.parse(decryptField(server.dataKey, alice.cipher_medical_notes));
    assert.equal(notes.email, 'alice@example.test');
    assert.equal(notes.postalCode, '75001');
    assert.equal(notes.city, 'Paris');
  });

  test('sans export, le champ chiffre reste illisible (pas de rapprochement)', async () => {
    // Second cabinet pour repartir de zero (sans re-declencher la config initiale).
    const office2 = await createOffice(admin, 'Cabinet sans export');
    const r = await admin.post('/api/data-management/webosteo-import', {
      officeId: office2, contentBase64: weoBase64, fileName: 'webosteo.sqlite'
    });
    assert.equal(r.status, 200, r.raw?.slice(0, 300));
    assert.equal(r.body.listing, null, 'aucune stat de rapprochement sans export');
    const db = openTestDb(server);
    const rows = db.prepare('SELECT cipher_full_name FROM patients WHERE office_id = ?').all(office2);
    const names = rows.map((x) => decryptField(server.dataKey, x.cipher_full_name));
    db.close();
    // Le nom vient du champ chiffre brut (illisible), pas « DUPONT ».
    assert.ok(!names.includes('DUPONT Alice'), 'sans export, le nom clair ne doit pas apparaitre');
  });
});
