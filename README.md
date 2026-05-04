# OsteoSoft

OsteoSoft est une application web de gestion de cabinet (orientation ostéopathie et professions de soin) qui centralise le suivi patient, l'agenda, la facturation, les statistiques, le répertoire de contacts et l'administration du cabinet.

Le projet est composé de:
- un frontend Angular (SPA) dans `src/`
- une API Node.js/Express dans `server/index.mjs`
- une base SQLite locale (`server/data/osteo.db`)

## Fonctionnalités principales

- Installation guidée au premier démarrage (création du cabinet ou restauration)
- Authentification et gestion de session utilisateur
- Gestion avancée des droits d'accès (profils, permissions fines par module)
- Tableau de bord d'accueil
- Agenda des rendez-vous
- Gestion des patients (liste, création, fiche détaillée)
- Dossier patient avec sections de consultation et documents
- Facturation (suivi, paiements, opérations associées)
- Statistiques et indicateurs d'activité
- Répertoire (contacts professionnels, annuaire interne)
- Espace aide intégré
- Paramétrage global du cabinet et administration

## Avantages concurrentiels

- Confidentialité des données sensibles: chiffrement applicatif des champs critiques (ex: informations patients et notes), en plus des contrôles d'accès.
- Contrôle d'accès granulaire: sécurisation par rôles et permissions par fonctionnalité (agenda, patients, facturation, statistiques, administration).
- Sauvegarde/restauration robuste: format de sauvegarde structuré avec manifest, checksum d'intégrité, limites de volume et vérification de compatibilité de version.
- Expérience de mise en route rapide: parcours d'installation intégré avec options de création initiale ou restauration des données.
- Architecture full web simple à déployer: frontend Angular + API Node.js + SQLite, adaptée aux environnements légers et aux installations progressives.

## Stack technique

- Frontend: Angular 21, Bootstrap 5, Chart.js
- Backend: Node.js, Express
- Base de données: SQLite (`better-sqlite3`)
- Sécurité: JWT, Argon2 (hash mots de passe), Helmet, rate limiting

## Prerequis

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
- `ALLOW_REMOTE_SETUP=false` (recommandé par défaut)
- `MAX_PATIENT_DOCUMENT_BYTES` (limite upload documents patient)
- `MAX_BACKUP_RESTORE_PAYLOAD_BYTES` (limite restauration)

## Lancement de l'application

### Option A - Démarrage complet (frontend + API)

```bash
npm run start:full
```

Ensuite:
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

Prérequis: Docker Desktop (macOS/Windows) ou Docker Engine + Compose plugin (Linux).

```bash
docker compose up -d --build
```

- Frontend: http://localhost:4200
- API: http://localhost:4199

Les données SQLite sont conservées dans le volume Docker `osteosoft_data` entre les redémarrages.

Arrêter les conteneurs:

```bash
docker compose down
```

Arrêter et supprimer les données persistantes:

```bash
docker compose down -v
```

> Pour les details complets (logs, rebuild, variables d'environnement), voir [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Scripts utiles

- `npm start`: lance Angular en développement
- `npm run start:api`: lance l'API backend
- `npm run start:full`: lance frontend + API en parallèle
- `npm run build`: build de production
- `npm test`: tests unitaires headless
- `npm run test:watch`: tests unitaires en mode watch
- `npm run e2e:backup`: scénario e2e sauvegarde/restauration
- `npm run e2e:rights`: scénario e2e droits d'accès
- `npm run seed:directory`: injection jeu de données répertoire
- `npm run seed:fakename`: génération/import de patients de test

## Installation en production (recommandations)

- Définir un `JWT_SECRET` fort et unique
- Positionner `NODE_ENV=production`
- Garder `ALLOW_REMOTE_SETUP=false` sauf besoin explicite
- Placer l'application derrière un reverse proxy HTTPS (Nginx/Caddy)
- Mettre en place une stratégie de sauvegardes régulières et tests de restauration

## Build de production

```bash
npm run build
```

Les artefacts frontend sont générés dans `dist/`.

## Qualité et tests

- Tests unitaires via Angular/Karma
- Scénarios e2e scripts pour points critiques:
	- droits d'accès
	- sauvegarde/restauration

## Structure du projet

- `src/`: application Angular
- `server/`: API Express et scripts techniques
- `server/data/`: base SQLite et données locales
- `public/help/`: contenus d'aide statiques

## Roadmap documentaire possible

- Guide utilisateur (secrétaire/praticien/admin)
- Politique de sauvegarde et reprise d'activité
- Procédure de migration de version

---

## Documentation complémentaire

- Guide d'installation complet: `INSTALLATION.md`
- Déploiement Docker: `docker-compose.yml`
