#!/usr/bin/env bash
#
# OsteoSoft : installation native dans un conteneur LXC (Debian 13, ou 12).
#
# Déploiement MONO-SERVICE : l'API Node sert à la fois /api ET le frontend Angular
# compilé (aucun nginx requis). Un seul service systemd, un seul port.
#
# Ce script :
#   1. installe Node.js 22 et les outils de compilation (better-sqlite3 est natif) ;
#   2. récupère le code source (checkout local déjà présent, sinon clone REPO_URL) ;
#   3. compile le frontend Angular et installe les dépendances de l'API ;
#   4. génère un .env avec des secrets forts (s'il n'existe pas déjà) ;
#   5. installe et démarre un service systemd pour l'API.
#
# Idempotent : peut être relancé pour mettre à jour (les secrets existants sont préservés).
#
# Variables surchargées via l'environnement :
#   APP_DIR      Répertoire d'installation           (défaut: /opt/osteosoft)
#   APP_USER     Utilisateur système de service      (défaut: osteosoft)
#   REPO_URL     URL git si le source est absent      (défaut: https://github.com/PrudhommeWTF/OsteoSoft.git)
#   BRANCH       Branche à cloner                    (défaut: main)
#   DOMAIN       Nom d'hôte public (pour CLIENT_ORIGIN) (défaut: vide → http://localhost)
#   API_PORT     Port d'écoute                       (défaut: 4199)
#   SELF_UPDATE  Mise à jour depuis l'interface       (défaut: true ; false retire le script root et les unités)
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/osteosoft}"
APP_USER="${APP_USER:-osteosoft}"
REPO_URL="${REPO_URL:-https://github.com/PrudhommeWTF/OsteoSoft.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"
API_PORT="${API_PORT:-4199}"
NODE_MAJOR="22"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;36m[osteosoft]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[osteosoft]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[osteosoft] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être exécuté en root (dans le conteneur LXC)."

# Garde-fou : ce script s'exécute DANS le conteneur, pas sur l'hôte Proxmox.
if [ -z "${ALLOW_HOST:-}" ] && { command -v pct >/dev/null 2>&1 || [ -d /etc/pve ]; }; then
  die "Vous semblez être sur l'hôte Proxmox VE, pas dans un conteneur.
  → Créez un LXC avec :  ./proxmox-create-lxc.sh
    (ou, si vous êtes bien dans un conteneur : ALLOW_HOST=1 bash install.sh)"
fi

# ── 1. Paquets système ───────────────────────────────────────────────────────
log "Installation des paquets système…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  log "Installation de Node.js ${NODE_MAJOR}.x (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v) / npm $(npm -v)"

# ── 2. Utilisateur de service ────────────────────────────────────────────────
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Création de l'utilisateur système '$APP_USER'…"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# ── 3. Code source (installation OU mise à jour) ─────────────────────────────
# Recouvre le code de $APP_DIR sans jamais toucher aux secrets (.env) ni aux
# données SQLite (server/data). Utilisé aussi bien à l'installation qu'à la
# mise à jour (relancer install.sh récupère le dernier code).
overlay_source_from() {
  tar -C "$1" \
      --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
      --exclude='./.angular' --exclude='./.env' --exclude='./server/data' \
      -cf - . | tar -C "$APP_DIR" -xf -
}

mkdir -p "$APP_DIR"
LOCAL_SRC="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || true)"

if [ -d "$APP_DIR/.git" ]; then
  # Installation issue d'un clone git : mise à jour par git.
  log "Mise à jour du code (git pull)…"
  git -C "$APP_DIR" pull --ff-only || warn "git pull a échoué : code inchangé."
elif [ -n "$LOCAL_SRC" ] && [ "$LOCAL_SRC" != "$APP_DIR" ] && [ -f "$LOCAL_SRC/package.json" ]; then
  # Exécution depuis un checkout local distinct (ex. sur l'hôte Proxmox) :
  # on recopie ce checkout (installation initiale ou mise à jour locale).
  log "Copie/mise à jour depuis le checkout local ($LOCAL_SRC)…"
  overlay_source_from "$LOCAL_SRC"
