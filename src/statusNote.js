import { writeFile } from 'fs/promises';
import { join } from 'path';
import config from './config.js';
import { log } from './logger.js';

// A note inside the vault that the bridge rewrites right before each commit,
// so it lands in git and reaches the phone through Syncthing. It shows when the
// vault was last committed/pushed and carries the phone-side setup (a device's
// .stignore is never synced, so the phone needs its own copy of the patterns).
// Only rewritten when something else changed, so it never causes a commit itself.

const fmt = d => d
  ? new Date(d).toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    })
  : 'not yet';

function phoneIgnores() {
  return [
    ...(config.syncthingIgnoreObsidian ? ['// Keep this phone\'s Obsidian plugins and settings to itself', '/.obsidian'] : []),
    '// The git repo never leaves the server (harmless safety net)',
    '/.git',
  ].join('\n');
}

function render({ committedAt, lastPushAt }) {
  const pushRule = config.commitMode === 'daily'
    ? 'Once a day: all of a day\'s changes form one commit, pushed shortly after midnight.'
    : 'Right after every commit.';
  return `---
managed-by: git-syncthing-bridge
---
# Vault Sync Status

> [!info] This note is rewritten automatically by the sync server. Edits here are overwritten.

## Status
| | |
|---|---|
| **Last committed** | ${fmt(committedAt)} |
| **Last pushed (before that commit)** | ${fmt(lastPushAt)} |
| **When changes are pushed** | ${pushRule} |

If **Last committed** is older than your latest edits plus a minute or two, the
server has not picked them up yet — check that Syncthing on the phone is connected.

## What this is
This vault is synced phone ⇄ server by Syncthing. On the server,
*git-syncthing-bridge* commits every change to git and pushes it to the remote,
and pulls in changes made elsewhere (e.g. on a desktop).

## Phone setup: Syncthing ignore patterns
Ignore patterns are per device and are **not** synced, so set them on the phone too:
Syncthing app → this folder → **Ignore patterns**, paste:

\`\`\`
${phoneIgnores()}
\`\`\`

Do **not** add \`*.sync-conflict-*\` (or any pattern matching it). Conflict copies
must reach the server so it can warn you about them.

## Tips
- A file named \`… .sync-conflict-<date>-<id>.md\` means the same note was changed
  on two devices at once. Merge what you need into the original note and delete the
  conflict copy. They are never committed to git.
- Dashboard (on NetBird): http://syncthing.netbird.cloud:${config.dashboardPort}
`;
}

export async function writeStatusNote(info) {
  if (!config.statusNote) return;
  await writeFile(join(config.vaultPath, config.statusNote), render(info));
  log.debug('Updated status note');
}
