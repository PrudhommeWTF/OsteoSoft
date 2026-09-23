# Tests

## Execution

- `npm run test:api` : suite API (node:test), fichiers `server/test/*.test.mjs`.
- `npm run typecheck` : verification de types checkJs (`server/lib/`).
- `npm run build` : build Angular (valide aussi les templates, ce que `tsc` seul
  ne fait pas).
- `npm run test:e2e` : tests end-to-end en navigateur reel (Playwright). Voir
  [tests-e2e.md](tests-e2e.md).

## Harnais

`server/test/helpers/harness.mjs` :

- `startTestServer(options)` : demarre une instance sur un port aleatoire, avec un
  repertoire de travail temporaire et une base SQLite jetable. Variables
  d'environnement de test fournies (dont `NODE_ENV=development`).
- `createClient(baseUrl)` : client HTTP avec bocal a cookies et gestion
  automatique du CSRF double-submit. Methodes `get`, `post`, `put`, `patch`,
  `del`, `getBinary`, `postBinary`, `login`.
- `setupCleanInstance(baseUrl)` : configuration initiale du cabinet + connexion
  admin, renvoie `{ client, officeId }`.
- Aides : `createOffice`, `createUser`, `downloadBackup`, `openTestDb`,
  `decryptField`.

Comme le harnais demarre un VRAI serveur, toute erreur d'ordre d'initialisation
des modules fait echouer l'ensemble de la suite : c'est le filet de securite des
extractions.

## Types de tests

- Unitaires purs : `*.unit.test.mjs` et modules purs (crypto, migrations,
  billing, patients, office-settings, statistics, agenda, backup, audit,
  invoice-numbering...).
- Integration et isolation : `cabinet-isolation`, `consultation-isolation`,
  `api-core`, `backup-restore`, `webosteo-import`.
- Fumee de bout en bout : `*.smoke.test.mjs` (statistiques, comptabilite, agenda,
  dossier patient), qui gardent les gros assemblages lies a la base.
- Metier : `billing-invoices` (numerotation, annulation), `livre-recettes`,
  `backup-encryption`.
- Script de deploiement : `self-update-script` execute le VRAI
  `deploy/lxc/self-update.sh` dans un bac a sable (faux `systemctl`, `curl` et
  `npm` places en tete du `PATH`, aucun acces reseau ni root) : mise a jour
  reussie, retour arriere (code ET base restaures), tag piege refuse, retour en
  arriere de version refuse, archive incoherente refusee, ligne malveillante du
  `.env` jamais executee.

## Regle de correction

Aucun bug n'est corrige sans un test qui echoue avant la correction et passe
apres. Les changements de contrat (par exemple la numerotation attribuee par le
serveur) s'accompagnent de la reecriture des tests concernes.

## Integration continue (`.github/workflows/ci.yml`)

Six jobs (Node 22) :

- `api-tests` : `npm run test:api`.
- `typecheck` : `npm run typecheck`.
- `e2e-scenarios` : `npm run e2e:scenarios` (parcours HTTP sans interface, voir
  [tests-e2e.md](tests-e2e.md)).
- `e2e` : installe Chromium puis `npm run test:e2e` (tests navigateur, voir
  [tests-e2e.md](tests-e2e.md)).
- `audit` : `npm audit --omit=dev --audit-level=critical` (bloquant), plus un
  audit complet informatif.
- `secrets` : scan gitleaks, bloquant.

Note : les workflows GitHub Actions ne se declenchent pas sur les poussees via le
proxy d'agent ; ils s'executent sur les poussees utilisateur et les pull requests.
