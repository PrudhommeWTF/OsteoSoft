#!/usr/bin/env bash
# ============================================================================
# OsteoSoft : mise a jour en un clic, executee EN ROOT par systemd.
#
# Declenchee par l'unite osteosoft-update.path lorsque le service (non
# privilegie) depose server/data/.update-trigger (contenu : tag=vX.Y.Z). Ne pas
# lancer a la main en temps normal : pour une mise a jour manuelle, utiliser
# deploy/lxc/install.sh.
#
# Deroule :
#   1. lit et REVALIDE le tag (frontiere de privilege), refuse tout retour arriere ;
#   2. telecharge l'archive du tag depuis GitHub et verifie sa version ;
#   3. compile a part (service toujours en marche) ;
#   4. arrete le service, SAUVEGARDE la base et le code en place ;
#   5. remplace le code (.env et server/data preserves), redemarre ;
#   6. verifie que la nouvelle version repond ; sinon RETOUR ARRIERE automatique
#      (ancien code ET ancienne base, les migrations eventuelles sont annulees).
# La progression est ecrite dans server/data/update-status.json (lu par l'interface).
#
# Regles de securite (le dossier de l'application appartient au service) :
#   - rien n'est EXECUTE depuis le dossier de l'application : on compile dans un
#     dossier root temporaire, et on ne relit le .env qu'en texte (jamais source) ;
#   - toute ecriture dans server/data se fait avec les droits du service
#     (runuser), pour qu'un lien symbolique n'y detourne pas une ecriture root ;
#   - le journal est dans /var/log/osteosoft, les sauvegardes dans
#     /var/backups/osteosoft (dossiers root, 0700).
# ============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/osteosoft}"
SERVICE_USER="${APP_USER:-osteosoft}"
SERVICE_NAME="${SERVICE_NAME:-osteosoft-api}"
LOG_DIR="${LOG_DIR:-/var/log/osteosoft}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/osteosoft}"
WORK_ROOT="${WORK_ROOT:-/var/tmp}"
LOCK_FILE="${LOCK_FILE:-/run/osteosoft-update.lock}"
HELPER_PATH="${HELPER_PATH:-/usr/local/sbin/osteosoft-self-update.sh}"
KEEP_BACKUPS="${KEEP_BACKUPS:-2}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
MIN_FREE_MB="${MIN_FREE_MB:-1500}"

ENV_FILE="${APP_DIR}/.env"
DATA_DIR="${APP_DIR}/server/data"
TRIGGER="${DATA_DIR}/.update-trigger"
STATUS="${DATA_DIR}/update-status.json"
LOG="${LOG_DIR}/update.log"
DB_FILES=(osteo.db osteo.db-wal osteo.db-shm)

# Meme regle que isValidReleaseTag (server/lib/self-update.mjs).
TAG_RE='^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true
export NG_CLI_ANALYTICS=false DEBIAN_FRONTEND=noninteractive
export HOME="${HOME:-/root}"

STEP="Préparation"
PHASE="preparation"   # preparation | swapped
CURRENT=""
TAG=""
BK=""
WORK=""
LOG_START=0

# ── Outils ───────────────────────────────────────────────────────────────────

# Execute une commande avec les droits du service (ecritures dans server/data).
as_service() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    "$@"
  else
    runuser -u "$SERVICE_USER" -- "$@"
  fi
}

# JSON sur une ligne, sans caractere de controle, tronque AVANT l'echappement
# (couper apres pourrait sectionner un « \" »), UTF-8 valide.
json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | head -c 300 \
    | iconv -c -f UTF-8 -t UTF-8 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

status() {
  local line
  line="$(printf '{"state":"%s","message":"%s","ts":%s000}' "$1" "$(json_escape "$2")" "$(date +%s)")"
  printf '%s\n' "$line" | as_service tee "$STATUS" >/dev/null 2>&1 || true
}

step() {
  STEP="$1"
  echo "[$(date '+%F %T')] ${STEP}"
  status running "$2"
}

# Lit UNE variable du .env en texte, sans jamais l'executer (le fichier
# appartient au service : le sourcer en root lui donnerait root).
read_env() {
  local key="$1" default="$2" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r')"
  value="${value%\"}"; value="${value#\"}"
  printf '%s' "${value:-$default}"
}

# Version d'un package.json, lue en JSON (aucun code du fichier n'est execute).
package_version() {
  node -e 'try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(p.version || "")); } catch { process.stdout.write(""); }' "$1"
}

