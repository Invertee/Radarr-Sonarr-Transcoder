#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/Invertee/Radarr-Sonarr-Transcoder.git"
BRANCH="main"
INSTALL_DIR="/opt/transcode-manager"
DATA_DIR="/var/lib/transcode-manager"
CACHE_DIR="/var/cache/transcode-manager"
LOG_DIR="/var/log/transcode-manager"
ENV_FILE="/etc/transcode-manager.env"
SERVICE_NAME="transcode-manager"
PORT="5000"
APP_USER="${SUDO_USER:-}"
AUTO_UPDATE=1
INSTALL_PACKAGES=1

usage() {
  cat <<'USAGE'
Usage: sudo ./install.sh [options]

Options:
  --user USER          Account that can read and replace the media files.
  --repo-url URL       Git repository to deploy.
  --branch BRANCH      Branch to track (default: main).
  --install-dir PATH   Application checkout (default: /opt/transcode-manager).
  --data-dir PATH      SQLite data directory.
  --cache-dir PATH     FFmpeg temporary output directory.
  --log-dir PATH       Application log directory.
  --port PORT          HTTP port (default: 5000).
  --no-auto-update     Do not install the five-minute deployment timer.
  --skip-packages      Do not install OS packages or Node.js.
  -h, --help           Show this help.
USAGE
}

log() {
  printf '[transcode-manager] %s\n' "$*"
}

fail() {
  printf '[transcode-manager] ERROR: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      APP_USER="${2:-}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="${2:-}"
      shift 2
      ;;
    --cache-dir)
      CACHE_DIR="${2:-}"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --no-auto-update)
      AUTO_UPDATE=0
      shift
      ;;
    --skip-packages)
      INSTALL_PACKAGES=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ ${EUID} -eq 0 ]] || fail 'Run this installer with sudo or as root.'
[[ -n "$REPO_URL" ]] || fail 'Repository URL cannot be empty.'
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail 'Branch contains unsupported characters.'
[[ "$PORT" =~ ^[0-9]+$ ]] || fail 'Port must be numeric.'
(( PORT >= 1 && PORT <= 65535 )) || fail 'Port must be between 1 and 65535.'

if [[ -z "$APP_USER" || "$APP_USER" == "root" ]]; then
  APP_USER="transcode-manager"
fi

install_os_packages() {
  command -v apt-get >/dev/null 2>&1 || fail 'This installer currently supports Debian and Ubuntu systems using apt.'
  export DEBIAN_FRONTEND=noninteractive

  log 'Installing system packages.'
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates \
    cifs-utils \
    curl \
    ffmpeg \
    git \
    util-linux \
    vainfo

  if apt-cache show intel-media-va-driver-non-free >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends intel-media-va-driver-non-free
  elif apt-cache show intel-media-va-driver >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends intel-media-va-driver
  else
    log 'WARNING: No Intel media VAAPI driver package was found in the configured apt repositories.'
  fi
}

node_version_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 24 || (major === 24 && minor >= 15) ? 0 : 1);
  '
}

ensure_node() {
  if node_version_is_supported; then
    log "Using Node.js $(node --version)."
    return
  fi

  log 'Installing Node.js 24 LTS from NodeSource.'
  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup_script"
  bash "$setup_script"
  rm -f "$setup_script"
  apt-get install -y nodejs

  node_version_is_supported || fail 'Node.js 24.15 or newer is required.'
}

if (( INSTALL_PACKAGES == 1 )); then
  install_os_packages
  ensure_node
else
  command -v node >/dev/null 2>&1 || fail 'Node.js is not installed.'
  node_version_is_supported || fail 'Node.js 24.15 or newer is required.'
  command -v npm >/dev/null 2>&1 || fail 'npm is not installed.'
  command -v ffmpeg >/dev/null 2>&1 || fail 'FFmpeg is not installed.'
  command -v ffprobe >/dev/null 2>&1 || fail 'ffprobe is not installed.'
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating system account $APP_USER."
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
APP_GROUP="$(id -gn "$APP_USER")"

for hardware_group in video render; do
  if getent group "$hardware_group" >/dev/null 2>&1; then
    usermod -aG "$hardware_group" "$APP_USER"
  fi
done

for directory in "$DATA_DIR" "$CACHE_DIR" "$LOG_DIR"; do
  install -d -m 0775 -o "$APP_USER" -g "$APP_GROUP" "$directory"
done

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing checkout in $INSTALL_DIR."
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
  git -C "$INSTALL_DIR" fetch --prune origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
elif [[ -e "$INSTALL_DIR" ]]; then
  backup_path="${INSTALL_DIR}.backup-$(date +%Y%m%d%H%M%S)"
  log "Moving the existing non-Git directory to $backup_path."
  mv "$INSTALL_DIR" "$backup_path"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
else
  log "Cloning $REPO_URL into $INSTALL_DIR."
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

chown -R root:root "$INSTALL_DIR"
git config --global --add safe.directory "$INSTALL_DIR" >/dev/null 2>&1 || true

log 'Installing Node.js dependencies.'
cd "$INSTALL_DIR"
npm install --omit=dev --no-package-lock --no-audit --no-fund
npm run ci

if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating $ENV_FILE."
  cat > "$ENV_FILE" <<ENVIRONMENT
NODE_ENV=production
HOST=0.0.0.0
PORT=$PORT

DATA_DIR=$DATA_DIR
CACHE_DIR=$CACHE_DIR
LOG_DIR=$LOG_DIR

SONARR_URL=http://127.0.0.1:8989
SONARR_API_KEY=
RADARR_URL=http://127.0.0.1:7878
RADARR_API_KEY=

