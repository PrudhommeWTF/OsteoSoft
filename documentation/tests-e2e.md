# Tests end-to-end (navigateur)

Ces tests pilotent la vraie interface Angular dans un navigateur reel
(Chromium via Playwright), contre le vrai backend et une base SQLite. Ils
completent les tests d'API (`server/test/*.test.mjs`), qui verifient les
endpoints sans interface.

## Execution

- `npm run test:e2e` : compile le frontend (`npm run build`) puis lance les
  scenarios Playwright.
- `npm run test:e2e:ui` : mode interactif (inspecteur Playwright), utile pour
  ecrire ou deboguer un scenario. Le frontend doit deja etre compile.

Prerequis : le navigateur Playwright doit etre installe. En local, une fois :
`npx playwright install chromium`. En CI, le job le fait automatiquement.

## Architecture

Un lanceur, `e2e/serve-for-e2e.mjs`, demarre une instance reelle de
`server/index.mjs` :

- contre une base SQLite TEMPORAIRE et isolee (repertoire de travail jetable,
  supprime a l'arret), donc jamais les donnees de developpement ;
- avec le frontend compile servi par cette meme instance
  (`OSTEOSOFT_STATIC_DIR` pointe sur `dist/OsteoSoft/browser`) ;
- sur le port 4199 (fixe), car le frontend compile appelle l'API sur ce port.
  Tout est donc servi sur une seule origine : pas de probleme CORS.

Cette approche reprend celle du harnais des tests d'API
(`server/test/helpers/harness.mjs`) : aucune modification du code applicatif
n'est necessaire, le serveur resolvant son dossier de donnees depuis
`process.cwd()`.

Playwright (`playwright.config.ts`) demarre ce lanceur via `webServer`, attend
que le port reponde, puis execute les scenarios en serie (`workers: 1`) sur une
instance partagee : l'installation initiale amorce le cabinet, puis les
scenarios suivants reutilisent cette instance, comme un cabinet dans le temps.

## Organisation

- `playwright.config.ts` : configuration (repertoire `e2e/`, serveur, port).
- `e2e/serve-for-e2e.mjs` : lanceur du serveur isole.
- `e2e/helpers/app.ts` : helpers reutilisables (installation, connexion,
  constantes comme le mot de passe admin de test).
- `e2e/*.spec.ts` : les scenarios, un fichier par parcours.

Les fichiers `e2e/` sont hors du perimetre des tsconfig Angular
(`tsconfig.app.json` n'inclut que `src/`), ils ne perturbent donc ni le build
ni les tests unitaires.

## Selecteurs

Il n'y a pas d'attribut `data-testid` dans les templates. Les scenarios
s'appuient sur les `id` existants (`#username`, `#password`, `#setup-name`...),
les roles ARIA et le texte visible des boutons (en francais). Si un parcours
devient difficile a cibler de facon stable, ajouter un `data-testid` cible dans
le template concerne est preferable a un selecteur fragile.

## Donnees

Aucune donnee patient reelle : les scenarios saisissent des donnees fictives.
Le mot de passe admin de test (`e2e/helpers/app.ts`) est une valeur de test,
sans lien avec un compte reel.

## Parcours couverts

- Installation initiale et connexion (`installation-login.spec.ts`) : assistant
  d'installation (creation du cabinet et du compte admin), connexion admin,
  refus d'un mot de passe errone, impossibilite de relancer l'installation une
  fois le cabinet cree.
- Creation patient et consultation (`patient-consultation.spec.ts`) : creation
  d'un patient via l'assistant (identite, date de naissance au calendrier,
  consentement), presence dans la liste, puis creation d'une consultation
  rattachee au dossier.

Parcours prevus (PR suivantes) : facturation et PDF, agenda et rendez-vous.

## Pieges rencontres (a garder en tete)

- `getByRole('button', { name: 'Suivant' })` filtre par sous-chaine et sans
  tenir compte de la casse : il attrape aussi les libelles contenant "suivante"
  (infobulles "Passer a l'etape suivante"). Utiliser `exact: true` ou un
  selecteur CSS cible.
- L'assistant patient garde toutes les etapes dans le DOM et rafraichit
  l'indicateur de brouillon chaque seconde. Apres chaque "Suivant", on attend
  l'entete de l'etape suivante pour se synchroniser avec le rendu.
- Le selecteur de date est un composant maison (calendrier, pas de saisie
  texte) : on ouvre le panneau, on recule de quelques mois, on choisit un jour,
  on valide.
- Certains libelles de boutons different selon le mode : en creation de
  consultation, le bouton est "Creer la consultation" (et non "Enregistrer et
  fermer", qui n'existe qu'en edition).
- La barre laterale et l'entete ont aussi un champ de recherche patient : cibler
  celui de la liste par sa classe (`input.pat-search-input`).

## Integration continue

Le job `e2e` de `.github/workflows/ci.yml` installe Chromium
(`npx playwright install --with-deps chromium`), puis lance `npm run test:e2e`.
En cas d'echec, le rapport HTML est publie en artefact.
