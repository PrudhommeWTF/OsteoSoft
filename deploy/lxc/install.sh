#!/usr/bin/env bash
#
# OsteoSoft — installation native dans un conteneur LXC (Debian 12 recommandé).
#
# Ce script :
#   1. installe Node.js 20, nginx et les outils de compilation (better-sqlite3 est natif) ;
#   2. récupère le code source (checkout local déjà présent, sinon clone REPO_URL) ;
#   3. compile le frontend Angular et installe les dépendances de l'API ;
#   4. génère un .env avec des secrets forts (s'il n'existe pas déjà) ;
#   5. installe un service systemd pour l'API et une config nginx (statique + proxy /api) ;
#   6. démarre le tout.
#
# Idempotent : peut être relancé pour mettre à jour (les secrets existants sont préservés).
#
# Variables surchargées via l'environnement :
#   APP_DIR      Répertoire d'installation           (défaut: /opt/osteosoft)
#   APP_USER     Utilisateur système de service      (défaut: osteosoft)
#   REPO_URL     URL git si le source est absent      (défaut: https://github.com/PrudhommeWTF/OsteoSoft.git)
#   BRANCH       Branche à cloner                    (défaut: main)
#   DOMAIN       Nom d'hôte public (server_name)      (défaut: _  → toutes origines)
#   API_PORT     Port d'écoute de l'API              (défaut: 4199)
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/osteosoft}"
APP_USER="${APP_USER:-osteosoft}"
REPO_URL="${REPO_URL:-https://github.com/PrudhommeWTF/OsteoSoft.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-_}"
API_PORT="${API_PORT:-4199}"
NODE_MAJOR="20"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;36m[osteosoft]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[osteosoft]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[osteosoft] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être exécuté en root (dans le conteneur LXC)."

# ── 1. Paquets système ───────────────────────────────────────────────────────
log "Installation des paquets système…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx build-essential python3 >/dev/null

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

# ── 3. Code source ───────────────────────────────────────────────────────────
if [ -f "$APP_DIR/package.json" ]; then
  log "Source déjà présent dans $APP_DIR (pas de clone)."
elif [ -f "$SCRIPT_DIR/../../package.json" ]; then
  log "Copie du checkout local vers $APP_DIR…"
  mkdir -p "$APP_DIR"
  # Copie du dépôt (sans .git ni artefacts) depuis le checkout qui contient ce script.
  tar -C "$(cd "$SCRIPT_DIR/../.." && pwd)" \
      --exclude='./.git' --exclude='./node_modules' --exclude='./dist' --exclude='./.angular' \
      -cf - . | tar -C "$APP_DIR" -xf -
else
  log "Clone de $REPO_URL ($BRANCH) vers $APP_DIR…"
  if [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    # APP_DIR non vide (ex: deploy/lxc déjà poussé) → cloner à part puis fusionner.
    TMP_SRC="$(mktemp -d)"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP_SRC/src"
    cp -a "$TMP_SRC/src/." "$APP_DIR/"
    rm -rf "$TMP_SRC"
  else
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  fi
fi
cd "$APP_DIR"

# ── 4. Dépendances + build ───────────────────────────────────────────────────
log "Installation des dépendances (npm ci) et build du frontend…"
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
  ORIGIN="http://${DOMAIN}"
  [ "$DOMAIN" = "_" ] && ORIGIN="http://localhost"
  cat > "$ENV_FILE" <<EOF
# Généré par deploy/lxc/install.sh — NE PAS committer, NE PAS inclure dans une sauvegarde.
OSTEOSOFT_DATA_KEY=${DATA_KEY}
JWT_SECRET=${JWT}
API_PORT=${API_PORT}
CLIENT_ORIGIN=${ORIGIN}
# nginx est en frontal → activer la détection du reverse proxy.
TRUST_PROXY=true
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
  warn "OSTEOSOFT_DATA_KEY générée. Sauvegardez-la HORS de la machine : sans elle, les données chiffrées sont irrécupérables."
  warn "Après configuration TLS, mettez CLIENT_ORIGIN=https://${DOMAIN} dans $ENV_FILE."
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
systemctl enable --now osteosoft-api

# ── 8. nginx ─────────────────────────────────────────────────────────────────
log "Configuration de nginx…"
sed -e "s#__APP_DIR__#${APP_DIR}#g" \
    -e "s#__DOMAIN__#${DOMAIN}#g" \
    -e "s#__API_PORT__#${API_PORT}#g" \
    "$SCRIPT_DIR/nginx.conf" > /etc/nginx/sites-available/osteosoft
ln -sf /etc/nginx/sites-available/osteosoft /etc/nginx/sites-enabled/osteosoft
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── Fin ──────────────────────────────────────────────────────────────────────
sleep 1
if systemctl is-active --quiet osteosoft-api; then
  log "API active (systemctl status osteosoft-api)."
else
  warn "L'API n'est pas active — voir: journalctl -u osteosoft-api -n 50"
fi

cat <<EOF

$(log 'Installation terminée.')
  • Frontend + API servis par nginx sur le port 80.
  • Domaine (server_name) : ${DOMAIN}
  • Données SQLite        : ${APP_DIR}/server/data/
  • Secrets               : ${APP_DIR}/.env

Étapes suivantes recommandées :
  1. TLS  : apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d votre-domaine
           puis CLIENT_ORIGIN=https://votre-domaine dans ${APP_DIR}/.env et:
           systemctl restart osteosoft-api
  2. Pare-feu : n'exposer que 80/443 ; garder le port ${API_PORT} (API) interne.
  3. Premier démarrage : ouvrir http://<domaine>/ et suivre l'assistant d'installation.
EOF
