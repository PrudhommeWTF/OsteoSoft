# Documentation interne OsteoSoft

Cette documentation decrit l'architecture interne du logiciel, pour la maintenance
et l'evolution. Elle s'adresse a qui touche au code.

Ne pas confondre avec `docs/` a la racine, qui est la vitrine publique (GitHub
Pages) et n'a pas vocation a documenter l'implementation.

## Principes

- Interface et documents en francais.
- Pas de tiret long dans les textes produits (virgules, parentheses, deux-points).
- Aucune donnee patient reelle dans le depot, les tests, les captures ou les
  journaux de CI (donnees fictives, `npm run seed:fakename`).
- Livraison par petites PR, une par domaine, chacune deployable et reversible.
- Avant tout changement de schema, de chiffrement ou d'authentification :
  expliquer l'impact sur une base existante et la procedure de retour arriere.
- Aucun bug n'est considere corrige sans un test qui echoue avant et passe apres.

## Sommaire

- [architecture.md](architecture.md) : vue d'ensemble, pile technique, decoupage
  du serveur, patrons de conception, ordre d'initialisation.
- [modules.md](modules.md) : reference des modules `server/lib/`.
- [donnees-securite.md](donnees-securite.md) : chiffrement au repos, journal
  d'audit inviolable, cloisonnement par cabinet, sauvegardes chiffrees, reprise
  apres sinistre.
- [facturation-comptabilite.md](facturation-comptabilite.md) : numerotation et
  immutabilite des factures, livre de recettes micro-BNC.
- [migrations.md](migrations.md) : migrations de schema versionnees.
- [tests.md](tests.md) : harnais de test, execution, couverture, integration
  continue.
- [exploitation.md](exploitation.md) : variables d'environnement, deploiement,
  sauvegarde/restauration, procedures de retour arriere.

## Etat en bref (version 0.3.0)

- Backend Node/Express 5, `server/index.mjs`, plus 14 modules extraits dans
  `server/lib/`.
- Frontend Angular 21 dans `src/`.
- Base SQLite via better-sqlite3, chiffrement de champs au repos (AES-256-GCM).
- Suite de tests API (node:test) et verification de types (checkJs) en CI.