# Code de sortie 0 si $1 est STRICTEMENT plus recente que $2 (semver,
# preversions comprises : 1.3.0-rc.1 < 1.3.0). Meme logique que releases.mjs.
is_newer() {
  node -e '
    const split = (v) => {
      const s = String(v || "").trim().replace(/^v/, "").split("+")[0];
      const d = s.indexOf("-");
      const core = d < 0 ? s : s.slice(0, d);
      const pre = d < 0 ? [] : s.slice(d + 1).split(".").filter(Boolean);
      const num = core.split(".").map((n) => parseInt(n, 10) || 0);
      return { num: [num[0] || 0, num[1] || 0, num[2] || 0], pre };
    };
    const cmp = (a, b) => {
      const pa = split(a), pb = split(b);
      for (let i = 0; i < 3; i++) if (pa.num[i] !== pb.num[i]) return pa.num[i] - pb.num[i];
      if (!pa.pre.length && !pb.pre.length) return 0;
      if (!pa.pre.length) return 1;
      if (!pb.pre.length) return -1;
      for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i], y = pb.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; continue; }
        if (nx !== ny) return nx ? -1 : 1;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    };
    process.exit(cmp(process.argv[1], process.argv[2]) > 0 ? 0 : 1);
  ' "$1" "$2"
}

# Supprime le code en place, en gardant .env et server/data.
purge_code() {
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name server -exec rm -rf {} +
  if [ -d "$APP_DIR/server" ] && [ ! -L "$APP_DIR/server" ]; then
    find "$APP_DIR/server" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  fi
}

# Copie un arbre de code dans APP_DIR (hors .env et server/data).
copy_code_from() {
  tar -C "$1" --exclude='./.env' --exclude='./server/data' --exclude='./.angular' -cf - . | tar -C "$APP_DIR" -xf -
}

fix_ownership() {
  chown -R -h "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
}

