# Modules `server/lib/`

Chaque module a ete extrait de `server/index.mjs` sans changement de comportement,
avec des tests. Les routes HTTP restent dans `index.mjs`.

| Module | Role | Forme |
| --- | --- | --- |
| `crypto.mjs` | Chiffrement de champs au repos (AES-256-GCM) : `encryptSensitiveField`, `decryptSensitiveField`, `safeDecryptField`, `restoreCipherField`. | Fabrique `createFieldCrypto(getKey)` |
| `migrations.mjs` | Migrations de schema versionnees : `markBaselineIfEmpty`, `runMigrations`, `getAppliedVersions`. | Fonctions pures |
| `audit.mjs` | Journal d'audit inviolable (chaine HMAC) : `mapAuditLogRow`, et `writeAuditLog` / `writeAuthSecurityLog` / `verifyAuditLogChain`. | Pur + fabrique `createAuditLog(db, getKey)` |
| `access.mjs` | Modele de permissions et cloisonnement : catalogue des droits, grilles, `hasPermission`, `getAccessibleBillingOfficeIds`, et contexte d'acces, middlewares d'autorisation, `canUserAccessPatient`. | Pur + fabrique `createAccessControl(db, deps)` |
| `config.mjs` | Configuration serveur depuis l'environnement : `loadServerConfig`, `assertConfigUsable`, constantes de session. | Fonctions pures |
| `backup.mjs` | Sauvegarde/restauration : constantes de format, empreinte stable, filtrage par cabinet, chiffrement d'archive ; construction du snapshot et restauration. | Pur + fabrique `createBackupService(db, deps)` |
| `webosteo-import.mjs` | Import d'une base WebOsteo (.bck / .data) vers le schema OsteoSoft. | Pur + fabrique `createWebOsteoImport(db, deps)` |
| `billing.mjs` | Coeur facturation : identifiants d'operation, normalisation lignes/paiements, statut, numerotation des factures, detail/paiements. | Pur + fabrique `createBillingService(db, deps)` |
| `statistics.mjs` | Tableau de bord et agregations statistiques. | Pur + fabrique `createStatisticsService(db, deps)` |
| `accounting.mjs` | Comptabilite : registre des operations, livre de recettes micro-BNC. | Fabrique `createAccountingService(db, deps)` |
| `agenda.mjs` | Agenda : preferences, calendriers accessibles, creneaux et chevauchements. | Pur + fabrique `createAgendaService(db, deps)` |
| `patients.mjs` | Fonctions pures patients/consultations : profils, antecedents, motifs et sections, retention, type de consultation. | Fonctions pures |
| `patient-records.mjs` | Operations patients/consultations liees a la base : insertion de consultation, remplacement des antecedents/motifs/sections, cartes dechiffrees, notes, retention effective, purge des dossiers expires. | Fabrique `createPatientRecords(db, deps)` |
| `office-settings.mjs` | Parametres cabinet (fonctions pures) : horaires, devise, formats et numerotation de facture, modele de facture, methodes de paiement, identifiants de cabinet. | Fonctions pures |
| `releases.mjs` | (Nouveau) Releases GitHub : `fetchRelease` par canal (stable / preversions, repli sur les tags), `semverCmp` (preversions comprises), `normalizeUpdateChannel`. Fetch et base d'API injectables. | Fonctions pures |
| `self-update.mjs` | (Nouveau) Mise a jour en un clic : `isValidReleaseTag` (frontiere de privilege), `selfUpdateCapability` (script root constate), `freshUpdateStatus` / `readUpdateStatus` (statut perime), `writeUpdateTrigger`. | Fonctions (acces disque) |

## Convention d'injection

Les fabriques recoivent en dependances ce qui est defini ailleurs (chiffrement,
journal d'audit, aides transverses) et qui doit rester unique. Cela evite la
duplication et rend les dependances explicites. Voir architecture.md pour l'ordre
d'instanciation impose par ces injections.
