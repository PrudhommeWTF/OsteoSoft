// Migrations versionnées : exécuteur (unitaire, base en mémoire) et intégration
// (le socle est bien enregistré au démarrage du serveur).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, markBaselineIfEmpty, getAppliedVersions } from '../lib/migrations.mjs';
import { startTestServer, openTestDb } from './helpers/harness.mjs';

describe('Exécuteur de migrations (unitaire)', () => {
  test('applique les migrations dans l ordre de version et les trace', () => {
    const db = new Database(':memory:');
    const ordreApplique = [];
    runMigrations(db, [
      { version: 2, name: 'deux', up: () => ordreApplique.push(2) },
      { version: 1, name: 'un', up: () => ordreApplique.push(1) }
    ]);
    assert.deepEqual(ordreApplique, [1, 2], 'ordre croissant respecté');
    assert.deepEqual([...getAppliedVersions(db)].sort(), [1, 2]);
    db.close();
  });

  test('ne rejoue pas une migration déjà appliquée', () => {
    const db = new Database(':memory:');
    let compte = 0;
    const migs = [{ version: 1, name: 'un', up: () => { compte += 1; } }];
    runMigrations(db, migs);
    runMigrations(db, migs);
    assert.equal(compte, 1, 'la migration n est jouée qu une fois');
    db.close();
  });

  test('s arrête en cas d échec et ne trace pas la migration en échec (fail-fast)', () => {
    const db = new Database(':memory:');
    assert.throws(() => runMigrations(db, [
      { version: 1, name: 'ok', up: () => {} },
      { version: 2, name: 'ko', up: () => { throw new Error('boom'); } },
      { version: 3, name: 'jamais', up: () => { throw new Error('ne doit pas être atteinte'); } }
    ]));
    const applied = getAppliedVersions(db);
    assert.ok(applied.has(1), 'la migration 1 réussie est tracée');
    assert.ok(!applied.has(2), 'la migration 2 en échec n est pas tracée');
    assert.ok(!applied.has(3), 'la migration 3 après l échec n est pas jouée');
    db.close();
  });

  test('markBaselineIfEmpty n enregistre le socle que si la table est vide', () => {
    const db = new Database(':memory:');
    assert.equal(markBaselineIfEmpty(db, 1, 'socle'), true, 'enregistré la première fois');
    assert.equal(markBaselineIfEmpty(db, 1, 'socle'), false, 'non ré-enregistré ensuite');
    assert.deepEqual([...getAppliedVersions(db)], [1]);
    db.close();
  });
});

describe('Migrations au démarrage (intégration)', () => {
  let server;
  before(async () => { server = await startTestServer(); });
  after(async () => { await server?.stop(); });

  test('le socle est enregistré dans schema_migrations au démarrage', () => {
    const db = openTestDb(server);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    db.close();
    assert.ok(rows.some((r) => Number(r.version) === 1), 'la migration socle (1) doit être tracée');
  });
});
