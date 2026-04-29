# Guide d'installation

Ce document decrit les options d'installation de OsteoSoft:
- Installation locale Node.js
- Installation avec Docker Compose

## Prerequis

### Option locale

- Node.js 20+
- npm 10+

### Option Docker

- Docker Desktop (macOS/Windows) ou Docker Engine + Compose plugin (Linux)

## Variables d'environnement

1. Copier le fichier exemple:

   cp .env.example .env

2. Adapter au minimum les valeurs suivantes dans `.env`:

- `OSTEOSOFT_DATA_KEY`
- `JWT_SECRET`
- `API_PORT` (par defaut: 3000)
- `CLIENT_ORIGIN` (par defaut: http://localhost:4200)

Generation rapide d'une cle de chiffrement (32 bytes base64):

node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

## Option A - Installation locale Node.js

1. Installer les dependances:

   npm install

2. Lancer backend + frontend:

   npm run start:full

3. Acceder a l'application:

- Frontend: http://localhost:4200
- API: http://localhost:3000

## Option B - Installation Docker Compose

### 1) Demarrage

Depuis la racine du projet:

docker compose up -d --build

### 2) Verification

- Frontend: http://localhost:4200
- API: http://localhost:3000/api/config

### 3) Arret

docker compose down

### 4) Arret avec suppression des donnees persistantes

Attention: supprime la base SQLite et les donnees du volume Docker.

docker compose down -v

## Donnees persistantes

En mode Docker, les donnees SQLite sont conservees dans le volume nomme:

- `osteosoft_data`

Cela permet de redemarrer les conteneurs sans perdre les donnees du cabinet.

## Depannage rapide

- Le frontend ne charge pas l'API:
  - verifier que le service `api` est bien demarre
  - verifier `CLIENT_ORIGIN=http://localhost:4200` dans `.env`
- Erreur de JWT en production:
  - definir un `JWT_SECRET` fort et unique
- Erreur de chiffrement:
  - renseigner `OSTEOSOFT_DATA_KEY` avec une cle base64 valide de 32 bytes

## Commandes utiles

- Logs API:

  docker compose logs -f api

- Logs frontend:

  docker compose logs -f web

- Rebuild propre:

  docker compose down
  docker compose build --no-cache
  docker compose up -d
