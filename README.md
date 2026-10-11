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
5. **Replay onto the remote** if it moved: a rebase done in memory with
   `git merge-tree`, one local commit at a time, so the working tree is written
   once at the end. Conflicts never stop syncing; they are resolved like this:
   - **Note edited on both sides:** merged line by line. Where both changed the
     same lines, `*.md merge=union` keeps both versions (remote first), so you
     may see a paragraph twice and tidy it up by hand.
   - **Other file changed on both sides** (photo, JSON, a note without the union
     rule): both kept. This vault's version keeps the name; the remote's is saved
     as `<name> (remote conflict YYYY-MM-DD HHMM).<ext>` and committed.
   - **Edited on one side, deleted on the other:** the edited file is kept.
   - **Renamed vs deleted, or renamed differently:** every name git left is kept.

   Each resolution is logged, listed on the dashboard, and written into the
   replayed commit's message under `Merged onto remote <hash>`. Syncthing is
   paused only while files are rewritten. History stays linear.
6. **Push.**

## Commit messages

```
vault: 2026-10-09 (S24Ultra: 1 created, 2 edited)

Changed on: S24Ultra (3 files)
A = created, M = edited, D = deleted, R = renamed

A	Pantheon.md	[S24Ultra]
M	001-Home/Logs/Movie Log.md	[S24Ultra]
```

The device comes from Syncthing's change events (`server` for changes made on
the server itself); `DEVICE_NAMES=SM-S928U=S24Ultra` renames devices in commit
messages and logs. Files with no event (e.g. changed while the bridge was down)
have no tag.

`COMMIT_MODE=daily` (default) keeps one commit per day, `vault: YYYY-MM-DD (…)`,
amended locally through the day and pushed after midnight. Pushed history is
never rewritten. "Push now" on the dashboard pushes today's commit early.
`COMMIT_MODE=immediate` commits and pushes every cycle.

## Managed vault files

- `.nomedia` — empty; keeps vault photos out of the Android gallery / Google Photos.
- `.gitignore` — a managed block for Syncthing internals, conflict copies and
  Obsidian workspace files. Lines outside the block are yours.
- `.gitattributes` — a managed block with `*.md merge=union` so notes edited on
  two devices merge instead of conflicting. Committed, so other devices that
  push to the remote (e.g. Obsidian Git on a desktop) merge the same way. The
  dashboard flags it if missing or overridden.
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
- Logs go to journald: `journalctl -u git-syncthing-bridge@<name> -f`.
- Alerts (`NOTIFY_URL`, ntfy-compatible): sent when a problem starts, once a day
  while it lasts, and when it resolves. Remote outages alert only after an hour.

## Dashboard

`http://<DASHBOARD_HOST>:<DASHBOARD_PORT>` with HTTP basic auth
(`DASHBOARD_USER` / `DASHBOARD_PASSWORD`; disabled without a password).
Bind it to the NetBird address or `127.0.0.1`, never `0.0.0.0`.

## Setup

Each vault is its own instance: a Syncthing folder, a clone under
`/opt/vault/<name>`, settings in `instances/<name>.env`, its own dashboard port,
and a `git-syncthing-bridge@<name>` systemd service.

```sh
apt install nodejs git                  # Node >= 20.3
cd /opt/git-syncthing-bridge && npm ci --omit=dev
cp deploy/git-syncthing-bridge@.service /etc/systemd/system/ && systemctl daemon-reload

# per vault (refuses if the disk cannot hold it with headroom)
scripts/init-vault.sh <name> <git-remote-url> <dashboard-port>
systemctl enable --now git-syncthing-bridge@<name>
journalctl -fu git-syncthing-bridge@<name>
```

The remote's SSH host key must already be in `~/.ssh/known_hosts`. Then share
the folder with the phone in the Syncthing GUI and set the phone's ignore
patterns from `Vault Sync Status.md`.

## Tests

`node --test test/merge.test.js` tests commit messages and every conflict
resolution against throwaway repos in a temp dir; no Syncthing needed.

`test/scenario.sh` runs the bridge against a throwaway vault and bare remote
under `/opt/vault-test`: live edits, bursts, remote rebase, conflict copies, a real
divergence (auto-merged), large files, stale lock recovery and daily amend.
