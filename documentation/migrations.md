# Migrations de schema versionnees

Module : `server/lib/migrations.mjs`. Mise en place en Priorite 2 (approche
incrementale).

## Principe

- Le schema cree au demarrage (via `db.exec` dans `index.mjs`) est adopte comme
  SOCLE (migration 1) par `markBaselineIfEmpty(db, 1, ...)`, uniquement si aucune
  migration n'a encore ete tracee (base neuve ou existante non encore versionnee).
- Les evolutions s'ajoutent au tableau `VERSIONED_MIGRATIONS` dans `index.mjs` et
  sont appliquees par `runMigrations(db, VERSIONED_MIGRATIONS, ...)`.
- Une table `schema_migrations (version, name, applied_at)` trace les migrations
  appliquees.

## Garanties

- Application dans l'ordre croissant de version.
- Chaque migration s'execute dans sa propre transaction (tout ou rien).
- Une migration deja appliquee n'est pas rejouee.
- En cas d'echec, l'erreur est propagee : le demarrage S'ARRETE plutot que de
  continuer sur une base incoherente (contrairement aux migrations ad hoc
  historiques, qui n'emettaient qu'un avertissement).

## Ajouter une migration

Ajouter un objet au tableau `VERSIONED_MIGRATIONS` :

```js
{
  version: 3,
  name: 'description-courte',
  up: (database) => {
    database.exec('ALTER TABLE ... ');
    // toute logique d'amorce en JS est possible ici
  }
}
```

Regles :
- Numeroter a la suite (la version 2 existe deja : table de numerotation des
  factures, amorcee depuis les factures existantes).
- La creation de table doit rester idempotente (`CREATE TABLE IF NOT EXISTS`),
  car le schema de base la cree aussi pour les nouvelles installations.
- Toujours documenter, dans la PR, l'impact sur une base existante et la
  procedure de retour arriere (par exemple `DROP TABLE ...` et suppression de la
  ligne correspondante dans `schema_migrations`).

## Migrations ad hoc historiques

Des migrations ad hoc anterieures subsistent dans `index.mjs` (renommages,
`ensureColumn`, etc.). Leur conversion progressive vers le systeme versionne se
fera par etapes.
