# Donnees et securite

## Chiffrement des champs au repos

Les donnees personnelles sensibles (nom complet, telephone, notes medicales,
sections de consultation, IBAN, etc.) sont chiffrees en base avec AES-256-GCM.

- Module : `server/lib/crypto.mjs`, fabrique `createFieldCrypto(getKey)`.
- Format d'un champ chiffre : `base64(iv[12] + authTag[16] + ciphertext)`.
- La cle est fournie par un getter `() => dataKey`, car `dataKey` peut etre
  reassignee au runtime (assistant de configuration).
- `restoreCipherField` est idempotent : il chiffre un texte en clair mais laisse
  intact un champ deja chiffre (utile a l'import et a la restauration).

La cle provient de `OSTEOSOFT_DATA_KEY` (base64). En developpement, une cle
derivee d'une valeur sentinelle est utilisee, refusee hors developpement.

## Journal d'audit inviolable

Module : `server/lib/audit.mjs`.

Chaque entree porte un HMAC-SHA256 sur ses champs IMMUABLES
(`action`, `entity`, `entity_id`, `created_at`) plus le hash de l'entree
precedente, signe avec la cle serveur. Toute alteration (edition d'une ligne,
suppression au milieu de la chaine) est detectable et infalsifiable sans la cle.
`user_id` et `metadata` sont volontairement exclus car mutes legitimement ensuite
(anonymisation, chiffrement retroactif). Le separateur des champs avant le HMAC
est l'octet NUL. `verifyAuditLogChain` recalcule la chaine et signale les liens
rompus.

## Cloisonnement par cabinet

Module : `server/lib/access.mjs`.

- `canUserAccessPatient(patientId, userAccess)` : un praticien accede a un patient
  s'il a une consultation ou un rendez-vous dans l'un de ses cabinets, ou si le
  cabinet d'inscription du patient est l'un des siens. Les patients sans aucun
  rattachement (donnees heritees) restent visibles de tous, pour compatibilite.
- Les droits sont portes par des profils (grilles de permissions par domaine) et
  le super-administrateur application. Le contexte d'acces est relu en base a
  chaque requete (pas depuis le JWT), pour qu'une retrogradation prenne effet
  immediatement.
- Middlewares : `requirePermission`, `requireAnyPermission`, `adminOnlyMiddleware`.

## Sauvegardes chiffrees et reprise apres sinistre

Modules : `server/lib/backup.mjs` (chiffrement d'archive) et routes dans
`index.mjs`.

- Export en clair (`GET /api/data-management/backup`) : archive ZIP
  (`manifest.json`, `data.json`, `meta.json`). Les PII y sont deja du ciphertext
  (sous la cle serveur) ; le reste est en clair.
- Export chiffre (`POST /api/data-management/backup/encrypted`) : ZIP chiffre par
  une phrase de passe (scrypt + AES-256-GCM), incluant `key.json` (la cle de
  donnees embarquee). L'archive `.osteobackup` est autoportante.
- Restauration chiffree (`POST /api/data-management/restore/encrypted`) :
  dechiffre avec la phrase de passe, verifie que la cle embarquee correspond a
  celle de l'instance (sinon 409 avec la marche a suivre), puis restaure.

Reprise apres sinistre : la cle de donnees etant incluse dans l'archive (protegee
par la phrase de passe), elle n'est jamais perdue. Sur une instance de secours,
demarrer avec `OSTEOSOFT_DATA_KEY` egale a la cle de la sauvegarde, puis restaurer
avec la phrase de passe. En cas de divergence de cle, la restauration refuse
proprement pour ne pas restaurer des PII illisibles.

## Regle : aucun appel sortant (et son unique exception)

L'application n'emet aucune requete vers un tiers : pas de telemetrie, pas de
police ni de script externe (la CSP `connect-src 'self'` le garantit cote
navigateur).

Seule exception, decidee explicitement : la verification des mises a jour
interroge l'API GitHub (releases du depot) depuis le serveur. Garde-fous :

- uniquement quand un administrateur ouvre l'application (cloche de
  notification) ou l'ecran Mises a jour : aucun appel de fond ni tache
  planifiee. Le serveur garde la reponse 6 heures par canal, donc au plus un
  appel toutes les 6 heures, sauf clic sur « Verifier maintenant » ;
- ne transmet que des metadonnees de version (URL du depot, et le jeton si le
  depot est prive) : aucune donnee patient ni de cabinet ;
- coupable par `UPDATE_CHECK=false` (plus aucun appel, bouton refuse) ; un test
  verifie qu'aucune requete ne part dans ce cas.

Voir exploitation.md, section « Mises a jour depuis l'interface ».

## Regle : aucune donnee reelle

Aucune donnee patient reelle dans le depot, les tests, les captures ou les
journaux de CI. Utiliser des donnees fictives (`npm run seed:fakename`). La CI
inclut un scan de secrets (gitleaks) qui fait echouer le build.
