#!/usr/bin/env bash
#
# OsteoSoft — création d'un conteneur LXC sur un hôte Proxmox VE, puis installation.
#
# À exécuter EN ROOT SUR L'HÔTE PROXMOX (là où la commande `pct` existe),
# de préférence depuis un checkout du dépôt :
#
#     git clone https://github.com/PrudhommeWTF/OsteoSoft.git
#     cd OsteoSoft/deploy/lxc
#     ./proxmox-create-lxc.sh
#
# Le script :
#   1. résout et télécharge le dernier template Debian (13 « trixie » par défaut) si nécessaire ;
#   2. crée un conteneur LXC non privilégié ;
#   3. y pousse le code source (checkout local) — ou le fera cloner si REPO_URL est fourni ;
#   4. lance deploy/lxc/install.sh à l'intérieur.
#
# Variables surchargées via l'environnement (voir défauts ci-dessous) :
#   CTID CT_HOSTNAME STORAGE TEMPLATE_STORAGE DISK_GB CORES RAM_MB BRIDGE
#   IP (dhcp | CIDR ex: 192.168.1.50/24) GATEWAY DNS
#   DOMAIN REPO_URL BRANCH
#   DEBIAN_RELEASE (defaut 13) TEMPLATE_NAME (force un template precis)
#
set -euo pipefail

CTID="${CTID:-}"
# Attention : ne PAS utiliser $HOSTNAME (variable predefinie de bash = nom de
# l'hote courant), sinon le conteneur herite du nom de l'hote Proxmox. On utilise
# CT_HOSTNAME, surchargeable via l'environnement.
CT_HOSTNAME="${CT_HOSTNAME:-osteosoft}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-8}"
CORES="${CORES:-2}"
RAM_MB="${RAM_MB:-2048}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GATEWAY="${GATEWAY:-}"
DNS="${DNS:-}"
DOMAIN="${DOMAIN:-}"
API_PORT="${API_PORT:-4199}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
# Version majeure de Debian visee. On NE fige PAS la revision de correctif
# (12.7, 12.8, ...) : pveam ne propose au telechargement que la revision
# courante, donc une valeur figee finit par disparaitre du catalogue. La
# revision exacte est resolue dynamiquement plus bas. TEMPLATE_NAME force un
# template precis si besoin.
DEBIAN_RELEASE="${DEBIAN_RELEASE:-13}"
TEMPLATE_NAME="${TEMPLATE_NAME:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log()  { printf '\033[1;36m[proxmox]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[proxmox] %s\033[0m\n' "$*" >&2; exit 1; }

command -v pct >/dev/null 2>&1 || die "Commande 'pct' introuvable : exécutez ce script sur l'hôte Proxmox VE."
[ "$(id -u)" -eq 0 ] || die "Doit être exécuté en root."

# ── CTID ─────────────────────────────────────────────────────────────────────
if [ -z "$CTID" ]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null || echo 900)"
  log "CTID non fourni, utilisation du prochain libre : $CTID"
fi
pct status "$CTID" >/dev/null 2>&1 && die "Le conteneur $CTID existe déjà."

# ── Template ─────────────────────────────────────────────────────────────────
# Motif de nom attendu : debian-<release>-standard_<version>_amd64.tar.(zst|gz)
TEMPLATE_GLOB="debian-${DEBIAN_RELEASE}-standard_.*_amd64\\.tar\\.(zst|gz)"

# Dernier template deja telecharge sur le stockage (revision la plus recente).
latest_local_template() {
  pveam list "$TEMPLATE_STORAGE" 2>/dev/null \
    | awk '{print $1}' | sed 's#.*/##' \
    | grep -E "^${TEMPLATE_GLOB}$" | sort -V | tail -n1
}

# Dernier template disponible au telechargement dans le catalogue.
latest_available_template() {
  pveam available --section system 2>/dev/null \
    | awk '{print $2}' \
    | grep -E "^${TEMPLATE_GLOB}$" | sort -V | tail -n1
}

