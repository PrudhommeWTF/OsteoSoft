# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 0.1.0 (2026-05-15)


### Nouvelles fonctionnalités

* add backup reminder frequency setting and overdue modal on home page ([e935691](https://github.com/PrudhommeWTF/OsteoSoft/commit/e935691e4ef94bf5e0d29a48476847bb36c8754e))
* add encryption key generation step to setup wizard ([159c96a](https://github.com/PrudhommeWTF/OsteoSoft/commit/159c96a27e20df2397daac9032bc4c721b67e3fd))
* add GDPR consent form PDF download to patient create and detail pages ([8915885](https://github.com/PrudhommeWTF/OsteoSoft/commit/89158852f2f4839f08fcc136bf82ed37da0a774e))
* add skeleton drawing canvas to consultation schema section ([fd2df05](https://github.com/PrudhommeWTF/OsteoSoft/commit/fd2df05688a88e7e93dae00d32fc6b5765c8aa1a))
* add WebOsteo data import endpoint and UI ([faf17f3](https://github.com/PrudhommeWTF/OsteoSoft/commit/faf17f3d9d8403d076611d80847eee5e7e96dc17))
* affiche la date de dernière sauvegarde et retire la section 'Prochaine étape' de Gestion des données ([b62e919](https://github.com/PrudhommeWTF/OsteoSoft/commit/b62e919947b98e2a4760bf9f024c5a7803adcab8))
* always display related patient picker in patient-create step 1 ([7ea6128](https://github.com/PrudhommeWTF/OsteoSoft/commit/7ea6128dab3a89fb36829135369cfcb924ef6072))
* automatic GDPR data retention enforcement ([#9](https://github.com/PrudhommeWTF/OsteoSoft/issues/9)) ([abe5e83](https://github.com/PrudhommeWTF/OsteoSoft/commit/abe5e83d6506db33899d0fd4ea7abecdee73cf4d))
* CoreUI-style date picker component (jours circulaires, today border, footer Aujourd'hui/Effacer) ([6e855a2](https://github.com/PrudhommeWTF/OsteoSoft/commit/6e855a22bcfb0e29010999f381f66d1d84e79418))
* create PdfBuilderService and refactor PDF generation across all pages ([8219797](https://github.com/PrudhommeWTF/OsteoSoft/commit/82197979f89d1c78568b9ee61336ed0b7ca79e5b))
* déplace le schéma en dernier dans les formulaires de consultation et corrige le dessin canvas ([08ff039](https://github.com/PrudhommeWTF/OsteoSoft/commit/08ff039b8d410c83324c05bbf5b5ab6a1f2a9810))
* embed original JPEG skeletons as base64 in SVG wrappers for HiDPI scaling ([9d2200c](https://github.com/PrudhommeWTF/OsteoSoft/commit/9d2200c8272b8f0da5fd9c2e388d419026547d57))
* **home:** ajouter une pagination dynamique des impayés et un graphique patients empilé ([8a0fe45](https://github.com/PrudhommeWTF/OsteoSoft/commit/8a0fe45b946017738a19b37b3ab1194e4965da03))
* identifiants légaux cabinet + centre d'aide + favicon ([8414aee](https://github.com/PrudhommeWTF/OsteoSoft/commit/8414aeeb973fb1a0aaf5060a9fa580c1a2b5261c))
* implement all DB schema improvements identified in analysis ([3ced12d](https://github.com/PrudhommeWTF/OsteoSoft/commit/3ced12d13e41b698d11f50710d871500d9b2d3fa))
* implement invoice template customization (permissions, extended model, PDF generation, builder UI, billing tab) ([91e808a](https://github.com/PrudhommeWTF/OsteoSoft/commit/91e808a5c0c2c151412a4ab4d6acbe6c08d5d1b6))
* improve demo data generation with varied consultations, invoice_payments, bank deposits, better family links and invoice status distribution ([0348616](https://github.com/PrudhommeWTF/OsteoSoft/commit/0348616be4b9d3d94a94b264dbb549dfe513c689))
* improve GDPR patient consent mechanism (Articles 6 and 7) ([0a8f44d](https://github.com/PrudhommeWTF/OsteoSoft/commit/0a8f44d7501faab450a984f3b1a0e866a0085fe7))
* remove dead invoice PDF template builder code ([c174091](https://github.com/PrudhommeWTF/OsteoSoft/commit/c174091c59207cb3bbb7c102a6edd6e99f481811))
* replace JPEG skeleton images with modern SVG vector diagrams ([5f45e17](https://github.com/PrudhommeWTF/OsteoSoft/commit/5f45e17af5e63ced559257891c20c36970234186))
* replace jQuery bootstrap-datepicker with native type=date for birth dates; fix weight comma support ([f647da8](https://github.com/PrudhommeWTF/OsteoSoft/commit/f647da80f3bf5797b84aba22190d09189795f048))
* require explicit GDPR consent checkbox in patient creation wizard ([a2e6d01](https://github.com/PrudhommeWTF/OsteoSoft/commit/a2e6d01222717e0197dffb3ca9c93d1d74c48cdf))
* restrict patient visibility to practitioner's accessible offices ([60dd0a5](https://github.com/PrudhommeWTF/OsteoSoft/commit/60dd0a53fa527dd71039e8f5bd780154989f5189))
* **SEC-3:** encrypt invoice_payments.bank_name and accounting_deposits.bank_name at rest ([c5b9c1d](https://github.com/PrudhommeWTF/OsteoSoft/commit/c5b9c1d7f288bfd0c82d58c4d7673ada0903ac83))
* **settings:** ajouter le nettoyage groupé des données et tracer les modifications en audit logs ([2b21c10](https://github.com/PrudhommeWTF/OsteoSoft/commit/2b21c1003d706b187d0c4c9610e2dda9295d33d8))
* **settings:** gestion des données déléguée aux super administrateurs cabinet avec scope cabinet ([27015ca](https://github.com/PrudhommeWTF/OsteoSoft/commit/27015caf2e07da0234f18904cb340747f47963d4))
* système RBAC complet — contrôles d'accès, guards de navigation, délégations et tests e2e ([6b68402](https://github.com/PrudhommeWTF/OsteoSoft/commit/6b6840210e1199bd79f7c08d591be8987cd66cd6))
* **ui:** ajouter des tooltips Bootstrap sur tous les boutons de l'application ([fdcb92a](https://github.com/PrudhommeWTF/OsteoSoft/commit/fdcb92ac5b45d7a571bff3415f7c1f0b68ed43b0))
* versioning with changelog - standard-version, /api/changelog, changelog modal ([760fcc7](https://github.com/PrudhommeWTF/OsteoSoft/commit/760fcc73ccb39fbc79ab5ced5cc531aabd5a7e38))


### Performances

* add idx_users_is_active index for resolveUserIdFromPractitionerText lookup ([6b45dbd](https://github.com/PrudhommeWTF/OsteoSoft/commit/6b45dbd2df21d6befc7fc0b79a5f094886e5f708))


### Corrections de bugs

* add autocomplete=bday to birth date native inputs ([38d8b02](https://github.com/PrudhommeWTF/OsteoSoft/commit/38d8b02e570bffb4a40564537360ca44b3b396fd))
* add documentType to patient_documents, show courriers sortants in consultation modal ([5b4450a](https://github.com/PrudhommeWTF/OsteoSoft/commit/5b4450a0c7cb56b172dd522de2e54db1fb20599e))
* add rate limiter to PATCH invoice-template endpoint, fix error message typo ([2d534f7](https://github.com/PrudhommeWTF/OsteoSoft/commit/2d534f7453b6115b1a190ce54ae9359e4af2ff99))
* add rate limiting to /api/config and /api/changelog public endpoints ([147081c](https://github.com/PrudhommeWTF/OsteoSoft/commit/147081c6e5d8aaf08c0469641519552dfbad6140))
* address code review - rate limiting on import-template, optimize column count calc ([473d04e](https://github.com/PrudhommeWTF/OsteoSoft/commit/473d04ea5c4e5fc875cc8fd2eaa62402e3bdb384))
* address code review - remove redundant String() coercions, handle empty comment in template ([0bb21af](https://github.com/PrudhommeWTF/OsteoSoft/commit/0bb21af04e50bbdb58b966c69d595dda3043a022))
* address code review feedback - clean up non-null assertions and redundant casts ([73b8eb2](https://github.com/PrudhommeWTF/OsteoSoft/commit/73b8eb2e1e3ac064aa52b721fd2301e3c9e055bd))
* address code review findings (SQL LIMIT 1, rename activity_count, reject null office invoice) ([49ef776](https://github.com/PrudhommeWTF/OsteoSoft/commit/49ef776b63cf6638ea4d05c017e644ec36f19a8c))
* address code review issues - invoice numbering collision, impayee payment method, cheque number uniqueness ([0b789b1](https://github.com/PrudhommeWTF/OsteoSoft/commit/0b789b1f8d838739e3151abd674f437f2c9ef9ef))
* align client-side checksum normalization with server key-sorted hash ([9eb43f9](https://github.com/PrudhommeWTF/OsteoSoft/commit/9eb43f9d734a9ac2335767b39d47dd229390fb5a))
* close Promise.all arrays and fix office/fileName references in billing PDF download methods ([a755e9d](https://github.com/PrudhommeWTF/OsteoSoft/commit/a755e9d7b4c73d2261c04cd1a54d1e045d602809))
* enrich related patients with real data to fix age showing as unknown ([0e64522](https://github.com/PrudhommeWTF/OsteoSoft/commit/0e64522e8dca3ff125562232e3cabef6b47b98c3))
* fallback invoice office_id to user's first accessible office when requestedOfficeId is null ([2532853](https://github.com/PrudhommeWTF/OsteoSoft/commit/2532853f4c4585f1fa3d921c5db4bf4a3caada95))
* **import:** add idempotency for consultations/appointments and fix French decimal separator ([9f70ea4](https://github.com/PrudhommeWTF/OsteoSoft/commit/9f70ea4ceb9bc318d8ea233d0b469dfa9d1d49aa))
* **import:** update last_visit after consultation import and read eva_after from WebOsteo ([a98d99c](https://github.com/PrudhommeWTF/OsteoSoft/commit/a98d99ca54b0b2257d76da5b2b5f4d6242d8e501))
* improve backup modal for no-backup-ever case and add rate limiting to backup endpoint ([ae21d2b](https://github.com/PrudhommeWTF/OsteoSoft/commit/ae21d2b4c53eca61af4733b296f59afa05854824))
* improve HTML stripping for consultation title derived from motif ([959b8a7](https://github.com/PrudhommeWTF/OsteoSoft/commit/959b8a7d3ea0efa3f37d48e9412f14a623ecc09b))
* improve Webosteo import to recover consultation content, patient data and payments ([15c3e5b](https://github.com/PrudhommeWTF/OsteoSoft/commit/15c3e5b96a00b7f72b9853a5329b7684ddadcd92))
* increase API_LARGE_BODY_LIMIT default to 200mb and add frontend file size check ([13ba9ce](https://github.com/PrudhommeWTF/OsteoSoft/commit/13ba9ceb42328a4fc9fce08fcc46c2a6ffd9ad15))
* letters composed during consultation creation are now saved correctly ([5016e23](https://github.com/PrudhommeWTF/OsteoSoft/commit/5016e23c8ea4ab005d1ea0c68e4c06b2b08e9a52))
* move user_id indexes to after ensureColumn migrations to fix SqliteError on existing DBs ([679240f](https://github.com/PrudhommeWTF/OsteoSoft/commit/679240f346fb4190190c9ef1eb8aac2e4b15e274))
* populate empty webosteo.data and show specific server error on import failure ([df06728](https://github.com/PrudhommeWTF/OsteoSoft/commit/df06728d9105a67c7d3fccbdc91e8c27c4b1f6de))
* regenerate package-lock.json with consistent Angular 21.2.11 versions ([b6a968e](https://github.com/PrudhommeWTF/OsteoSoft/commit/b6a968ec09c8942da4f37a090166b401d72cb75c))
* remove unused drawSignatureBox helper from patient-create consent PDF builder ([902f460](https://github.com/PrudhommeWTF/OsteoSoft/commit/902f460d9d960e060792ef1ae83c1599ccdac100))
* remove version from public /api/config and stats from /api/setup/status endpoints ([96c48db](https://github.com/PrudhommeWTF/OsteoSoft/commit/96c48db2a0ed6a0ae5ba2fc830798bfa4a3ee844))
* replace xlsx with exceljs, add ip-address override, fix transitive vulns ([cc4292d](https://github.com/PrudhommeWTF/OsteoSoft/commit/cc4292d35a5dc2896e3abb4ae1633db36a0d78a1))
* resolve TypeScript build errors for invoice template feature ([9cabf7c](https://github.com/PrudhommeWTF/OsteoSoft/commit/9cabf7c9553088245aa085231384360ecf842250))
* **rgpd:** anonymisation patient complete (issue [#13](https://github.com/PrudhommeWTF/OsteoSoft/issues/13)) ([13dd4ea](https://github.com/PrudhommeWTF/OsteoSoft/commit/13dd4ea3f196b0089f688d4bb014c17f574b317c))
* **rgpd:** mise à jour automatique de last_visit et retention_until à la création d'une consultation ([9a9e095](https://github.com/PrudhommeWTF/OsteoSoft/commit/9a9e095294848548bdf1ed42fb642772bdbcd118))
* **scope:** restore active office filtering across screens ([d5b2213](https://github.com/PrudhommeWTF/OsteoSoft/commit/d5b22132ecc7304f02354823d54f658e44707ae7))
* **security/RGPD:** implémenter tous les points résiduels S1-S4, G1-G3 ([21d5691](https://github.com/PrudhommeWTF/OsteoSoft/commit/21d56918a1739104273dae5756ca9890a180f778))
* **security:** adresse les retours code review finaux sur la migration G1 ([7e7bd7f](https://github.com/PrudhommeWTF/OsteoSoft/commit/7e7bd7f61dcb8fef79e7f084c976be0bd5612629))
* **security:** adresse les retours code review sur la migration G1 ([396582e](https://github.com/PrudhommeWTF/OsteoSoft/commit/396582e2c337280456bf3060f729585e5f40b4c3))
* **security:** chiffrer fullName dans les logs d'audit CREATE patients (G1) ([a2a0a7e](https://github.com/PrudhommeWTF/OsteoSoft/commit/a2a0a7e31efe85ab7ec958307e7526bb9c27269d))
* **security:** chiffrer les drafts patient en base (issue [#14](https://github.com/PrudhommeWTF/OsteoSoft/issues/14)) ([74ee8ee](https://github.com/PrudhommeWTF/OsteoSoft/commit/74ee8eec9e5737f5a655404d6bb5a3de602cb734))
* **security:** remove deprecated @types/dompurify and fix sanitizer typing ([460a865](https://github.com/PrudhommeWTF/OsteoSoft/commit/460a865aebf8075d645e77844ec3ba1bd8faf422))
* **security:** sanitize innerHTML with DOMPurify and re-enable CSP ([08fa811](https://github.com/PrudhommeWTF/OsteoSoft/commit/08fa811aaf3cb68643d690910ccb2143564d1f84)), closes [#1](https://github.com/PrudhommeWTF/OsteoSoft/issues/1)
* simplify apiMessage extraction per code review ([aa9d328](https://github.com/PrudhommeWTF/OsteoSoft/commit/aa9d328fc9e1a6f07b527dcc1f8571232e9e0aec))
* swap cheque_number/reference mapping in WebOsteo payment import ([1bd6920](https://github.com/PrudhommeWTF/OsteoSoft/commit/1bd69200c2cd2e67aaaad0a339a7e2164644656c))
* use 'date' for date_precision and correct payment field mapping in webosteo import ([267c915](https://github.com/PrudhommeWTF/OsteoSoft/commit/267c915107452e003ebd67043204549ac774c9e0))

## [0.0.2] - 2025-05-01

### Nouvelles fonctionnalités

- Gestion des accès patients par cabinet avec contrôle d'accès multi-cabinet
- Chiffrement AES-256-GCM des données bancaires sensibles (IBAN, RIB)
- Importation de contacts WebOsteo et correspondants médicaux
- Génération de PDF pour les factures et les consultations
- Anonymisation RGPD des patients avec retrait de consentement
- Tableau de bord avec statistiques mensuelles et indicateurs clés
- Gestion des agendas avec créneaux configurables
- Comptabilité avec suivi des paiements et des acomptes

### Corrections de bugs

- Correction de la gestion des tokens lors du changement de mot de passe
- Correction de l'affichage des patients sans cabinet associé
