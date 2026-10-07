# Syncthing Server — Directory Map

## Services

| Service | Runs As | Config |
|---|---|---|
| Syncthing | root | `/root/.local/state/syncthing/config.xml` |
| Git-Syncthing Bridge | root | `/opt/git-syncthing-bridge/.env` |

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

- Runs on port 3000 (configurable via `DASHBOARD_PORT` in `.env`)
- URL: http://<server-ip>:3000
- Start: `cd /opt/git-syncthing-bridge && npm start`

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
- Gitea (for vault repo access)