if [ -z "$TEMPLATE_NAME" ]; then
  log "Résolution du dernier template debian-${DEBIAN_RELEASE}-standard…"
  TEMPLATE_NAME="$(latest_local_template)"
  if [ -z "$TEMPLATE_NAME" ]; then
    pveam update >/dev/null 2>&1 || true
    TEMPLATE_NAME="$(latest_available_template)"
  fi
  [ -n "$TEMPLATE_NAME" ] \
    || die "Aucun template debian-${DEBIAN_RELEASE}-standard trouvé. Listez: pveam available --section system | grep debian-${DEBIAN_RELEASE}"
  log "Template retenu : $TEMPLATE_NAME"
fi

TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_NAME"; then
  log "Téléchargement du template $TEMPLATE_NAME…"
  pveam update >/dev/null 2>&1 || true
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME" \
    || die "Impossible de télécharger $TEMPLATE_NAME. Listez les templates dispo avec: pveam available --section system | grep debian-${DEBIAN_RELEASE}"
fi

# ── Réseau ───────────────────────────────────────────────────────────────────
NET="name=eth0,bridge=${BRIDGE}"
if [ "$IP" = "dhcp" ]; then
  NET="${NET},ip=dhcp"
else
  NET="${NET},ip=${IP}"
  [ -n "$GATEWAY" ] && NET="${NET},gw=${GATEWAY}"
fi

# ── Création ─────────────────────────────────────────────────────────────────
log "Création du conteneur $CTID ($CT_HOSTNAME)…"
# shellcheck disable=SC2086
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$NET" \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  ${DNS:+--nameserver "$DNS"}

log "Démarrage du conteneur…"
pct start "$CTID"

# Attente réseau (résolution DNS OK).
log "Attente de la connectivité réseau…"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done

# ── Transfert du code + install ──────────────────────────────────────────────
pct exec "$CTID" -- mkdir -p /opt/osteosoft

if [ -z "$REPO_URL" ] && [ -f "$REPO_ROOT/package.json" ]; then
  log "Transfert du checkout local vers le conteneur (git archive)…"
  TARBALL="$(mktemp --suffix=.tgz)"
  if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$REPO_ROOT" archive --format=tar.gz -o "$TARBALL" HEAD
  else
    tar -C "$REPO_ROOT" --exclude='./.git' --exclude='./node_modules' \
        --exclude='./dist' --exclude='./.angular' -czf "$TARBALL" .
  fi
  pct push "$CTID" "$TARBALL" /root/osteosoft-src.tgz
  pct exec "$CTID" -- tar -C /opt/osteosoft -xzf /root/osteosoft-src.tgz
  pct exec "$CTID" -- rm -f /root/osteosoft-src.tgz
  rm -f "$TARBALL"
  INSTALL_ENV="DOMAIN=${DOMAIN} API_PORT=${API_PORT}"
else
  # Le source sera cloné par install.sh dans le conteneur.
  [ -n "$REPO_URL" ] || REPO_URL="https://github.com/PrudhommeWTF/OsteoSoft.git"
  log "Le conteneur clonera $REPO_URL ($BRANCH)…"
  # On a quand même besoin d'install.sh à l'intérieur : on pousse le dossier deploy/lxc.
  pct exec "$CTID" -- mkdir -p /opt/osteosoft/deploy/lxc
  for f in install.sh osteosoft-api.service nginx.conf; do
    pct push "$CTID" "$SCRIPT_DIR/$f" "/opt/osteosoft/deploy/lxc/$f"
  done
  INSTALL_ENV="DOMAIN=${DOMAIN} API_PORT=${API_PORT} REPO_URL=${REPO_URL} BRANCH=${BRANCH}"
fi

log "Lancement de l'installation dans le conteneur…"
# shellcheck disable=SC2086
pct exec "$CTID" -- env $INSTALL_ENV bash /opt/osteosoft/deploy/lxc/install.sh

# ── Résumé ───────────────────────────────────────────────────────────────────
CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
log "Terminé. Conteneur $CTID prêt."
echo "  • Accès       : http://${CT_IP:-<ip>}:${API_PORT}/"
echo "  • Shell       : pct enter ${CTID}"
echo "  • Logs API    : pct exec ${CTID} -- journalctl -u osteosoft-api -f"
echo "  • Secrets/.env: /opt/osteosoft/.env (dans le conteneur) — sauvegardez OSTEOSOFT_DATA_KEY !"
