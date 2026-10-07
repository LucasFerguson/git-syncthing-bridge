# git-syncthing-bridge

Keeps an Obsidian vault that Syncthing syncs with a phone committed and pushed
to a git remote (GitHub or Gitea), and pulls remote changes back in.

```
Phone (Obsidian) ⇄ Syncthing ⇄ /opt/vault/obsidian-vault ⇄ bridge ⇄ git remote
```

## How a sync cycle works

A cycle runs when Syncthing reports the folder idle (after a `DEBOUNCE_MS`
quiet period), every `PULL_INTERVAL_MS`, on startup, and from the dashboard.
Cycles never overlap: a request during a cycle makes it run once more afterwards.

1. **Settled?** Skip unless the folder is `idle` with nothing left to pull.
2. **Conflict copies.** `*.sync-conflict-*` files trigger an alert. They are
   git-ignored and never committed. With `CONFLICT_POLICY=block` the cycle stops here.
3. **Commit** everything else, photos included. Untracked files over
   `MAX_FILE_MB` go to `.git/info/exclude` instead (GitHub rejects files over 100 MB).
4. **Fetch.**
5. **Rebase** onto the remote if it moved. A conflict is predicted with
   `git merge-tree` first. If one is found, nothing is touched: local commits
   continue, pushes wait, and you get an alert. No union merge, so text is never
   silently duplicated. Syncthing is paused only while the rebase rewrites files.
6. **Push.**

`COMMIT_MODE=daily` (default) keeps one commit per day, `vault: YYYY-MM-DD`,
amended locally through the day and pushed after midnight. Pushed history is
never rewritten. "Push now" on the dashboard pushes today's commit early.
`COMMIT_MODE=immediate` commits and pushes every cycle.

## Managed vault files

- `.nomedia` — empty; keeps vault photos out of the Android gallery / Google Photos.
- `.gitignore` — a managed block for Syncthing internals, conflict copies and
  Obsidian workspace files. Lines outside the block are yours.
- `.stignore` — must contain `/.git` and must **not** list `sync-conflict` files,
  or phone-side conflicts never reach the server.

## Reliability

- Startup: aborts interrupted rebases/merges, removes stale `index.lock`,
  un-pauses a folder left paused by a crash, then runs a full cycle.
- Syncthing: every request has a timeout; the event stream reconnects with
  backoff and detects Syncthing restarts.
- git: never prompts, never trusts unknown SSH host keys, times out.
- Crashes exit non-zero and systemd restarts the service. A config error exits
  78 and is not retried.
- Logs go to journald: `journalctl -u git-syncthing-bridge -f`.
- Alerts (`NOTIFY_URL`, ntfy-compatible): sent when a problem starts, once a day
  while it lasts, and when it resolves. Remote outages alert only after an hour.

## Dashboard

`http://<DASHBOARD_HOST>:<DASHBOARD_PORT>` with HTTP basic auth
(`DASHBOARD_USER` / `DASHBOARD_PASSWORD`; disabled without a password).
Bind it to the NetBird address or `127.0.0.1`, never `0.0.0.0`.

## Setup

```sh
apt install nodejs git                  # Node >= 20.3
cd /opt/git-syncthing-bridge && npm ci --omit=dev
cp .env.example .env && chmod 600 .env  # set DASHBOARD_PASSWORD, NOTIFY_URL
scripts/init-vault.sh <git-remote-url>  # clone, write .stignore, add Syncthing folder
cp deploy/git-syncthing-bridge.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now git-syncthing-bridge
```

The remote's SSH host key must already be in `~/.ssh/known_hosts`. Then share
the folder with the phone in the Syncthing GUI.

## Tests

`test/scenario.sh` runs the bridge against a throwaway vault and bare remote
under `/opt/vault-test`: live edits, bursts, remote rebase, conflict copies, a real
divergence, large files, stale lock recovery and daily amend.
