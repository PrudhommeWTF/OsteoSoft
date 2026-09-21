// Migrations de schéma versionnées.
//
// Cadre posé en Priorité 2 (choix incrémental) : le schéma actuel est adopté
// comme socle (migration 1) via markBaselineIfEmpty ; les évolutions futures
// passent par runMigrations, qui applique dans l'ordre, trace chaque migration
// dans schema_migrations, et ARRÊTE le démarrage en cas d'échec (contrairement
// aux migrations ad hoc historiques qui n'émettaient qu'un avertissement).
//
// db est typé de façon lâche (any) : la bibliothèque better-sqlite3 n'expose pas
// de types, on évite ainsi de dépendre de @types/better-sqlite3 juste pour ce module.

/** @typedef {any} Db */
/** @typedef {{ version: number, name: string, up: (db: Db) => void }} Migration */

/** @param {Db} db */
export function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * @param {Db} db
 * @returns {Set<number>}
 */
export function getAppliedVersions(db) {
  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((/** @type {{ version: number }} */ r) => Number(r.version)));
}

/**
 * Adopte un schéma préexistant comme migration socle : enregistre la version
 * donnée UNIQUEMENT si aucune migration n'a encore été tracée. Ne joue aucun SQL
 * de schéma (le schéma est supposé déjà en place). Renvoie true si le socle a
 * été enregistré.
 *
 * @param {Db} db
 * @param {number} version
 * @param {string} name
 * @returns {boolean}
 */
export function markBaselineIfEmpty(db, version, name) {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  if (Number(row.n) === 0) {
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
    return true;
  }
  return false;
}

/**
 * Applique, dans l'ordre croissant de version, les migrations non encore jouées.
 * Chaque migration s'exécute dans sa propre transaction (tout ou rien) et est
 * enregistrée dans schema_migrations. En cas d'échec, l'erreur est propagée pour
 * que le démarrage s'arrête plutôt que de continuer sur une base incohérente.
 *
 * @param {Db} db
 * @param {Migration[]} migrations
 * @param {{ log?: (message: string) => void }} [options]
 */
export function runMigrations(db, migrations, options = {}) {
  ensureMigrationsTable(db);
  const applied = getAppliedVersions(db);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    });

    try {
      apply();
      options.log?.(`✓ Migration ${migration.version} appliquee: ${migration.name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Echec de la migration ${migration.version} (${migration.name}): ${detail}`);
    }
  }
}
