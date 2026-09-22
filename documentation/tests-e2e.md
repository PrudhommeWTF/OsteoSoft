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

Parcours prevus (PR suivante) : extension des scripts HTTP (scenarios sans
interface).

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
- Le champ Motif du rendez-vous est affiche "(facultatif)" mais le serveur le
  refuse vide (schema `reason` >= 1). A signaler cote produit ; en attendant, les
  scenarios le renseignent.

## Integration continue

Le job `e2e` de `.github/workflows/ci.yml` installe Chromium
(`npx playwright install --with-deps chromium`), puis lance `npm run test:e2e`.
En cas d'echec, le rapport HTML est publie en artefact.