# Attend que le service reponde ET annonce la version attendue.
wait_health() {
  local expected="${1#v}" port body version waited=0
  port="$(read_env API_PORT 4199)"
  [[ "$port" =~ ^[0-9]{2,5}$ ]] || port=4199
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
    version="$(printf '%s' "$body" | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
    if [ -n "$version" ] && [ "$version" = "$expected" ]; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

last_log_line() {
  tail -n "+$((LOG_START + 1))" "$LOG" 2>/dev/null \
    | grep -vE '^[[:space:]]*$|^=+$|^\[[0-9-]+ [0-9:]+\] ' | tail -n1
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

rollback() {
  echo "Retour arrière vers ${CURRENT} (code et base)."
  systemctl stop "$SERVICE_NAME" || true
  purge_code
  tar -C "$APP_DIR" -xf "$BK/code.tar"
  local f
  for f in "${DB_FILES[@]}"; do
    rm -f "$DATA_DIR/$f"
    if [ -e "$BK/data/$f" ] || [ -L "$BK/data/$f" ]; then
      cp -P "$BK/data/$f" "$DATA_DIR/$f"
    fi
  done
  fix_ownership
  systemctl start "$SERVICE_NAME" || true
  wait_health "$CURRENT"
}

# Echec : explique l'etape et la derniere ligne du journal. Si le code a deja
# ete remplace, restaure l'ancien code et l'ancienne base.
fail() {
  local why="${1:-Échec pendant « ${STEP} »}" last
  last="$(last_log_line)"
  echo "[$(date '+%F %T')] ERREUR : ${why}${last:+ | ${last}}"
  if [ "$PHASE" = "swapped" ]; then
    if rollback; then
      status error "${why}. Version ${CURRENT} restaurée (code et base). Sauvegarde : ${BK}"
    else
      status error "${why}. RETOUR ARRIÈRE INCOMPLET : intervention manuelle requise. Sauvegarde : ${BK}, journal : ${LOG}"
    fi
  elif [ "$PHASE" = "stopped" ]; then
    systemctl start "$SERVICE_NAME" || true
    status error "${why}${last:+ : ${last}}"
  else
    status error "${why}${last:+ : ${last}}"
  fi
  cleanup
  exit 1
}

# ── Deroule ──────────────────────────────────────────────────────────────────
main() {
  mkdir -p "$LOG_DIR" && chmod 0750 "$LOG_DIR"
  touch "$LOG"
  LOG_START="$(wc -l < "$LOG")"
  exec >>"$LOG" 2>&1

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "Une mise à jour est déjà en cours : déclenchement ignoré."
    exit 0
  fi

  echo "=========================================="
  echo "[$(date '+%F %T')] Mise à jour OsteoSoft : début"

  # 1. Declencheur : lu avec les droits du service, puis supprime.
  local raw
  raw="$(as_service head -c 200 "$TRIGGER" 2>/dev/null | head -n1 | tr -d '\r' || true)"
  rm -f "$TRIGGER"
  TAG="${raw#tag=}"
  if [ "$raw" = "$TAG" ] || ! [[ "$TAG" =~ $TAG_RE ]]; then
    fail "Déclencheur invalide (tag de version attendu)"
  fi

  CURRENT="$(package_version "$APP_DIR/package.json")"
  [ -n "$CURRENT" ] || fail "Version en service illisible (${APP_DIR}/package.json)"
  if ! is_newer "$TAG" "$CURRENT"; then
    fail "Refusé : ${TAG} n'est pas plus récente que la version en service (${CURRENT})"
  fi
  echo "Version en service : ${CURRENT} ; version demandée : ${TAG}"

  local repo token
  repo="$(read_env OSTEOSOFT_GITHUB_REPO PrudhommeWTF/OsteoSoft)"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || repo="PrudhommeWTF/OsteoSoft"
  token="$(read_env OSTEOSOFT_GITHUB_TOKEN '')"
  [[ -z "$token" || "$token" =~ ^[A-Za-z0-9_]+$ ]] || token=""

  # 2. Telechargement dans un dossier root (jamais dans le dossier du service).
  local free_mb
  free_mb="$(df -Pm "$WORK_ROOT" | awk 'NR==2 {print $4}')"
  if [ -n "$free_mb" ] && [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
    fail "Espace disque insuffisant dans ${WORK_ROOT} (${free_mb} Mo libres, ${MIN_FREE_MB} requis)"
  fi
  WORK="$(mktemp -d -p "$WORK_ROOT" osteosoft-update.XXXXXX)" || fail "Dossier de travail impossible à créer"
  local src="$WORK/src" url
  mkdir -p "$src"

  step "Téléchargement" "Téléchargement de ${TAG}…"
  local auth=()
  if [ -n "$token" ]; then
    auth=(-H "Authorization: Bearer ${token}")
    url="https://api.github.com/repos/${repo}/tarball/${TAG}"
  else
    url="https://codeload.github.com/${repo}/tar.gz/refs/tags/${TAG}"
  fi
  if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 -H 'User-Agent: OsteoSoft' "${auth[@]}" "$url" \
       | tar -xz -C "$src" --strip-components=1; then
    rm -rf "$src"
    local gitc=()
    [ -n "$token" ] && gitc=(-c "http.extraHeader=Authorization: Bearer ${token}")
    git "${gitc[@]}" clone --depth 1 --branch "$TAG" "https://github.com/${repo}.git" "$src" \
      || fail "Téléchargement de ${TAG} impossible"
  fi
  [ -f "$src/package.json" ] || fail "Archive ${TAG} incomplète"
  local fetched
  fetched="$(package_version "$src/package.json")"
  [ "$fetched" = "${TAG#v}" ] || fail "Archive incohérente : package.json annonce ${fetched:-?} pour le tag ${TAG}"

  # 3. Compilation a part, service toujours en marche.
  step "Compilation" "Installation des dépendances et compilation de ${TAG}…"
  ( cd "$src" && npm ci ) || fail "Installation des dépendances impossible"
  ( cd "$src" && npm run build ) || fail "Compilation du frontend impossible"
  [ -f "$src/dist/OsteoSoft/browser/index.html" ] || fail "Compilation incomplète (dist/OsteoSoft/browser)"
  ( cd "$src" && npm prune --omit=dev ) || fail "Élagage des dépendances impossible"

  # 4. Arret et sauvegarde (base a froid : coherente).
  step "Sauvegarde" "Arrêt du service et sauvegarde de la base…"
  systemctl stop "$SERVICE_NAME" || fail "Arrêt du service impossible"
  PHASE="stopped"
  mkdir -p "$BACKUP_ROOT" && chmod 0700 "$BACKUP_ROOT"
  BK="${BACKUP_ROOT}/$(date +%Y%m%d-%H%M%S)-v${CURRENT}"
  mkdir -p "$BK/data" || fail "Dossier de sauvegarde impossible à créer"
  tar -C "$APP_DIR" --exclude='./.env' --exclude='./server/data' -cf "$BK/code.tar" . \
    || fail "Sauvegarde du code impossible"
  local f
  for f in "${DB_FILES[@]}"; do
    if [ -e "$DATA_DIR/$f" ] || [ -L "$DATA_DIR/$f" ]; then
      cp -P "$DATA_DIR/$f" "$BK/data/$f" || fail "Sauvegarde de la base impossible"
    fi
  done
  echo "Sauvegarde : ${BK}"

  # 5. Remplacement du code et redemarrage.
  step "Installation" "Installation de ${TAG}…"
  PHASE="swapped"
  purge_code
  copy_code_from "$src" || fail "Copie du nouveau code impossible"
  fix_ownership
  systemctl start "$SERVICE_NAME" || fail "Démarrage de ${TAG} impossible"

  # 6. Verification : la nouvelle version doit repondre.
  step "Vérification" "Vérification du démarrage de ${TAG}…"
  wait_health "$TAG" || fail "${TAG} ne répond pas après ${HEALTH_TIMEOUT} s"

  # Le script root lui-meme : remplace par renommage (bash lit son propre
  # fichier au fil de l'execution, l'ecraser en place serait dangereux).
  local fresh="$src/deploy/lxc/self-update.sh"
  if [ -f "$HELPER_PATH" ] && [ -f "$fresh" ] && ! cmp -s "$fresh" "$HELPER_PATH"; then
    install -m 0755 "$fresh" "${HELPER_PATH}.nouveau" && mv -f "${HELPER_PATH}.nouveau" "$HELPER_PATH" \
      && echo "Script de mise à jour actualisé : ${HELPER_PATH}"
  fi

  # Rotation des sauvegardes (les plus recentes gardees).
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -rf

  PHASE="done"
  status done "Mise à jour ${TAG} installée."
  echo "[$(date '+%F %T')] Mise à jour terminée : ${CURRENT} -> ${TAG}"
  cleanup
}

main "$@"
