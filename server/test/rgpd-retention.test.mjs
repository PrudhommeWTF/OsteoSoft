// RGPD / retention : duree de retention parametrable (pur), et anonymisation
// confirmee (plus d'anonymisation automatique). Un dossier echu n'est detruit
// qu'apres confirmation explicite, et seulement s'il est reellement eligible.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { computePatientRetentionDateIso } from '../lib/patients.mjs';
import { startTestServer, setupCleanInstance } from './helpers/harness.mjs';

describe('Duree de retention parametrable (pur)', () => {
  test('defaut : 10 ans a compter d aujourd hui', () => {
    const iso = computePatientRetentionDateIso(null);
    assert.equal(Number(iso.slice(0, 4)), new Date().getFullYear() + 10);
  });

  test('duree personnalisee : 20 ans', () => {
    const iso = computePatientRetentionDateIso(null, { years: 20 });
    assert.equal(Number(iso.slice(0, 4)), new Date().getFullYear() + 20);
  });

  test('mineur : age de conservation personnalisable', () => {
    const currentYear = new Date().getFullYear();
    const birthYear = currentYear - 5;
    const iso = computePatientRetentionDateIso(`${birthYear}-03-01`, { years: 10, minorUntilAge: 30 });
    assert.equal(Number(iso.slice(0, 4)), birthYear + 30);
  });

  test('valeurs invalides : repli sur les defauts', () => {
    const iso = computePatientRetentionDateIso(null, { years: 0 });
    assert.equal(Number(iso.slice(0, 4)), new Date().getFullYear() + 10);
  });
});

describe('Anonymisation confirmee (plus d automatique)', () => {
  let server;
  let admin;
  let patientId;
  let writeDb;

  before(async () => {
    server = await startTestServer();
    admin = (await setupCleanInstance(server.baseUrl)).client;
    const pa = await admin.post('/api/patients', { sex: 'Femme', lastName: 'RetentionA', firstName: 'R', consentSigned: true });
    patientId = pa.body?.patient?.id;
    // Force une echeance de retention passee, comme un dossier arrive a terme.
    writeDb = new Database(server.dbPath);
    writeDb.prepare('UPDATE patients SET retention_until = ? WHERE id = ?').run('2000-01-01', patientId);
  });

  after(async () => {
    try { writeDb?.close(); } catch { /* ignore */ }
    await server?.stop();
  });

  test('un dossier echu n est PAS detruit automatiquement, mais signale comme eligible', async () => {
    const r = await admin.get('/api/data-management/retention-status');
    assert.equal(r.status, 200);
    const eligible = (r.body.eligibleForAnonymization ?? []).map((e) => e.id);
    assert.ok(eligible.includes(patientId), 'le dossier echu est signale comme eligible');

    // Le dossier existe toujours (pas d anonymisation automatique).
    const row = writeDb.prepare('SELECT is_deleted FROM patients WHERE id = ?').get(patientId);
    assert.equal(Number(row.is_deleted), 0, 'le dossier n est pas detruit sans confirmation');
  });

  test('l action confirmee ignore un dossier non echu', async () => {
    // Un second patient, retention future (non eligible).
    const pb = await admin.post('/api/patients', { sex: 'Homme', lastName: 'RetentionB', firstName: 'B', consentSigned: true });
    const futureId = pb.body?.patient?.id;
    const r = await admin.post('/api/data-management/anonymize-expired', { patientIds: [futureId] });
    assert.equal(r.status, 200);
    assert.equal(r.body.anonymizedCount, 0, 'aucun dossier non echu anonymise');
    assert.equal(r.body.skipped[0]?.reason, 'retention_non_echue');
  });

  test('l action confirmee anonymise un dossier echu', async () => {
    const r = await admin.post('/api/data-management/anonymize-expired', { patientIds: [patientId] });
    assert.equal(r.status, 200);
    assert.equal(r.body.anonymizedCount, 1);
    assert.deepEqual(r.body.anonymized, [patientId]);

    const row = writeDb.prepare('SELECT is_deleted FROM patients WHERE id = ?').get(patientId);
    assert.equal(Number(row.is_deleted), 1, 'le dossier est anonymise apres confirmation');
  });
});