else
  # Exécution dans le conteneur sans .git (cas Option A) : on récupère la
  # dernière version depuis REPO_URL et on la superpose (secrets/données préservés).
  log "Récupération du code depuis $REPO_URL ($BRANCH)…"
  TMP_SRC="$(mktemp -d)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP_SRC/src"
  overlay_source_from "$TMP_SRC/src"
  rm -rf "$TMP_SRC"
fi
cd "$APP_DIR"

# ── 4. Dépendances + build ───────────────────────────────────────────────────
log "Installation des dépendances (npm ci) et build du frontend…"
export NG_CLI_ANALYTICS=false
npm ci
npm run build
[ -f "$APP_DIR/dist/OsteoSoft/browser/index.html" ] || die "Build Angular introuvable (dist/OsteoSoft/browser)."

# Élaguer les devDependencies pour l'exécution de l'API (better-sqlite3 reste compilé).
log "Élagage des dépendances de développement…"
npm prune --omit=dev

# ── 5. Fichier .env (secrets générés une seule fois) ─────────────────────────
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Génération de $ENV_FILE avec des secrets forts…"
  DATA_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  JWT="$(openssl rand -base64 48 | tr -d '\n')"
  ORIGIN="http://localhost"
  [ -n "$DOMAIN" ] && ORIGIN="http://${DOMAIN}"
  cat > "$ENV_FILE" <<EOF
# Généré par deploy/lxc/install.sh. NE PAS committer, NE PAS inclure dans une sauvegarde.
OSTEOSOFT_DATA_KEY=${DATA_KEY}
JWT_SECRET=${JWT}
API_PORT=${API_PORT}
CLIENT_ORIGIN=${ORIGIN}
# L'API sert aussi le frontend : exposition directe, pas de reverse proxy par défaut.
# Passez à true UNIQUEMENT si vous ajoutez nginx/Traefik devant (voir README).
TRUST_PROXY=false
# Forcer le navigateur à charger les ressources en HTTPS (CSP
# upgrade-insecure-requests). À laisser sur false en accès HTTP direct : sinon
# le JS/CSS est demandé en HTTPS (inexistant) et la page reste blanche. Passez à
# true UNIQUEMENT derrière un reverse proxy TLS.
FORCE_HTTPS=false
# Deploiement mono-service : l'assistant d'installation est ouvert depuis un
# navigateur sur le LAN (donc "a distance" du conteneur, pas en loopback). Sans
# ceci, la configuration initiale serait refusee (autorisee uniquement en local).
# La fenetre d'exposition se limite au tout premier demarrage : une fois le
# premier cabinet cree, la configuration initiale est close quoi qu'il arrive.
# Faites donc la configuration initiale sans tarder, sur un reseau de confiance.
ALLOW_REMOTE_SETUP=true
NODE_ENV=production
# Répertoire du build Angular servi par l'API (défaut auto = <app>/dist/OsteoSoft/browser).
OSTEOSOFT_STATIC_DIR=${APP_DIR}/dist/OsteoSoft/browser
EOF
  chmod 600 "$ENV_FILE"
  warn "OSTEOSOFT_DATA_KEY générée. Sauvegardez-la HORS de la machine : sans elle, les données chiffrées sont irrécupérables."
else
  log ".env existant conservé (secrets inchangés)."
fi

# ── 6. Permissions ───────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/server/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 7. Service systemd ───────────────────────────────────────────────────────
log "Installation du service systemd osteosoft-api…"
sed -e "s#__APP_DIR__#${APP_DIR}#g" \
    -e "s#__APP_USER__#${APP_USER}#g" \
    "$SCRIPT_DIR/osteosoft-api.service" > /etc/systemd/system/osteosoft-api.service
systemctl daemon-reload
systemctl enable osteosoft-api >/dev/null 2>&1
# TOUJOURS redemarrer : `enable --now` ne fait rien si le service tourne deja,
# et une mise a jour laisserait alors l'ancien code en memoire (frontend neuf
# servi depuis le disque, API ancienne).
systemctl restart osteosoft-api

