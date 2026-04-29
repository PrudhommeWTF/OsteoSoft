# Guide d'installation

Ce document décrit les options d'installation d'OsteoSoft:
- Installation locale Node.js
- Installation avec Docker Compose

## Prérequis

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
- `API_PORT` (par défaut: 3000)
- `CLIENT_ORIGIN` (par défaut: http://localhost:4200)

Génération rapide d'une clé de chiffrement (32 bytes base64):

node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

## Option A - Installation locale Node.js

1. Installer les dépendances:

   npm install

2. Lancer backend + frontend:

   npm run start:full

3. Accéder à l'application:

- Frontend: http://localhost:4200
- API: http://localhost:3000

## Option B - Installation Docker Compose

### 1) Démarrage

Depuis la racine du projet:

docker compose up -d --build

### 2) Vérification

- Frontend: http://localhost:4200
- API: http://localhost:3000/api/config

### 3) Arrêt

docker compose down

### 4) Arrêt avec suppression des données persistantes

Attention: supprime la base SQLite et les données du volume Docker.

docker compose down -v

## Données persistantes

En mode Docker, les données SQLite sont conservées dans le volume nommé:

- `osteosoft_data`

Cela permet de redémarrer les conteneurs sans perdre les données du cabinet.

## Dépannage rapide

- Le frontend ne charge pas l'API:
  - vérifier que le service `api` est bien démarré
  - vérifier `CLIENT_ORIGIN=http://localhost:4200` dans `.env`
- Erreur de JWT en production:
  - définir un `JWT_SECRET` fort et unique
- Erreur de chiffrement:
  - renseigner `OSTEOSOFT_DATA_KEY` avec une clé base64 valide de 32 bytes

## Commandes utiles

- Logs API:

  docker compose logs -f api

- Logs frontend:

  docker compose logs -f web

- Rebuild propre:

  docker compose down
  docker compose build --no-cache
  docker compose up -d