SONARR_PATH_FROM=
SONARR_PATH_TO=
RADARR_PATH_FROM=
RADARR_PATH_TO=

DEFAULT_PROFILE=medium
VAAPI_DEVICE=/dev/dri/renderD128
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
AUDIO_BITRATE=192k
ARR_TIMEOUT_MS=10000
QUEUE_POLL_MS=1000
LOG_MAX_BYTES=5242880
ENVIRONMENT
  chmod 0600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
else
  log "Keeping the existing configuration in $ENV_FILE."
fi

read_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

configured_value="$(read_env_value PORT)"
if [[ "$configured_value" =~ ^[0-9]+$ ]] && (( configured_value >= 1 && configured_value <= 65535 )); then
  PORT="$configured_value"
fi
configured_value="$(read_env_value DATA_DIR)"
[[ -n "$configured_value" ]] && DATA_DIR="$configured_value"
configured_value="$(read_env_value CACHE_DIR)"
[[ -n "$configured_value" ]] && CACHE_DIR="$configured_value"
configured_value="$(read_env_value LOG_DIR)"
[[ -n "$configured_value" ]] && LOG_DIR="$configured_value"

for directory in "$DATA_DIR" "$CACHE_DIR" "$LOG_DIR"; do
  install -d -m 0775 -o "$APP_USER" -g "$APP_GROUP" "$directory"
done

NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE_UNIT
[Unit]
Description=Sonarr and Radarr Transcode Manager
Wants=network-online.target
After=network-online.target local-fs.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillSignal=SIGTERM
UMask=0002
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
SERVICE_UNIT

cat > "/usr/local/sbin/${SERVICE_NAME}-update" <<'UPDATE_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="__INSTALL_DIR__"
BRANCH="__BRANCH__"
SERVICE_NAME="__SERVICE_NAME__"
ENV_FILE="__ENV_FILE__"

log() {
  printf '[transcode-manager-update] %s\n' "$*"
}

exec 9>"/run/lock/${SERVICE_NAME}-update.lock"
flock -n 9 || exit 0

cd "$INSTALL_DIR"
git fetch --quiet --prune origin "$BRANCH"
OLD_SHA="$(git rev-parse HEAD)"
NEW_SHA="$(git rev-parse "origin/$BRANCH")"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  exit 0
fi

PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)"
PORT="${PORT:-5000}"
STATUS="$(curl -fsS --max-time 4 "http://127.0.0.1:${PORT}/api/status?compact=1" 2>/dev/null || true)"
if grep -Eq '"status":"(Processing|Skipping)"' <<<"$STATUS"; then
  log "Update $NEW_SHA is available, but a transcode is active. Deferring."
  exit 0
fi

rollback() {
  log "Rolling back to $OLD_SHA."
  git reset --hard "$OLD_SHA"
  git clean -fd
  npm install --omit=dev --no-package-lock --no-audit --no-fund
  systemctl restart "${SERVICE_NAME}.service"
}

log "Deploying $NEW_SHA from origin/$BRANCH."
if ! (
  git reset --hard "$NEW_SHA"
  git clean -fd
  npm install --omit=dev --no-package-lock --no-audit --no-fund
  npm run ci
); then
  log 'Validation failed.'
  rollback
  exit 1
fi

systemctl restart "${SERVICE_NAME}.service"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    log "Deployment completed: $NEW_SHA."
    exit 0
  fi
  sleep 1
done

log 'The updated service did not become healthy.'
rollback
exit 1
UPDATE_SCRIPT

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

sed -i \
  -e "s|__INSTALL_DIR__|$(escape_sed_replacement "$INSTALL_DIR")|g" \
  -e "s|__BRANCH__|$(escape_sed_replacement "$BRANCH")|g" \
  -e "s|__SERVICE_NAME__|$(escape_sed_replacement "$SERVICE_NAME")|g" \
  -e "s|__ENV_FILE__|$(escape_sed_replacement "$ENV_FILE")|g" \
  "/usr/local/sbin/${SERVICE_NAME}-update"
chmod 0755 "/usr/local/sbin/${SERVICE_NAME}-update"

cat > "/etc/systemd/system/${SERVICE_NAME}-update.service" <<UPDATE_SERVICE
[Unit]
Description=Deploy updates for Transcode Manager
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/${SERVICE_NAME}-update
UPDATE_SERVICE

cat > "/etc/systemd/system/${SERVICE_NAME}-update.timer" <<UPDATE_TIMER
[Unit]
Description=Check Transcode Manager main branch for updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true
Unit=${SERVICE_NAME}-update.service

[Install]
WantedBy=timers.target
UPDATE_TIMER

if systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -qx 'transcoder.service'; then
  log 'Stopping the legacy transcoder.service to release port 5000.'
  systemctl disable --now transcoder.service || true
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

if (( AUTO_UPDATE == 1 )); then
  systemctl enable --now "${SERVICE_NAME}-update.timer"
else
  systemctl disable --now "${SERVICE_NAME}-update.timer" >/dev/null 2>&1 || true
fi

if [[ ! -e /dev/dri/renderD128 ]]; then
  log 'WARNING: /dev/dri/renderD128 is not present. Configure VAAPI before running conversion jobs.'
fi

healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

if (( healthy == 0 )); then
  systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  fail "The service did not become healthy. Review: journalctl -u ${SERVICE_NAME}.service -n 100"
fi

log "Installation complete. Open http://<vm-address>:${PORT}/"
log "Configure Sonarr and Radarr keys in $ENV_FILE, then run: systemctl restart ${SERVICE_NAME}.service"