# ── 8. Mise à jour depuis l'interface (script root déclenché par systemd) ────
# Le service (non privilégié) dépose server/data/.update-trigger ; l'unité
# .path, exécutée en root, lance osteosoft-self-update.sh (sauvegarde, installation
# de la version, retour arrière automatique). Voir deploy/lxc/self-update.sh.
SELF_UPDATE="${SELF_UPDATE:-true}"
if [[ "$SELF_UPDATE" =~ ^(1|true|yes|on)$ ]]; then
  log "Activation de la mise à jour depuis l'interface…"
  install -m 0755 -o root -g root "$SCRIPT_DIR/self-update.sh" /usr/local/sbin/osteosoft-self-update.sh
  install -d -m 0750 -o root -g root /var/log/osteosoft
  install -d -m 0700 -o root -g root /var/backups/osteosoft
  cat > /etc/systemd/system/osteosoft-update.service <<EOF
[Unit]
Description=OsteoSoft : mise à jour depuis l'interface
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=${APP_DIR}
Environment=APP_USER=${APP_USER}
Environment=HOME=/root
ExecStart=/usr/local/sbin/osteosoft-self-update.sh
EOF
  cat > /etc/systemd/system/osteosoft-update.path <<EOF
[Unit]
Description=OsteoSoft : surveille le déclencheur de mise à jour

[Path]
PathExists=${APP_DIR}/server/data/.update-trigger
Unit=osteosoft-update.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now osteosoft-update.path >/dev/null 2>&1 || true
else
  log "Mise à jour depuis l'interface désactivée (SELF_UPDATE=false)."
  systemctl disable --now osteosoft-update.path >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/osteosoft-update.path /etc/systemd/system/osteosoft-update.service \
        /usr/local/sbin/osteosoft-self-update.sh
  systemctl daemon-reload
fi

# ── Fin ──────────────────────────────────────────────────────────────────────
sleep 2
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if systemctl is-active --quiet osteosoft-api; then
  log "API + frontend actifs."
  # Le processus en service doit annoncer la version qui vient d'etre installee.
  EXPECTED_VERSION="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || true)"
  RUNNING_VERSION=""
  for _ in $(seq 1 30); do
    RUNNING_VERSION="$(curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null \
      | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/' || true)"
    [ -n "$RUNNING_VERSION" ] && break
    sleep 1
  done
  if [ -n "$EXPECTED_VERSION" ] && [ "$RUNNING_VERSION" = "$EXPECTED_VERSION" ]; then
    log "Version en service : ${RUNNING_VERSION}."
  else
    warn "Version en service (${RUNNING_VERSION:-inconnue}) différente de la version installée (${EXPECTED_VERSION:-inconnue}) : systemctl restart osteosoft-api"
  fi
else
  warn "Le service n'est pas actif, voir : journalctl -u osteosoft-api -n 50"
fi

cat <<EOF

$(log 'Installation terminée (mono-service).')
  • Application (frontend + API) : http://${IP:-<ip>}:${API_PORT}/
  • Données SQLite               : ${APP_DIR}/server/data/
  • Secrets                      : ${APP_DIR}/.env

Étapes suivantes recommandées :
  1. Premier démarrage : ouvrir http://<ip>:${API_PORT}/ et suivre l'assistant.
  2. TLS (hors LAN de confiance) : placer un reverse proxy (nginx/Traefik/Caddy)
     devant le port ${API_PORT}, puis mettre TRUST_PROXY=true, FORCE_HTTPS=true et
     CLIENT_ORIGIN=https://votre-domaine dans ${APP_DIR}/.env
     (exemple nginx fourni dans deploy/lxc/nginx.conf), puis :
     systemctl restart osteosoft-api
  3. Pare-feu : n'exposer que le port nécessaire (${API_PORT}, ou 443 si reverse proxy).
EOF
