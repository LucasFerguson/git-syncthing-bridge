# Syncthing Server — Directory Map

## Services

| Service | Runs As | Config |
|---|---|---|
| Syncthing | root | `/root/.local/state/syncthing/config.xml` |
| Git-Syncthing Bridge | root (systemd `git-syncthing-bridge`) | `/opt/git-syncthing-bridge/.env` |

## Key Directories

| Path | Purpose |
|---|---|
| `/opt/vault/obsidian-vault/` | Obsidian vault — git repo AND Syncthing folder (phone ↔ server) |
| `/opt/git-syncthing-bridge/` | Bridge daemon source code (cloned from GitHub) |
| `/root/.local/state/syncthing/` | Syncthing state & config |
| `/root/.nvm/` | Node Version Manager — Node.js installs live here |
| `/root/.ssh/` | SSH keys — `id_ed25519.pub` added to GitHub & Gitea |

## Syncthing

- GUI: http://<server-ip>:8384
- API: http://127.0.0.1:8384
- API key: see `/root/.local/state/syncthing/config.xml` → `<apikey>`

## Bridge Dashboard

- URL: http://syncthing.netbird.cloud:3000 (NetBird only; basic auth, user `admin`, password in `.env`)
- Service: `systemctl status git-syncthing-bridge`, logs: `journalctl -u git-syncthing-bridge -f`
- Test vault: `/opt/vault-test/vault` (Syncthing folder `gitea-test`, remote `gitea@gitea.netbird.cloud:lucaslad/temp-test-obsidian.git`) — temporary

## Vault Git Flow

```
Phone (Obsidian)
    ↕ Syncthing
/opt/vault/obsidian-vault/   ← Bridge watches this via Syncthing event API
    ↕ git push / pull
Gitea / GitHub remote repo
```

## SSH Key

Public key at `/root/.ssh/id_ed25519.pub` — added to:
- GitHub (LucasFerguson account)
- Gitea (for vault repo access) — SSH user is `gitea@`, use host `gitea.netbird.cloud` (its clone URLs show a LAN IP this server cannot reach)
