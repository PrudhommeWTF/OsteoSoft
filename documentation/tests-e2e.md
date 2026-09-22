# Tests end-to-end

Deux familles de tests de bout en bout coexistent :

- **Navigateur (Playwright)** : pilotent la vraie interface Angular dans Chromium
  contre le vrai backend. Voir ci-dessous.
- **Scenarios HTTP (sans interface)** : pilotent directement l'API pour des
  parcours multi-modules. Voir la section [Scenarios HTTP](#scenarios-http-sans-interface).

Les deux completent les tests d'API unitaires et d'integration
(`server/test/*.test.mjs`).

## Tests navigateur (Playwright)

Ces tests pilotent la vraie interface Angular dans un navigateur reel
(Chromium via Playwright), contre le vrai backend et une base SQLite.

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
- sur le port 4199 par defaut. Le build de production appelle l'API en relatif
  (`/api`), donc tout est servi sur une seule origine : pas de probleme CORS, et
  le port exact n'a pas d'importance.

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
  creation de patient, constantes comme le mot de passe admin de test).
- `e2e/NN-*.spec.ts` : les scenarios, un fichier par parcours.

## Ordre des scenarios

L'instance est partagee et unique pour toute l'execution : son etat evolue au
fil des scenarios (vierge, puis installee, puis peuplee). Playwright execute les
fichiers par ordre alphabetique, donc les scenarios sont prefixes d'un numero
pour rendre cet ordre explicite. Le scenario `01` teste l'instance vierge
(installation) et DOIT passer en premier ; les suivants utilisent le helper
`ensureLoggedIn` (qui installe le cabinet au besoin) et sont donc autonomes,
mais restent numerotes pour la lisibilite du cycle de vie.

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

- Installation initiale et connexion (`01-installation-login.spec.ts`) :
  assistant d'installation (creation du cabinet et du compte admin), connexion
  admin, refus d'un mot de passe errone, impossibilite de relancer l'installation
  une fois le cabinet cree.
- Creation patient et consultation (`02-patient-consultation.spec.ts`) : creation
  d'un patient via l'assistant (identite, date de naissance au calendrier,
  consentement), presence dans la liste, puis creation d'une consultation
  rattachee au dossier.
- Facturation et PDF (`03-billing-pdf.spec.ts`) : facturation d'une consultation
  depuis l'onglet Paiement (numero de facture attribue par le serveur), puis
  telechargement du PDF de la facture.
- Agenda et rendez-vous (`04-agenda.spec.ts`) : creation d'un rendez-vous prive
  depuis l'agenda, confirmation serveur, puis affichage dans la vue mensuelle.
- Integrite CSP (`05-csp-integrity.spec.ts`) : le frontend servi par l'API se
  charge sans violation CSP et avec sa feuille de style appliquee (garde-fou du
  bug "page blanche" en deploiement mono-service).

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
- La facturation se fait depuis l'onglet Paiement de la consultation ;
  `generateInvoice` sauvegarde d'abord la consultation en mode creation pour
  obtenir un identifiant. Le telechargement de la facture ouvre le PDF via
  `window.open` (nouvel onglet), a capturer avec `page.waitForEvent('popup')`,
  pas avec l'evenement `download`.
- Les boutons avec `bsTooltip` voient leur attribut `title` deplace vers
  `data-bs-original-title` par Bootstrap : un selecteur `[title="..."]` ne matche
  plus une fois l'infobulle initialisee. Cibler par le libelle visible.
- Le champ Motif du rendez-vous est facultatif (interface et serveur) : un
  rendez-vous peut etre cree sans motif. (Auparavant le serveur le refusait vide
  malgre le libelle "(facultatif)" ; corrige.)
- Deploiement mono-service + CSP stricte (`script-src 'self'`) : le build ne doit
  produire ni script/handler inline ni ressource tierce. L'inlining de CSS
  critique (Beasties) est desactive (il injectait un `onload` inline bloque par
  la CSP), et aucune police tierce n'est chargee (polices systeme). Le scenario
  05 garde ces invariants.

## Scenarios HTTP (sans interface)

En complement des tests navigateur, des scenarios pilotent directement l'API
pour des parcours complets multi-modules, sans navigateur (plus rapides). Ils
reprennent l'esprit des anciens scripts `e2e:backup` / `e2e:rights`, mais
reposent desormais sur le harnais de test (`server/test/helpers/harness.mjs`) :
instance reelle sur un port libre, base SQLite temporaire et isolee, jamais les
donnees de developpement. (Les anciennes versions demarraient le serveur dans le
repertoire courant, donc contre la base de developpement, et sur un port fixe :
elles ne fonctionnaient plus depuis l'ajout de la garde de securite au demarrage.)

Fichiers dans `server/scripts/` :

- `e2e-backup-restore.mjs` (`npm run e2e:backup`) : telechargement d'une
  sauvegarde, verification de l'absence de donnees en clair, restauration.
- `e2e-access-rights.mjs` (`npm run e2e:rights`) : controle d'acces par role
  (non authentifie, admin, cabinet-member, assistant, comptabilite).
- `e2e-clinical-flow.mjs` (`npm run e2e:clinical`) : parcours clinique et
  comptable (patient, consultation, facture avec numero serveur, livre des
  recettes, annulation).
- `e2e-lib.mjs` : petit utilitaire commun (trace lisible, compteur de
  verifications, code de sortie).

`npm run e2e:scenarios` enchaine les trois.

## Integration continue

Deux jobs dans `.github/workflows/ci.yml` :

- `e2e-scenarios` : `npm run e2e:scenarios` (parcours HTTP, pas de navigateur).
- `e2e` : installe Chromium (`npx playwright install --with-deps chromium`) puis
  lance `npm run test:e2e` (tests navigateur). En cas d'echec, le rapport HTML est
  publie en artefact.
