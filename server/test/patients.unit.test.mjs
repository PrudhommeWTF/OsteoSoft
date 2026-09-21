// Patients et consultations (server/lib/patients.mjs) : fonctions pures. Les
// opérations liées à la base et au chiffrement restent dans index.mjs et sont
// couvertes par les tests d'isolation cabinet/consultation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSULTATION_SECTION_KEYS,
  normalizeOfficeConsultationProfiles,
  parseOfficeConsultationProfiles,
  normalizePatientLetterTemplates,
  extractAntecedentCategories,
  buildAntecedentSortKey,
  parsePatientAntecedentsFromMedicalHistory,
  normalizeConsultationReasonItems,
  buildEmptyConsultationSections,
  normalizeConsultationSectionsPayload,
  hasConsultationSectionsContent,
  normalizePatientSexLabel,
  computePatientRetentionDateIso,
  inferConsultationType,
  buildDataImportPatientKey
} from '../lib/patients.mjs';

describe('Profils de consultation d un cabinet', () => {
  test('normalise, complète les champs manquants et ordonne', () => {
    const profiles = normalizeOfficeConsultationProfiles([
      { name: 'Adulte', reasons: ['Lombalgie', ''] },
      'invalide',
      { id: 'p3', name: '', reasons: 'pasuntableau' }
    ]);
    assert.equal(profiles.length, 2, 'l entrée non-objet est écartée');
    assert.equal(profiles[0].name, 'Adulte');
    assert.deepEqual(profiles[0].reasons, ['Lombalgie'], 'les motifs vides sont retirés');
    assert.equal(profiles[0].displayOrder, 1);
    assert.equal(profiles[1].id, 'p3');
    assert.equal(profiles[1].name, 'Profil 3', 'nom par défaut');
    assert.deepEqual(profiles[1].reasons, []);
  });

  test('parseOfficeConsultationProfiles tolère un JSON invalide', () => {
    assert.deepEqual(parseOfficeConsultationProfiles('pas du json'), []);
    assert.deepEqual(parseOfficeConsultationProfiles(''), []);
    assert.equal(parseOfficeConsultationProfiles(JSON.stringify([{ name: 'X' }])).length, 1);
  });
});

describe('Modèles de courrier', () => {
  test('normalise et tronque', () => {
    const templates = normalizePatientLetterTemplates([{ title: '  Attestation  ', content: 'Corps' }]);
    assert.deepEqual(templates, [{ title: 'Attestation', content: 'Corps' }]);
    assert.deepEqual(normalizePatientLetterTemplates('pas du json'), []);
  });
});

describe('Antécédents', () => {
  test('extractAntecedentCategories liste les catégories', () => {
    const cats = extractAntecedentCategories(JSON.stringify([
      { category: 'Chirurgical' }, { category: '' }, { description: 'sans cat' }
    ]));
    assert.deepEqual(cats, ['Chirurgical']);
  });

  test('buildAntecedentSortKey encode année, mois et date', () => {
    assert.equal(buildAntecedentSortKey('year', '2020'), 2020 * 10000 + 1231);
    assert.equal(buildAntecedentSortKey('month', '06/2020'), 2020 * 10000 + 6 * 100 + 31);
    assert.equal(buildAntecedentSortKey('date', '15/06/2020'), 2020 * 10000 + 6 * 100 + 15);
    assert.equal(buildAntecedentSortKey('date', '99/99/9999'), null, 'date invalide rejetée');
  });

  test('parsePatientAntecedentsFromMedicalHistory filtre les entrées incomplètes', () => {
    const items = parsePatientAntecedentsFromMedicalHistory(JSON.stringify([
      { datePrecision: 'year', date: '2019', category: 'Médical', description: 'Asthme' },
      { date: '', category: 'X' }, // date manquante -> écartée
      { date: '2019', category: '' } // catégorie manquante -> écartée
    ]));
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'Médical');
    assert.equal(items[0].sortKey, 2019 * 10000 + 1231);
  });
});

describe('Consultation : motifs et sections', () => {
  test('normalizeConsultationReasonItems déduplique par libellé', () => {
    const items = normalizeConsultationReasonItems([
      { label: 'Dos', value: 'x' },
      { label: 'Dos', value: 'y' },
      { label: '', value: 'z' }
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Dos');
    assert.equal(items[0].value, 'x', 'la première occurrence est conservée');
  });

  test('buildEmptyConsultationSections couvre toutes les clés', () => {
    const empty = buildEmptyConsultationSections();
    for (const key of CONSULTATION_SECTION_KEYS) {
      assert.equal(empty[key], '');
    }
  });

  test('normalizeConsultationSectionsPayload ne garde que les clés connues', () => {
    const s = normalizeConsultationSectionsPayload({ motifMainHtml: '<p>x</p>', inconnu: 'y' });
    assert.equal(s.motifMainHtml, '<p>x</p>');
    assert.equal(s.inconnu, undefined);
    assert.equal(s.testsHtml, '');
  });

  test('hasConsultationSectionsContent détecte un contenu non vide', () => {
    assert.equal(hasConsultationSectionsContent(buildEmptyConsultationSections()), false);
    assert.equal(hasConsultationSectionsContent({ motifMainHtml: '  ' }), false);
    assert.equal(hasConsultationSectionsContent({ testsHtml: 'x' }), true);
  });
});

describe('Divers patient', () => {
  test('normalizePatientSexLabel', () => {
    assert.equal(normalizePatientSexLabel('F'), 'Femme');
    assert.equal(normalizePatientSexLabel('M'), 'Homme');
    assert.equal(normalizePatientSexLabel('?'), 'Non renseigne');
  });

  test('inferConsultationType par mots-clés', () => {
    assert.equal(inferConsultationType('Urgence lombaire'), 'Urgence');
    assert.equal(inferConsultationType('Premier rendez-vous'), 'Bilan');
    assert.equal(inferConsultationType('Suivi trimestriel'), 'Suivi');
    assert.equal(inferConsultationType('Séance'), 'Consultation');
  });

  test('buildDataImportPatientKey normalise la clé', () => {
    assert.equal(buildDataImportPatientKey('  DUPONT ', 'Jean', '1980-01-01'), 'dupont|jean|1980-01-01');
  });
});

describe('computePatientRetentionDateIso', () => {
  test('adulte : 10 ans à compter d aujourd hui', () => {
    const iso = computePatientRetentionDateIso('1980-05-10');
    const expectedYear = new Date().getFullYear() + 10;
    assert.equal(Number(iso.slice(0, 4)), expectedYear);
  });

  test('sans date de naissance : 10 ans à compter d aujourd hui', () => {
    const iso = computePatientRetentionDateIso(null);
    assert.equal(Number(iso.slice(0, 4)), new Date().getFullYear() + 10);
  });

  test('mineur : conservation jusqu au 28e anniversaire si au-delà des 10 ans', () => {
    const currentYear = new Date().getFullYear();
    const birthYear = currentYear - 5; // enfant de 5 ans
    const iso = computePatientRetentionDateIso(`${birthYear}-03-01`);
    assert.equal(Number(iso.slice(0, 4)), birthYear + 28, '28e anniversaire, plus lointain que 10 ans');
  });
});
