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

- `OSTEOSOFT_DATA_KEY` — clé AES-256 pour le chiffrement des données sensibles (**obligatoire en production**)
- `JWT_SECRET` — secret de signature des tokens de session (**obligatoire en production**)
- `API_PORT` (par défaut: 3000)
- `CLIENT_ORIGIN` (par défaut: http://localhost:4200)

Génération rapide d'une clé de chiffrement (32 bytes base64):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> ⚠️ **Sécurité** : ne jamais inclure `OSTEOSOFT_DATA_KEY` dans une sauvegarde. Conservez-la dans un gestionnaire de secrets séparé (Vault, Bitwarden Secrets, variable d'environnement système chiffrée).

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

```
docker compose up -d --build
```

### 2) Vérification

- Frontend: http://localhost:4200
- API: http://localhost:3000/api/config

### 3) Arrêt

```
docker compose down
```

### 4) Arrêt avec suppression des données persistantes

Attention: supprime la base SQLite et les données du volume Docker.

```
docker compose down -v
```

## Données persistantes

En mode Docker, les données SQLite sont conservées dans le volume nommé:

- `osteosoft_data`

Cela permet de redémarrer les conteneurs sans perdre les données du cabinet.

## HTTPS / TLS en production (obligatoire)

**OsteoSoft doit toujours être exposé en HTTPS en dehors d'un réseau local de confiance.**

L'application elle-même ne termine pas TLS. Placez un reverse proxy devant l'API et le frontend.

### Exemple avec nginx

```nginx
server {
    listen 443 ssl http2;
    server_name osteosoft.example.com;

    ssl_certificate     /etc/letsencrypt/live/osteosoft.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/osteosoft.example.com/privkey.pem;

    # Frontend Angular
    location / {
        proxy_pass http://localhost:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API Node.js
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Redirection HTTP → HTTPS
server {
    listen 80;
    server_name osteosoft.example.com;
    return 301 https://$host$request_uri;
}
```

Après avoir configuré le reverse proxy, activer la détection du proxy dans `.env`:

```
TRUST_PROXY=true
CLIENT_ORIGIN=https://osteosoft.example.com
```

### Certificats TLS gratuits avec Let's Encrypt

```
certbot --nginx -d osteosoft.example.com
```

### Exemple avec Traefik (Docker Compose)

Ajouter les labels Traefik à votre service dans `docker-compose.yml` et configurer l'[ACME resolver](https://doc.traefik.io/traefik/https/acme/).

## Rétention des données (RGPD)

Durées configurables via variables d'environnement:

| Variable | Défaut | Description |
|---|---|---|
| `AUDIT_LOG_RETENTION_DAYS` | `1095` (3 ans) | Purge automatique des logs d'audit |
| `DRAFT_RETENTION_DAYS` | `7` | Purge des brouillons orphelins |

Mettre une valeur à `0` désactive la purge automatique correspondante.

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

  ```
  docker compose down
  docker compose build --no-cache
  docker compose up -d
  ```
