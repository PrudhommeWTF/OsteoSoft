// Statistiques (server/lib/statistics.mjs) : fonctions pures. L'assemblage lié à
// la base est couvert par le test de fumée statistics.smoke.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatisticsScopeMode,
  normalizeStatisticsGranularity,
  normalizeStatisticsYears,
  parseStatisticsYearList,
  normalizeStatisticsText,
  splitStatisticsPatientName,
  stripStatisticsHtml,
  parseStatisticsAntecedents,
  buildStatisticsAnnualValuePoints,
  buildStatisticsConsultationEvolutionPoints
} from '../lib/statistics.mjs';

describe('Normalisation des paramètres', () => {
  test('normalizeStatisticsScopeMode', () => {
    assert.equal(normalizeStatisticsScopeMode('consolidated'), 'consolidated');
    assert.equal(normalizeStatisticsScopeMode('active-office'), 'active-office');
    assert.equal(normalizeStatisticsScopeMode('n importe quoi'), 'active-office');
  });

  test('normalizeStatisticsGranularity', () => {
    assert.equal(normalizeStatisticsGranularity('year'), 'year');
    assert.equal(normalizeStatisticsGranularity('quarter'), 'quarter');
    assert.equal(normalizeStatisticsGranularity('week'), 'month');
    assert.equal(normalizeStatisticsGranularity(undefined), 'month');
  });

  test('normalizeStatisticsYears borne entre 1 et 10', () => {
    assert.equal(normalizeStatisticsYears('3'), 3);
    assert.equal(normalizeStatisticsYears('99'), 10);
    assert.equal(normalizeStatisticsYears('0'), 1);
    assert.equal(normalizeStatisticsYears('abc', 5), 5);
  });

  test('parseStatisticsYearList filtre, déduplique et trie', () => {
    const now = new Date().getFullYear();
    const list = parseStatisticsYearList(`${now},${now},${now - 2},1900,3000`);
    assert.deepEqual(list, [now, now - 2], 'années valides, dédupliquées, décroissantes');
  });

  test('parseStatisticsYearList retombe sur une fenêtre par défaut', () => {
    const now = new Date().getFullYear();
    const list = parseStatisticsYearList('', 3);
    assert.deepEqual(list, [now, now - 1, now - 2]);
  });
});

describe('Texte et noms', () => {
  test('normalizeStatisticsText compacte les espaces', () => {
    assert.equal(normalizeStatisticsText('  a   b\tc '), 'a b c');
    assert.equal(normalizeStatisticsText(null), '');
  });

  test('splitStatisticsPatientName sépare nom et prénom', () => {
    assert.deepEqual(splitStatisticsPatientName('DUPONT Jean'), { lastName: 'DUPONT', firstName: 'Jean' });
    assert.deepEqual(splitStatisticsPatientName('MONONYME'), { lastName: 'MONONYME', firstName: '' });
  });

  test('stripStatisticsHtml retire les balises', () => {
    assert.equal(stripStatisticsHtml('<p>Bonjour <b>monde</b></p>'), 'Bonjour monde');
  });
});

describe('parseStatisticsAntecedents', () => {
  test('lit un JSON d antécédents', () => {
    const items = parseStatisticsAntecedents(JSON.stringify([
      { category: 'Chirurgical', description: 'Appendicectomie' },
      { description: 'Sans catégorie' }
    ]));
    assert.equal(items.length, 2);
    assert.equal(items[0].category, 'Chirurgical');
    assert.equal(items[0].label, 'Appendicectomie');
    assert.equal(items[1].category, 'Antécédent');
  });

  test('renvoie une liste vide pour une entrée vide', () => {
    assert.deepEqual(parseStatisticsAntecedents(''), []);
    assert.deepEqual(parseStatisticsAntecedents(null), []);
  });

  test('traite un texte libre non-JSON comme un antécédent unique', () => {
    const items = parseStatisticsAntecedents('Diabète');
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Diabète');
  });
});

describe('Séries', () => {
  test('buildStatisticsAnnualValuePoints agrège par année sur la plage', () => {
    const rows = [
      { d: '2022-05-01', v: 2 },
      { d: '2023-01-01', v: 3 },
      { d: '2023-06-01', v: 1 },
      { d: '2019-01-01', v: 9 } // hors plage
    ];
    const points = buildStatisticsAnnualValuePoints(rows, 2022, 2023, (r) => r.d, (r) => r.v);
    assert.deepEqual(points, [
      { label: '2022', value: 2 },
      { label: '2023', value: 4 }
    ]);
  });

  test('buildStatisticsConsultationEvolutionPoints par trimestre', () => {
    const rows = [
      { started_at: '2023-02-10' }, // T1
      { started_at: '2023-03-15' }, // T1
      { started_at: '2023-11-01' }  // T4
    ];
    const points = buildStatisticsConsultationEvolutionPoints(rows, 'quarter', 2023, 2023);
    const t1 = points.find((p) => p.label === 'T1 2023');
    const t4 = points.find((p) => p.label === 'T4 2023');
    assert.equal(t1.value, 2);
    assert.equal(t4.value, 1);
  });
});
