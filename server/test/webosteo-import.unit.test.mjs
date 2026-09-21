// Import WebOsteo (server/lib/webosteo-import.mjs) : fonctions pures de conversion
// des formats WebOsteo. L'import complet lié à la base est couvert par le test
// d'intégration webosteo-import.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeoDate, parseWeoDateTime, mapMaritalStatus, mapSex } from '../lib/webosteo-import.mjs';

describe('Conversion des dates WebOsteo', () => {
  test('parseWeoDate convertit YYYYMMDD en YYYY-MM-DD', () => {
    assert.equal(parseWeoDate('20240115'), '2024-01-15');
  });

  test('parseWeoDate renvoie null pour une entrée invalide', () => {
    assert.equal(parseWeoDate('2024'), null);
    assert.equal(parseWeoDate('abcdefgh'), null);
    assert.equal(parseWeoDate(''), null);
    assert.equal(parseWeoDate(null), null);
  });

  test('parseWeoDateTime convertit YYYYMMDDHHmm en ISO UTC', () => {
    assert.equal(parseWeoDateTime('202401151430'), '2024-01-15T14:30:00.000Z');
  });

  test('parseWeoDateTime applique une heure par défaut à une date seule', () => {
    assert.equal(parseWeoDateTime('20240115'), '2024-01-15T08:00:00.000Z');
  });

  test('parseWeoDateTime renvoie null pour une entrée invalide', () => {
    assert.equal(parseWeoDateTime('2024'), null);
    assert.equal(parseWeoDateTime(''), null);
  });
});

describe('Traduction des vocabulaires WebOsteo', () => {
  test('mapMaritalStatus couvre les codes connus et leurs variantes', () => {
    assert.equal(mapMaritalStatus('c'), 'Celibataire');
    assert.equal(mapMaritalStatus('celibataire'), 'Celibataire');
    assert.equal(mapMaritalStatus('M'), 'Marie(e)');
    assert.equal(mapMaritalStatus('pacse'), 'Pacse(e)');
    assert.equal(mapMaritalStatus('div'), 'Divorce(e)');
    assert.equal(mapMaritalStatus('veuve'), 'Veuf(ve)');
  });

  test('mapMaritalStatus retombe sur Non renseigne si inconnu', () => {
    assert.equal(mapMaritalStatus('xyz'), 'Non renseigne');
    assert.equal(mapMaritalStatus(''), 'Non renseigne');
    assert.equal(mapMaritalStatus(null), 'Non renseigne');
  });

  test('mapSex reconnaît F et M, insensible à la casse', () => {
    assert.equal(mapSex('F'), 'F');
    assert.equal(mapSex('f'), 'F');
    assert.equal(mapSex('m'), 'M');
    assert.equal(mapSex('autre'), 'Non renseigne');
    assert.equal(mapSex(null), 'Non renseigne');
  });
});
