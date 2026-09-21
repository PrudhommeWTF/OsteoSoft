# Architecture

## Pile technique

- Backend : Node avec Express 5, un point d'entree `server/index.mjs`, en modules
  ES (`.mjs`). Base de donnees SQLite via better-sqlite3 (synchrone).
- Authentification : JWT (cookie de session), Argon2 pour les mots de passe,
  helmet, express-rate-limit, protection CSRF double-submit, validation Zod.
- Frontend : Angular 21, Bootstrap 5, Chart.js, PDF cote client (jspdf). Code
  dans `src/`.
- Chiffrement de champs au repos : AES-256-GCM (voir donnees-securite.md).

## Le serveur : un monolithe en cours de decoupage

Historiquement toute la logique serveur vivait dans `server/index.mjs` (environ
19 500 lignes). Le fichier a ete allege par extractions successives vers
`server/lib/` (voir modules.md). `index.mjs` conserve la creation du schema, la
configuration des intergiciels, et surtout les ROUTES HTTP : les routes n'ont pas
ete deplacees, elles appellent les primitives extraites.

## Deux patrons d'extraction

Chaque module suit l'un de ces deux patrons, choisis selon la dependance a la base.

1. Fonctions PURES exportees directement. Sans dependance a la base ni au
   chiffrement (normalisation, calculs, transformations). Importees telles quelles
   dans `index.mjs`. Etant des imports, elles sont hoistees : aucune contrainte
   d'ordre d'initialisation.

2. Fabrique `createXxx(db, deps)`. Pour ce qui depend de la base et de
   collaborateurs. La fabrique ferme sur `db` et sur des dependances injectees,
   et renvoie un objet de fonctions. Dans `index.mjs`, on destructure ce retour,
   ce qui garde tous les sites d'appel identiques.

   ```js
   const { getInvoiceDetail, appendInvoicePayment /* ... */ } =
     createBillingService(db, { encryptSensitiveField, decryptSensitiveField, /* ... */ });
   ```

### Getter pour la cle mutable

La cle de chiffrement `dataKey` peut etre reassignee au runtime (assistant de
configuration initiale). Les fabriques qui en ont besoin recoivent un getter
`() => dataKey`, jamais la valeur, afin de toujours lire la cle courante.

## Ordre d'initialisation (important)

Quand une fonction devient une constante issue d'une fabrique, elle n'est plus
hoistee : elle doit etre definie avant d'etre utilisee au chargement du module.
La plupart des consommateurs sont des corps de route (executes a la requete), donc
insensibles a l'ordre. Mais certaines fabriques recoivent en injection des
fonctions issues d'autres fabriques, ce qui impose un ordre d'instanciation :

```
crypto -> audit -> access -> ... -> agenda -> patient-records -> facturation ->
comptabilite -> statistiques
```

Par exemple, la comptabilite (`getBillingOperationsData`) est injectee dans les
statistiques : elle doit donc etre instanciee avant. De meme, patient-records est
instancie apres l'agenda (dont il utilise le calendrier par defaut et la detection
de chevauchement) et avant l'import WebOsteo et les statistiques (qui recoivent
plusieurs de ses primitives).

Filet de securite : le harnais de test demarre un vrai serveur. Toute erreur
d'ordre d'initialisation fait echouer immediatement l'ensemble de la suite.

## Typage sans compilation (checkJs)

Le code reste en `.mjs` (aucune etape de build serveur, aucun changement de
deploiement). Un `server/tsconfig.json` active `checkJs` en mode strict, sans
emission, cible sur `server/lib/`. `npm run typecheck` verifie les types via des
annotations JSDoc. `db` est type de facon lache (`any`) car better-sqlite3
n'expose pas de types.
