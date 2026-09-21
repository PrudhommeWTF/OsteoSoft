// Sauvegarde (server/lib/backup.mjs) : fonctions pures. L'empreinte stable, la
// lecture de version majeure et le filtrage par cabinets. La construction et la
// restauration liées à la base sont couvertes par les tests d'intégration
// backup-restore.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackupDataSha256,
  computeBackupDataSha256Legacy,
  parseMajorVersion,
  filterBackupDataByOfficeIds
} from '../lib/backup.mjs';

describe('Empreinte des données de sauvegarde', () => {
  test('computeBackupDataSha256 est stable quel que soit l ordre des clés', () => {
    const a = computeBackupDataSha256({ patients: [{ id: 1, office_id: 2, name: 'x' }] });
    const b = computeBackupDataSha256({ patients: [{ name: 'x', office_id: 2, id: 1 }] });
    assert.equal(a, b, 'l ordre des propriétés ne doit pas changer l empreinte');
  });

  test('computeBackupDataSha256 change si une valeur change', () => {
    const a = computeBackupDataSha256({ patients: [{ id: 1 }] });
    const b = computeBackupDataSha256({ patients: [{ id: 2 }] });
    assert.notEqual(a, b);
  });

  test('la variante historique dépend de l ordre des clés (contraste)', () => {
    const a = computeBackupDataSha256Legacy({ id: 1, office_id: 2 });
    const b = computeBackupDataSha256Legacy({ office_id: 2, id: 1 });
    assert.notEqual(a, b, 'la variante historique est sensible à l ordre');
  });
});

describe('parseMajorVersion', () => {
  test('extrait la version majeure', () => {
    assert.equal(parseMajorVersion('3.2.1'), 3);
    assert.equal(parseMajorVersion('0.3.0'), 0);
    assert.equal(parseMajorVersion('12'), 12);
  });

  test('renvoie null pour une entrée invalide', () => {
    assert.equal(parseMajorVersion('abc'), null);
    assert.equal(parseMajorVersion(''), null);
    assert.equal(parseMajorVersion(null), null);
  });
});

// Construit un jeu de données de sauvegarde vide (toutes les collections), pour
// tester le filtrage sans dépendre de champs absents.
function emptyBackupData() {
  return {
    accessProfiles: [], users: [], userOffices: [], officeUserDelegations: [],
    patients: [], appointments: [], invoices: [], invoiceLineItems: [],
    invoicePayments: [], accountingExpenses: [], accountingDeposits: [],
    accountingDepositItems: [], accountingOperationMeta: [], consultations: [],
    consultationReasonItems: [], consultationSections: [], patientDocuments: [],
    antecedentTypes: [], patientAntecedents: [], serviceTypes: [], paymentMethods: [],
    localCalendars: [], directoryContacts: [], config: [], patientDrafts: [], auditLogs: []
  };
}

describe('filterBackupDataByOfficeIds', () => {
  test('sans cabinet sélectionné, vide les collections cloisonnables', () => {
    const data = emptyBackupData();
    data.patients = [{ id: 1, office_id: 2 }];
    data.config = [{ key: 'app_name', value: 'X' }];
    const filtered = filterBackupDataByOfficeIds(data, []);
    assert.deepEqual(filtered.patients, []);
    assert.deepEqual(filtered.config, []);
  });

  test('ne conserve que les patients des cabinets sélectionnés', () => {
    const data = emptyBackupData();
    data.patients = [
      { id: 1, office_id: 2 },
      { id: 2, office_id: 3 }
    ];
    const filtered = filterBackupDataByOfficeIds(data, [2]);
    assert.deepEqual(filtered.patients.map((p) => p.id), [1]);
  });

  test('conserve les entités liées de façon transitive à un patient retenu', () => {
    const data = emptyBackupData();
    data.patients = [{ id: 1, office_id: 2 }];
    // Rattachées au patient 1 mais sans office_id propre : doivent suivre le patient.
    data.consultations = [{ id: 10, patient_id: 1, office_id: null }];
    data.appointments = [{ id: 20, patient_id: 1, office_id: null, consultation_id: 10 }];
    data.invoices = [{ id: 30, patient_id: 1, office_id: null }];
    data.invoiceLineItems = [{ id: 40, invoice_id: 30 }];
    data.consultationSections = [{ id: 50, consultation_id: 10 }];

    const filtered = filterBackupDataByOfficeIds(data, [2]);
    assert.deepEqual(filtered.consultations.map((r) => r.id), [10], 'consultation du patient retenu');
    assert.deepEqual(filtered.appointments.map((r) => r.id), [20], 'rendez-vous du patient retenu');
    assert.deepEqual(filtered.invoices.map((r) => r.id), [30], 'facture du patient retenu');
    assert.deepEqual(filtered.invoiceLineItems.map((r) => r.id), [40], 'lignes de la facture retenue');
    assert.deepEqual(filtered.consultationSections.map((r) => r.id), [50], 'sections de la consultation retenue');
  });

  test('exclut les entités d un cabinet non sélectionné', () => {
    const data = emptyBackupData();
    data.patients = [{ id: 1, office_id: 2 }, { id: 2, office_id: 9 }];
    data.invoices = [{ id: 30, patient_id: 2, office_id: 9 }];
    const filtered = filterBackupDataByOfficeIds(data, [2]);
    assert.deepEqual(filtered.patients.map((p) => p.id), [1]);
    assert.deepEqual(filtered.invoices, [], 'facture d un patient hors périmètre exclue');
  });
});
