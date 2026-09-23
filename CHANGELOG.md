# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.4.1-rc.3](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.4.1-rc.2...v0.4.1-rc.3) (2026-09-23)


### Corrections de bugs

* **update:** installer exactement la version annoncee a l'ecran ([#152](https://github.com/PrudhommeWTF/OsteoSoft/issues/152)) ([17f0bb4](https://github.com/PrudhommeWTF/OsteoSoft/commit/17f0bb4b0af2aa4fcdb83fef2bcb6d5bfd6b5413))

### [0.4.1-rc.2](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.4.1-rc.1...v0.4.1-rc.2) (2026-09-23)


### Corrections de bugs

* **changelog:** lister les versions correctives et preversions dans Nouveautes ([#150](https://github.com/PrudhommeWTF/OsteoSoft/issues/150)) ([7b99d82](https://github.com/PrudhommeWTF/OsteoSoft/commit/7b99d822e7cc56335f0345536bb0d0f4c1c6a60e))

### [0.4.1-rc.1](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.4.0...v0.4.1-rc.1) (2026-09-23)


### Corrections de bugs

* **deploy:** redemarrer le service quand install.sh met a jour le code ([#148](https://github.com/PrudhommeWTF/OsteoSoft/issues/148)) ([d996ede](https://github.com/PrudhommeWTF/OsteoSoft/commit/d996ede3d01527046ea48e01435e7a35a0f9fccf))

## [0.4.0](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.3.0...v0.4.0) (2026-09-23)


### Corrections de bugs

* **access:** corrige la requête de cloisonnement inter-cabinets (500 non-admin) + tests ([7f1bbb7](https://github.com/PrudhommeWTF/OsteoSoft/commit/7f1bbb7a3318ad0fbd780c47018d7ad2fcf51ad0))
* **agenda:** rendre le motif de rendez-vous reellement facultatif ([#132](https://github.com/PrudhommeWTF/OsteoSoft/issues/132)) ([d97b9f0](https://github.com/PrudhommeWTF/OsteoSoft/commit/d97b9f031109e6ec8f876b063c72dcbb178752fa))
* **auth:** cookies non Secure en HTTP direct (connexion en mono-service) ([#141](https://github.com/PrudhommeWTF/OsteoSoft/issues/141)) ([7c475b0](https://github.com/PrudhommeWTF/OsteoSoft/commit/7c475b00b8186820117a99f1efa646f9d41614c9))
* **billing:** annulation conservatrice des factures au lieu de suppression ([1b23208](https://github.com/PrudhommeWTF/OsteoSoft/commit/1b23208c9e24efaef25b9d0049ad865f01e235cd))
* **build:** utiliser une URL d'API relative en production ([#131](https://github.com/PrudhommeWTF/OsteoSoft/issues/131)) ([8f7ca47](https://github.com/PrudhommeWTF/OsteoSoft/commit/8f7ca4778b97009adc7151b26d0949878c6d9584))
* **deploy:** autoriser la configuration initiale à distance (mono-service) ([#140](https://github.com/PrudhommeWTF/OsteoSoft/issues/140)) ([553f140](https://github.com/PrudhommeWTF/OsteoSoft/commit/553f14006388e0e1fa0ce5242f52348a4f41c2ca))
* **deploy:** ne pas nommer le conteneur LXC comme l'hote Proxmox ([#139](https://github.com/PrudhommeWTF/OsteoSoft/issues/139)) ([30416a3](https://github.com/PrudhommeWTF/OsteoSoft/commit/30416a379ea68e5594d1cf25dcda3c04ed72e582))
* **deploy:** permettre la mise a jour du code dans le conteneur LXC ([#142](https://github.com/PrudhommeWTF/OsteoSoft/issues/142)) ([a3b551e](https://github.com/PrudhommeWTF/OsteoSoft/commit/a3b551edb5c6badcb26e2f4b4d7574d49e66a309))
* **deploy:** resoudre dynamiquement le template LXC Debian ([#134](https://github.com/PrudhommeWTF/OsteoSoft/issues/134)) ([2825315](https://github.com/PrudhommeWTF/OsteoSoft/commit/28253156b5c155115f4c9801f9aceeef51a14f5e))
* **frontend:** corriger la page blanche en deploiement mono-service (CSP) ([#137](https://github.com/PrudhommeWTF/OsteoSoft/issues/137)) ([7a2014b](https://github.com/PrudhommeWTF/OsteoSoft/commit/7a2014b0431d9299b592fd72e3a6f711208eeeab))
* implémente reprogrammation/annulation de RDV et corrige l'ouverture auto du modal agenda ([221d51a](https://github.com/PrudhommeWTF/OsteoSoft/commit/221d51a0898a09a417e4ed4238ea3917cb12aa2f))
* **patients:** empecher de blanchir le nom via des espaces (creation et edition) ([#133](https://github.com/PrudhommeWTF/OsteoSoft/issues/133)) ([ae0eb17](https://github.com/PrudhommeWTF/OsteoSoft/commit/ae0eb17939531f1d8589bb7542f65e658e773cc6))
* **security:** contrôle d'accès cabinet sur la création de consultation (IDOR) ([6f1c90a](https://github.com/PrudhommeWTF/OsteoSoft/commit/6f1c90a2b40462ce01d81ccc592b89b2758b9123))
* **security:** correctifs ciblés issus de l'audit RGPD/sécurité ([e5adfab](https://github.com/PrudhommeWTF/OsteoSoft/commit/e5adfab2119640be81ee1a0928f55dcff89e31b2))
* **security:** ne pas forcer HTTPS (CSP) en acces HTTP direct ([#138](https://github.com/PrudhommeWTF/OsteoSoft/issues/138)) ([fae5e10](https://github.com/PrudhommeWTF/OsteoSoft/commit/fae5e10c890aaa8d07c008d0db1f775c905af7de))
* **security:** refuse de démarrer avec les secrets de dev hors NODE_ENV=development ([#4](https://github.com/PrudhommeWTF/OsteoSoft/issues/4)) ([530198c](https://github.com/PrudhommeWTF/OsteoSoft/commit/530198c09478e2ff929884b033ac923d6a04b9da))
* **security:** scope les patients par cabinet dès la création + backfill (cloisonnement) ([#7](https://github.com/PrudhommeWTF/OsteoSoft/issues/7)) ([b93fa68](https://github.com/PrudhommeWTF/OsteoSoft/commit/b93fa68946cf71020d135f293c1c2cb8ada49b2b))
* **seed:** generer les patients fictifs en local, sans appel reseau ([#130](https://github.com/PrudhommeWTF/OsteoSoft/issues/130)) ([dcc4ce5](https://github.com/PrudhommeWTF/OsteoSoft/commit/dcc4ce529e8fc036467e38b721bee8045b4091b1))
* vue Jour n'oublie plus aucun RDV et rattache les paiements aux remises WebOsteo ([caa170f](https://github.com/PrudhommeWTF/OsteoSoft/commit/caa170f66a6f0e55513f382f05290f48bc80d901))
* **webosteo:** import idempotent des remises bancaires + tests ([d36cb47](https://github.com/PrudhommeWTF/OsteoSoft/commit/d36cb47bcab848d319ee67c86395fbaf1d5ac9ec))


### Nouvelles fonctionnalités

* **backup:** sauvegardes chiffrées autoportantes (phrase de passe) ([#121](https://github.com/PrudhommeWTF/OsteoSoft/issues/121)) ([514680b](https://github.com/PrudhommeWTF/OsteoSoft/commit/514680b03b72478549b3d20550075e91fae3cb1b))
* **billing:** livre des recettes micro-BNC (journal des encaissements) ([#120](https://github.com/PrudhommeWTF/OsteoSoft/issues/120)) ([0b10466](https://github.com/PrudhommeWTF/OsteoSoft/commit/0b104667eeca04e24bb948c9649e2bf465ecf8a4))
* **billing:** numérotation des factures attribuée par le serveur (séquentielle, sans trou) ([#119](https://github.com/PrudhommeWTF/OsteoSoft/issues/119)) ([58d87ef](https://github.com/PrudhommeWTF/OsteoSoft/commit/58d87ef4b22e20ec86dd5c8576cc568c4964dfaf))
* déploiement mono-service (l'API sert le frontend) + kit LXC aligné sur Foyer ([d562f87](https://github.com/PrudhommeWTF/OsteoSoft/commit/d562f871d156fef82f54d426d65a2c6ba7eb7dd9))
* **deploy:** kit de déploiement LXC Proxmox (nginx + systemd, sans Docker) ([ff99386](https://github.com/PrudhommeWTF/OsteoSoft/commit/ff993864753b2a5a75dc0a429668e286518946f2))
* **deploy:** script root de mise a jour en un clic avec retour arriere ([#144](https://github.com/PrudhommeWTF/OsteoSoft/issues/144)) ([1abb33e](https://github.com/PrudhommeWTF/OsteoSoft/commit/1abb33eb08c51f5f1d38a385f1defccf010a3bd8))
* **docker:** ajoute l'image unique + compose mono-service + docs ([9f24bf0](https://github.com/PrudhommeWTF/OsteoSoft/commit/9f24bf0905fc16c32ae9beb18390f5fa32bc1406))
* **docker:** image unique multi-stage (l'API sert le frontend), façon Foyer ([a1a09ee](https://github.com/PrudhommeWTF/OsteoSoft/commit/a1a09ee730d783fbe72edcb2cc64670190e93474))
* **rgpd:** rendre la conservation configurable et l'anonymisation confirmee ([#124](https://github.com/PrudhommeWTF/OsteoSoft/issues/124)) ([fb62f30](https://github.com/PrudhommeWTF/OsteoSoft/commit/fb62f3094e1d3fb0f06f4726e47c00aa4aace29c))
* **security:** chiffre au repos le titre de consultation et la catégorie d'antécédent (RGPD art. 9) ([e588276](https://github.com/PrudhommeWTF/OsteoSoft/commit/e588276aae1f5f1af29de61b7a6bbf11aab88df1))
* **security:** consentement réel + application effective de la restriction (RGPD Art. 7 & 18) ([#2](https://github.com/PrudhommeWTF/OsteoSoft/issues/2)) ([617e3c4](https://github.com/PrudhommeWTF/OsteoSoft/commit/617e3c4f8b7cfcb64b4f1abb0b184ede9f467c9d))
* **security:** journal d'audit inviolable + préservation de la traçabilité (RGPD Art. 30) ([#3](https://github.com/PrudhommeWTF/OsteoSoft/issues/3)) ([1af1c4c](https://github.com/PrudhommeWTF/OsteoSoft/commit/1af1c4cc424a53f546999a58ecdfdd6c9215797f))
* **server:** cadre de migrations versionnées + adoption du schéma comme socle (Priorité 2) ([191f577](https://github.com/PrudhommeWTF/OsteoSoft/commit/191f577dfddc96aa56e1e8d19294e34a11e0fba5))
* **update:** ecran Mises a jour et notification de nouvelle version ([#145](https://github.com/PrudhommeWTF/OsteoSoft/issues/145)) ([70fbd13](https://github.com/PrudhommeWTF/OsteoSoft/commit/70fbd13ed4f542b1ddbbcce3e1cdeca6a8062a4a))
* **update:** verification des releases GitHub et declenchement de mise a jour ([#143](https://github.com/PrudhommeWTF/OsteoSoft/issues/143)) ([5bad919](https://github.com/PrudhommeWTF/OsteoSoft/commit/5bad919cc85df25eccab1da85278f3cbaa04edfd))

## [0.3.0](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.2.0...v0.3.0) (2026-07-18)


### Nouvelles fonctionnalités

* refonte UI complète — design system, agenda, workspace consultation et datepicker ([088ef69](https://github.com/PrudhommeWTF/OsteoSoft/commit/088ef69075b4a000da57872c609e271963ab11fb))

## [0.2.0](https://github.com/PrudhommeWTF/OsteoSoft/compare/v0.1.0...v0.2.0) (2026-06-15)


### Corrections de bugs

* 409 for duplicate invoice, complete GDPR export with invoices+documents, case-insensitive login ([95144df](https://github.com/PrudhommeWTF/OsteoSoft/commit/95144df547a39bb3b15337c406e60850781ee345))
* add Zod validation to appointment creation and access control to consultation update ([a84b5a9](https://github.com/PrudhommeWTF/OsteoSoft/commit/a84b5a90b78451f041bee56e59fe1a8fdccf987d))
* allow profile/agenda-preferences route when must_change_password=1 ([1fdd335](https://github.com/PrudhommeWTF/OsteoSoft/commit/1fdd335f22a0b3ff52fe7244bb38f6c9d4bc26fe))
* changelog modal always shows latest version and clean content ([f64ba02](https://github.com/PrudhommeWTF/OsteoSoft/commit/f64ba02d6ada07924e4efb97aa05e9a02a0fbb35))
* convert appointment startsAt to ISO, clear session on 401, use environment apiUrl ([2b2c597](https://github.com/PrudhommeWTF/OsteoSoft/commit/2b2c5977e6491675ea2ec7f15855ae18edb7b36f))
* correct Excel label, live billing TTC calculation, and comma-decimal deposit amount ([7108a9f](https://github.com/PrudhommeWTF/OsteoSoft/commit/7108a9f41addac2c7252028d7a201cd5ee1fbfa6))
* **docker:** copy CHANGELOG.md into API image for changelog modal ([4d1b8a4](https://github.com/PrudhommeWTF/OsteoSoft/commit/4d1b8a43937d67795b430dbd6d1b9730cbba626f))
* exclude cancelled invoices from billing alerts and normalize WebOsteo invoice statuses ([0a292a5](https://github.com/PrudhommeWTF/OsteoSoft/commit/0a292a596fd59dacf91068efd60376e691200245))
* **gdpr:** align consent form retention period from 5 to 10 years ([35dab9e](https://github.com/PrudhommeWTF/OsteoSoft/commit/35dab9e19c36c9a26bd65681a67a343afe7d7800))
* **gdpr:** complete anonymization - clear sex, birth_date, and invoice_payments PII ([0f7a007](https://github.com/PrudhommeWTF/OsteoSoft/commit/0f7a0079e5a231bb1a387bfb0bb696e9515f5736))
* **gdpr:** correct minor patient retention to age 28 and extend audit log retention to 10 years ([914533c](https://github.com/PrudhommeWTF/OsteoSoft/commit/914533c16f5373fff92072b8de5e133d6bcc67b8))
* **gdpr:** replace immediate anonymization on consent withdrawal with processing restriction ([0bf2a13](https://github.com/PrudhommeWTF/OsteoSoft/commit/0bf2a13e7879195b1dc81ba3ece9b3544c42b411))
* **gdpr:** set consent_signed default to 0 and fix quick patient creation ([8d8b6e1](https://github.com/PrudhommeWTF/OsteoSoft/commit/8d8b6e1bc9739a415f49855b5763285d00c79152))
* remove orphan try block in persistConsultationBillingInvoice ([a7eb968](https://github.com/PrudhommeWTF/OsteoSoft/commit/a7eb968d458f6f3b4cfe41fad817403e33e6e5ad))
* repair adminOnlyMiddleware dead code and require write permission on patient update ([3c89113](https://github.com/PrudhommeWTF/OsteoSoft/commit/3c8911334fe8f6428d07b872eb478d54732c391d))
* resolve build errors after last merge ([cc32eef](https://github.com/PrudhommeWTF/OsteoSoft/commit/cc32eef4ba9ec6edbb8191b1f10dcf3c8c1712e9))
* surface invoice creation failure, show all operation types, prevent double-submit in agenda ([a272970](https://github.com/PrudhommeWTF/OsteoSoft/commit/a272970bb48ea8af14375b4a526fb6f7d3b67298))
* unsubscribe antecedentDateCtrl subscription and destroy effects in ngOnDestroy ([5a61bab](https://github.com/PrudhommeWTF/OsteoSoft/commit/5a61bab5dfc20b12e146248924e7a80a24008165))
* use req.user.sub instead of req.user.id in all audit log calls ([23064b4](https://github.com/PrudhommeWTF/OsteoSoft/commit/23064b4cdbf12e145a77b6f85926069526724773))
* validate paid status for deposit invoices, normalize source_type, validate document officeId ([c1039eb](https://github.com/PrudhommeWTF/OsteoSoft/commit/c1039eb895c8682ce22f39069d65a850d16c8c32))
* **webosteo-import:** replace office data and restrict users to cabinet-level rights ([b4e0689](https://github.com/PrudhommeWTF/OsteoSoft/commit/b4e0689ef8840dd1484e105431c1251dc599712b))
* wrap office deletion in transaction and add access control to consultation drafts ([f220165](https://github.com/PrudhommeWTF/OsteoSoft/commit/f220165da476bcbfa802113c03822f5080c613c3))
* wrap WebOsteo import in transaction and add try/finally to backup restore ([3bed32c](https://github.com/PrudhommeWTF/OsteoSoft/commit/3bed32c4236cd68a59c966364586d04d2cba4ef5))
* wrap WebOsteo import in transaction and add try/finally to backup restore ([bf14e2c](https://github.com/PrudhommeWTF/OsteoSoft/commit/bf14e2c8715db2f6a59b5c853f93340946bce114))


### Nouvelles fonctionnalités

* add flexible datepicker mode with drill-down UX for antécédents ([2d0988c](https://github.com/PrudhommeWTF/OsteoSoft/commit/2d0988c293154a02449799fea52491ef6563a8a9))
* improve WebOsteo import — liens de parenté, remises bancaires, statut utilisateur ([71dee5a](https://github.com/PrudhommeWTF/OsteoSoft/commit/71dee5abf143cac9e8531582e0910bb1696f4cd0))
* refactor datepicker to support date/month/year modes and date range picker ([c8948db](https://github.com/PrudhommeWTF/OsteoSoft/commit/c8948db4345398385900aafa212f49ad92441846))
* **ui:** add datetime mode to app-date-picker with 15-min time slots and Maintenant button ([4393988](https://github.com/PrudhommeWTF/OsteoSoft/commit/439398825893bc39de3ed31d4259ab37debaddf7))
* use flexible datepicker for all standard date fields ([f5d9509](https://github.com/PrudhommeWTF/OsteoSoft/commit/f5d95093f037982d2e500e7d6d13b67585a2e41b))
* **ux:** office opening hours - 15-min time steps and end > start validation ([9e00526](https://github.com/PrudhommeWTF/OsteoSoft/commit/9e00526d13107c909b0e0d77c35dfa260a4a9805))
* **ux:** replace datetime-local in appointment modal with interactive slot picker ([f58e7b6](https://github.com/PrudhommeWTF/OsteoSoft/commit/f58e7b6862286053d19dabbe212ce6c1a9f34335))
* **ux:** replace native date/datetime inputs with app-date-picker across all pages ([6b8acec](https://github.com/PrudhommeWTF/OsteoSoft/commit/6b8acec060b0562eb44870fca3f3dc52abec69ab))

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
