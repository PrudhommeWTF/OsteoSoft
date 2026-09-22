# OsteoSoft

OsteoSoft est une application web de gestion de cabinet (ostéopathie et professions de soin) qui centralise le suivi patient, l’agenda, la facturation, les statistiques, le répertoire de contacts et l’administration.

Le projet est composé de:
- un frontend Angular (SPA) dans `src/`
- une API Node.js/Express dans `server/index.mjs`
- une base SQLite locale (`server/data/osteo.db`)

## Dernières mises à jour (v0.1.0)

Basé sur le changelog du `2026-05-15`, les évolutions majeures récentes incluent:

- Import WebOsteo amélioré (patients, consultations, paiements) + endpoint/API dédiés
- Renforcement RGPD (consentement, anonymisation, rétention automatique)
- Sécurité renforcée (chiffrement étendu des données sensibles, rate limiting, hardening API)
- Refonte de la génération PDF via `PdfBuilderService` et personnalisation des templates
- Améliorations UI/UX (date picker modernisé, tooltips Bootstrap, dashboard enrichi)
- Remplacement de `xlsx` par `exceljs`
- Versioning applicatif avec changelog et endpoint `/api/changelog`

## Site vitrine statique (Bootstrap) hébergé sur GitHub Pages

Un site vitrine commercial statique est disponible dans `docs/`:

- Fichier principal: `docs/index.html`
- Framework CSS: Bootstrap 5 (CDN)
- Version bilingue: FR/EN avec bascule intégrée
- Section commerciale: Contact / Demande de démo
- URL de publication attendue: `https://prudhommewtf.github.io/OsteoSoft/`

Le déploiement GitHub Pages est automatisé via workflow (`.github/workflows/deploy-pages.yml`).

## Fonctionnalités principales

- Installation guidée au premier démarrage (création du cabinet ou restauration)
- Authentification et gestion de session utilisateur
- Gestion avancée des droits d'accès (profils, permissions fines par module)
- Agenda des rendez-vous et gestion patient complète
- Facturation, paiements, exports et indicateurs d’activité
- Répertoire de contacts et espace aide intégré
- Paramétrage global du cabinet et administration

## Stack technique

- Frontend: Angular 21, Bootstrap 5, Chart.js
- Backend: Node.js, Express
- Base de données: SQLite (`better-sqlite3`)
- Sécurité: JWT, Argon2, Helmet, rate limiting

## Prérequis

- Node.js 20+
- npm 10+
- macOS, Linux ou Windows

## Installation

### 1) Cloner le projet

```bash
git clone https://github.com/PrudhommeWTF/OsteoSoft.git
cd OsteoSoft
```

### 2) Installer les dépendances

```bash
npm install
```

### 3) Configurer l'environnement

Créer un fichier `.env` à la racine du projet. Exemple minimal:

```env
API_PORT=4199
JWT_SECRET=change-me-in-production
NODE_ENV=development
```

Variables utiles:
- `ALLOW_REMOTE_SETUP=false`
- `MAX_PATIENT_DOCUMENT_BYTES`
- `MAX_BACKUP_RESTORE_PAYLOAD_BYTES`

## Lancement de l'application

### Option A - Démarrage complet (frontend + API)

```bash
npm run start:full
```

Puis:
- Frontend: http://localhost:4200
- API: http://localhost:4199

### Option B - Démarrage séparé

Terminal 1:

```bash
npm run start:api
```

Terminal 2:

```bash
npm start
```

### Option C - Docker Compose

```bash
docker compose up -d --build
```

Arrêt:

```bash
docker compose down
```

Arrêt + suppression des données persistantes:

```bash
docker compose down -v
```

Voir le guide complet: [INSTALLATION.md](INSTALLATION.md).

## Scripts utiles

- `npm start`
- `npm run start:api`
- `npm run start:full`
- `npm run build`
- `npm test`
- `npm run test:watch`
- `npm run test:e2e` (tests navigateur Playwright)
- `npm run e2e:scenarios` (scenarios HTTP sans interface)
- `npm run e2e:backup`
- `npm run e2e:rights`
- `npm run e2e:clinical`
- `npm run seed:directory`
- `npm run seed:fakename` (patients fictifs generes localement, sans reseau)

## Structure du projet

- `src/`: application Angular
- `server/`: API Express
- `server/data/`: base SQLite et données locales
- `public/help/`: contenus d’aide statiques
- `docs/`: site vitrine commercial GitHub Pages

## Documentation complémentaire

- Guide d'installation complet: `INSTALLATION.md`
- Déploiement Docker: `docker-compose.yml`
- Historique des versions: `CHANGELOG.md`
