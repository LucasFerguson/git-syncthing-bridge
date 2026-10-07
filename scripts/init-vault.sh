#!/usr/bin/env bash
# One-time vault setup. Run as root:
#   scripts/init-vault.sh <git-remote-url> [folder-id]
# For Gitea use the NetBird host and the gitea user, e.g.
#   scripts/init-vault.sh gitea@gitea.netbird.cloud:lucaslad/<repo>.git
# (the host key must already be in /root/.ssh/known_hosts).
# Clones the vault repo, writes .stignore BEFORE Syncthing
# ever scans the folder (so .git is never indexed or sent to the phone), then
# registers the folder with Syncthing and records its ID in .env.
set -euo pipefail

REMOTE=${1:?usage: init-vault.sh <git-remote-url> [folder-id]}
FOLDER_ID=${2:-obsidian-vault}
VAULT=/opt/vault/obsidian-vault
BRIDGE=/opt/git-syncthing-bridge
ST_CONFIG=/root/.local/state/syncthing/config.xml
API=http://127.0.0.1:8384

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -e $VAULT ]] && { echo "$VAULT already exists — refusing to touch it" >&2; exit 1; }

KEY=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$ST_CONFIG")
st() { curl -fsS -H "X-API-Key: $KEY" "$@"; }

echo "==> Cloning $REMOTE"
install -d /opt/vault
env GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' git clone "$REMOTE" "$VAULT"
cd "$VAULT"
git symbolic-ref HEAD refs/heads/main 2>/dev/null || true   # empty remote
git config user.name 'Vault Sync Daemon'
git config user.email 'vault-daemon@localhost'
git config core.quotepath off

echo "==> Writing .stignore"
# Same managed block the bridge maintains (it keeps lines outside the block).
# Must exist before Syncthing first scans, or .git would be indexed and offered to the phone.
{ cat <<'IGN'
// >>> git-syncthing-bridge (managed block — edits inside it are overwritten)
// The git repo stays on the server.
/.git
// Phone and repo keep separate Obsidian plugins and settings.
/.obsidian
// <<< git-syncthing-bridge
IGN
  if [[ -e .stignore ]]; then echo; cat .stignore; fi
} > .stignore.new && mv .stignore.new .stignore

echo "==> Registering Syncthing folder '$FOLDER_ID'"
SELF=$(st "$API/rest/system/status" | sed -n 's/.*"myID": *"\([^"]*\)".*/\1/p')
st -X POST -H 'Content-Type: application/json' "$API/rest/config/folders" -d @- <<JSON
{
  "id": "$FOLDER_ID", "label": "Obsidian Vault", "path": "$VAULT", "type": "sendreceive",
  "fsWatcherEnabled": true, "fsWatcherDelayS": 10, "rescanIntervalS": 3600,
  "devices": [{ "deviceID": "$SELF" }],
  "versioning": { "type": "staggered", "params": { "maxAge": "7776000", "cleanInterval": "3600" },
                  "cleanupIntervalS": 3600, "fsPath": "", "fsType": "basic" }
}
JSON

sed -i "s/^SYNCTHING_FOLDER_ID=.*/SYNCTHING_FOLDER_ID=$FOLDER_ID/" "$BRIDGE/.env"

echo
echo "Done. Next:"
echo "  1. Share folder '$FOLDER_ID' with the phone in the Syncthing GUI, then on the phone"
echo "     set the ignore patterns listed in 'Vault Sync Status.md'."
echo "  2. systemctl restart git-syncthing-bridge && journalctl -fu git-syncthing-bridge"
