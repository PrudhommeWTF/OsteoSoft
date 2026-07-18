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
- `API_PORT` (par défaut: 4199)
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
- API: http://localhost:4199

## Option B - Installation Docker Compose

Image **unique** : un seul conteneur, l'API Node servant à la fois le frontend
Angular compilé et `/api` (aucun conteneur web séparé).

### 1) Démarrage

Depuis la racine du projet:

```
cp .env.example .env   # renseigner OSTEOSOFT_DATA_KEY et JWT_SECRET
docker compose up -d --build
```

### 2) Vérification

- Application (frontend + API): http://localhost:4199/
- Santé API: http://localhost:4199/api/config

### 3) Arrêt

```
docker compose down
```

### 4) Arrêt avec suppression des données persistantes

Attention: supprime la base SQLite et les données du volume Docker.

```
docker compose down -v
```

## Option C - Déploiement LXC Proxmox (natif, sans Docker)

Un kit de déploiement natif est fourni dans `deploy/lxc/` : conteneur LXC
Debian 12, **mono-service** (l'API Node sert à la fois `/api` et le frontend
Angular compilé), lancé par un unique service **systemd** — aucun nginx requis.

Depuis l'hôte Proxmox VE (en root) :

```bash
git clone https://github.com/PrudhommeWTF/OsteoSoft.git
cd OsteoSoft/deploy/lxc
./proxmox-create-lxc.sh          # ou: DOMAIN=osteosoft.example.com ./proxmox-create-lxc.sh
```

Le script crée le conteneur, y transfère le code (fonctionne aussi pour un
dépôt privé) puis lance l'installation (Node 20, build, secrets générés,
service systemd). L'application est ensuite accessible sur
`http://<ip-du-lxc>:4199/`. TLS, options réseau, exploitation et sauvegarde :
voir [`deploy/lxc/README.md`](deploy/lxc/README.md).

## Données persistantes

En mode Docker, les données SQLite sont conservées dans le volume nommé:

- `osteosoft_data`

Cela permet de redémarrer les conteneurs sans perdre les données du cabinet.

## HTTPS / TLS en production (obligatoire)

**OsteoSoft doit toujours être exposé en HTTPS en dehors d'un réseau local de confiance.**

L'application elle-même ne termine pas TLS. En mono-service, l'API sert le
frontend **et** `/api` sur un seul port : placez un reverse proxy devant ce port.

### Exemple avec nginx

```nginx
server {
    listen 443 ssl http2;
    server_name osteosoft.example.com;

    ssl_certificate     /etc/letsencrypt/live/osteosoft.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/osteosoft.example.com/privkey.pem;

    client_max_body_size 60m;

    # Tout (frontend + /api) est servi par l'API Node.
    location / {
        proxy_pass http://localhost:4199;
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

- Logs (frontend + API, conteneur unique):

  docker compose logs -f osteosoft

- Rebuild propre:

  ```
  docker compose down
  docker compose build --no-cache
  docker compose up -d
  ```
