# OsteoSoft

OsteoSoft est une application web de gestion de cabinet (orientation osteopathie et professions de soin) qui centralise le suivi patient, l'agenda, la facturation, les statistiques, le repertoire de contacts et l'administration du cabinet.

Le projet est compose de:
- un frontend Angular (SPA) dans `src/`
- une API Node.js/Express dans `server/index.mjs`
- une base SQLite locale (`server/data/osteo.db`)

## Fonctionnalites principales

- Installation guidee au premier demarrage (creation du cabinet ou restauration)
- Authentification et gestion de session utilisateur
- Gestion avancee des droits d'acces (profils, permissions fines par module)
- Tableau de bord d'accueil
- Agenda des rendez-vous
- Gestion des patients (liste, creation, fiche detaillee)
- Dossier patient avec sections de consultation et documents
- Facturation (suivi, paiements, operations associees)
- Statistiques et indicateurs d'activite
- Repertoire (contacts professionnels, annuaire interne)
- Espace aide integre
- Parametrage global du cabinet et administration

## Avantages concurrentiels

- Confidentialite des donnees sensibles: chiffrement applicatif des champs critiques (ex: informations patients et notes), en plus des controles d'acces.
- Controle d'acces granulaire: securisation par roles et permissions par fonctionnalite (agenda, patients, facturation, statistiques, administration).
- Sauvegarde/restauration robuste: format de sauvegarde structure avec manifest, checksum d'integrite, limites de volume et verification de compatibilite de version.
- Experience de mise en route rapide: parcours d'installation integre avec options de creation initiale ou restauration des donnees.
- Architecture full web simple a deployer: frontend Angular + API Node.js + SQLite, adaptee aux environnements legers et aux installations progressives.

## Stack technique

- Frontend: Angular 21, Bootstrap 5, Chart.js
- Backend: Node.js, Express
- Base de donnees: SQLite (`better-sqlite3`)
- Securite: JWT, Argon2 (hash mots de passe), Helmet, rate limiting

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

### 2) Installer les dependances

```bash
npm install
```

### 3) Configurer l'environnement

Creer un fichier `.env` a la racine du projet. Exemple minimal:

```env
API_PORT=3000
JWT_SECRET=change-me-in-production
NODE_ENV=development
```

Variables utiles:
- `ALLOW_REMOTE_SETUP=false` (recommande par defaut)
- `MAX_PATIENT_DOCUMENT_BYTES` (limite upload documents patient)
- `MAX_BACKUP_RESTORE_PAYLOAD_BYTES` (limite restauration)

## Lancement de l'application

### Option A - Demarrage complet (frontend + API)

```bash
npm run start:full
```

Ensuite:
- Frontend: http://localhost:4200
- API: http://localhost:3000

### Option B - Demarrage separe

Terminal 1:

```bash
npm run start:api
```

Terminal 2:

```bash
npm start
```

### Option C - Docker Compose

Prerequis: Docker Desktop (macOS/Windows) ou Docker Engine + Compose plugin (Linux).

```bash
docker compose up -d --build
```

- Frontend: http://localhost:4200
- API: http://localhost:3000

Les donnees SQLite sont conservees dans le volume Docker `osteosoft_data` entre les redemarrages.

Arreter les conteneurs:

```bash
docker compose down
```

Arreter et supprimer les donnees persistantes:

```bash
docker compose down -v
```

> Pour les details complets (logs, rebuild, variables d'environnement), voir [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Scripts utiles

- `npm start`: lance Angular en developpement
- `npm run start:api`: lance l'API backend
- `npm run start:full`: lance frontend + API en parallele
- `npm run build`: build de production
- `npm test`: tests unitaires headless
- `npm run test:watch`: tests unitaires en mode watch
- `npm run e2e:backup`: scenario e2e sauvegarde/restauration
- `npm run e2e:rights`: scenario e2e droits d'acces
- `npm run seed:directory`: injection jeu de donnees repertoire
- `npm run seed:fakename`: generation/import de patients de test

## Installation en production (recommandations)

- Definir un `JWT_SECRET` fort et unique
- Positionner `NODE_ENV=production`
- Garder `ALLOW_REMOTE_SETUP=false` sauf besoin explicite
- Placer l'application derriere un reverse proxy HTTPS (Nginx/Caddy)
- Mettre en place une strategie de sauvegardes regulieres et tests de restauration

## Build de production

```bash
npm run build
```

Les artefacts frontend sont generes dans `dist/`.

## Qualite et tests

- Tests unitaires via Angular/Karma
- Scenarios e2e scripts pour points critiques:
	- droits d'acces
	- sauvegarde/restauration

## Structure du projet

- `src/`: application Angular
- `server/`: API Express et scripts techniques
- `server/data/`: base SQLite et donnees locales
- `public/help/`: contenus d'aide statiques

## Roadmap documentaire possible

- Guide utilisateur (secretaire/praticien/admin)
- Politique de sauvegarde et reprise d'activite
- Procedure de migration de version

---

## Documentation complementaire

- Guide d'installation complet: `INSTALLATION.md`
- Deploiement Docker: `docker-compose.yml`
