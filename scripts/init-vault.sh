#!/usr/bin/env bash
# One-time setup of a vault instance. Run as root:
#   scripts/init-vault.sh <instance> <git-remote-url> [dashboard-port]
# e.g.
#   scripts/init-vault.sh vault gitea@gitea.netbird.cloud:lucaslad/Obsidian-Vault.git 3001
# (for Gitea use the NetBird host and the gitea user; the host key must already
# be in /root/.ssh/known_hosts).
#
# 1. Clones without checking out, then refuses (and cleans up) if the disk
#    cannot hold the files plus headroom — nothing in the vault is read.
# 2. Checks out, then puts the bridge block at the top of .stignore (keeping
#    any committed .stignore lines) BEFORE Syncthing is told about the folder,
#    so .git is never indexed or offered to the phone.
# 3. Registers Syncthing folder "<instance>" and writes instances/<instance>.env.
# Start it with: systemctl enable --now git-syncthing-bridge@<instance>
set -euo pipefail

NAME=${1:?usage: init-vault.sh <instance> <git-remote-url> [dashboard-port]}
REMOTE=${2:?usage: init-vault.sh <instance> <git-remote-url> [dashboard-port]}
PORT=${3:-3001}
VAULT=/opt/vault/$NAME
BRIDGE=/opt/git-syncthing-bridge
ENVFILE=$BRIDGE/instances/$NAME.env
ST_CONFIG=/root/.local/state/syncthing/config.xml
API=http://127.0.0.1:8384
HEADROOM_GB=${HEADROOM_GB:-4}   # repacks, Syncthing versions, growth

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $NAME =~ ^[a-z0-9-]+$ ]] || { echo "instance name: lowercase letters, digits, dashes" >&2; exit 1; }
[[ -e $VAULT ]] && { echo "$VAULT already exists — refusing to touch it" >&2; exit 1; }
[[ -e $ENVFILE ]] && { echo "$ENVFILE already exists — refusing to touch it" >&2; exit 1; }

KEY=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$ST_CONFIG")
st() { curl -fsS -H "X-API-Key: $KEY" "$@"; }
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1024^3 }'; }

echo "==> Cloning $REMOTE (history only, no files yet)"
install -d /opt/vault
GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' git clone --no-checkout "$REMOTE" "$VAULT"
cd "$VAULT"

# Size of the files a checkout would write, summed from the tree (names are not printed).
WORKTREE=$(git ls-tree -r -l HEAD 2>/dev/null | awk '$4 ~ /^[0-9]+$/ { s += $4 } END { print s + 0 }')
FREE=$(( $(stat -f -c '%a * %S' . ) ))
NEED=$(( WORKTREE + HEADROOM_GB * 1024 * 1024 * 1024 ))
echo "    history $(gb "$(du -sb .git | cut -f1)") GB, files $(gb "$WORKTREE") GB, free $(gb "$FREE") GB"
if (( FREE < NEED )); then
  echo "Not enough disk: need $(gb $NEED) GB free for the files plus ${HEADROOM_GB} GB headroom." >&2
  echo "Removing the partial clone. Grow the disk and run again." >&2
  cd / && rm -rf "$VAULT"
  exit 1
fi

echo "==> Checking out files"
git symbolic-ref HEAD refs/heads/main 2>/dev/null || true   # empty remote
if git rev-parse -q --verify HEAD >/dev/null; then git checkout -q; fi

# Syncthing has not been told about this folder yet, so it cannot scan .git
# before this runs. The bridge block goes first (Syncthing applies the first
# matching pattern); lines from a .stignore committed in the repo stay below it.
echo "==> Writing .stignore"
BLOCK=$(cat <<'IGN'
// >>> git-syncthing-bridge (managed block — edits inside it are overwritten)
// The git repo stays on the server.
/.git
// Phone and repo keep separate Obsidian plugins and settings.
/.obsidian
// <<< git-syncthing-bridge
IGN
)
if [[ -e .stignore ]]; then
  { echo "$BLOCK"; echo; grep -vxF -f <(echo "$BLOCK") .stignore || true; } > .stignore.new
else
  echo "$BLOCK" > .stignore.new
fi
mv .stignore.new .stignore
grep -qx '/.git' .stignore || { echo ".stignore lost /.git — aborting before Syncthing sees the folder" >&2; exit 1; }

git config user.name 'Vault Sync Daemon'
git config user.email 'vault-daemon@localhost'
git config core.quotepath off

echo "==> Registering Syncthing folder '$NAME'"
SELF=$(st "$API/rest/system/status" | sed -n 's/.*"myID": *"\([^"]*\)".*/\1/p')
st -X POST -H 'Content-Type: application/json' "$API/rest/config/folders" -d @- >/dev/null <<JSON
{
  "id": "$NAME", "label": "Obsidian ($NAME)", "path": "$VAULT", "type": "sendreceive",
  "fsWatcherEnabled": true, "fsWatcherDelayS": 10, "rescanIntervalS": 3600,
  "devices": [{ "deviceID": "$SELF" }],
  "versioning": { "type": "staggered", "params": { "maxAge": "2592000", "cleanInterval": "3600" },
                  "cleanupIntervalS": 3600, "fsPath": "", "fsType": "basic" }
}
JSON

echo "==> Writing $ENVFILE"
install -d -m 700 "$BRIDGE/instances"
PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
sed -e "s|^VAULT_PATH=.*|VAULT_PATH=$VAULT|" \
    -e "s|^SYNCTHING_FOLDER_ID=.*|SYNCTHING_FOLDER_ID=$NAME|" \
    -e "s|^DASHBOARD_PORT=.*|DASHBOARD_PORT=$PORT|" \
    -e "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$PW|" \
    -e "s|^INSTANCE_NAME=.*|INSTANCE_NAME=$NAME|" \
    "$BRIDGE/.env.example" > "$ENVFILE"
chmod 600 "$ENVFILE"

echo
echo "Done. Next:"
echo "  1. systemctl enable --now git-syncthing-bridge@$NAME && journalctl -fu git-syncthing-bridge@$NAME"
echo "  2. Dashboard: http://syncthing.netbird.cloud:$PORT (user admin, password in $ENVFILE)"
echo "  3. Share folder '$NAME' with the phone in the Syncthing GUI, then on the phone"
echo "     set the ignore patterns listed in 'Vault Sync Status.md'."
