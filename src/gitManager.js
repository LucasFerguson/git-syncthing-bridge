import { execFile } from 'child_process';
import { readdir, stat, appendFile, rm, access } from 'fs/promises';
import { join } from 'path';
import config from './config.js';
import { log } from './logger.js';

const VAULT = config.vaultPath;
const GIT_DIR = join(VAULT, '.git');
const BRANCH = config.gitBranch;
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SUBJECT = 'vault: ';

// Never prompt, never trust an unknown host key, and give up on dead connections
// instead of hanging the daemon.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4',
};

// Run git; resolves with the exit code instead of throwing.
function run(args, timeoutMs = 120_000) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: VAULT, env: ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

// Run git; throws with stderr on a non-zero exit.
async function git(...args) {
  const r = await run(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

const exists = p => access(p).then(() => true, () => false);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, server-local time

async function tryRaw(args) {
  const r = await run(args);
  return r.code === 0 ? r.stdout.trim() : null;
}

const revParse = ref => tryRaw(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);

// ── Startup reconciliation ────────────────────────────────────────────────────

// Clean up whatever a crash or power loss left behind, so the first cycle
// starts from a normal state.
export async function reconcile() {
  await removeStaleLock(0);

  if (await exists(join(GIT_DIR, 'rebase-merge')) || await exists(join(GIT_DIR, 'rebase-apply'))) {
    log.warn('Found an interrupted rebase — aborting it');
    await git('rebase', '--abort');
  }
  if (await exists(join(GIT_DIR, 'MERGE_HEAD'))) {
    log.warn('Found an interrupted merge — aborting it');
    await git('merge', '--abort');
  }

  if (!(await git('remote')).split('\n').includes('origin')) throw new Error('Vault repo has no "origin" remote');

  // Settings that must hold regardless of how the repo was created.
  await git('config', 'core.quotepath', 'off');
  await git('config', 'rebase.autoStash', 'false');
  if (!(await tryRaw(['config', 'user.email']))) {
    await git('config', 'user.name', 'Vault Sync Daemon');
    await git('config', 'user.email', 'vault-daemon@localhost');
  }
}

// index.lock older than maxAgeMs belongs to a git process that died. At startup
// any lock is stale because the daemon is the only writer.
export async function removeStaleLock(maxAgeMs = 10 * 60 * 1000) {
  const lock = join(GIT_DIR, 'index.lock');
  try {
    const s = await stat(lock);
    if (Date.now() - s.mtimeMs >= maxAgeMs) {
      await rm(lock);
      log.warn('Removed stale .git/index.lock', { ageS: Math.round((Date.now() - s.mtimeMs) / 1000) });
    }
  } catch { /* no lock */ }
}

// ── Inspection ───────────────────────────────────────────────────────────────

export async function findConflictFiles() {
  const found = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.stversions') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.includes('.sync-conflict-')) found.push(full.slice(VAULT.length + 1));
    }
  }
  await walk(VAULT);
  return found;
}

// Porcelain status as { path, code } entries, untracked files listed individually.
async function changes() {
  const out = await git('status', '--porcelain=v1', '-z', '-uall');
  const parts = out.split('\0').filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    list.push({ code, path: parts[i].slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip rename source
  }
  return list;
}

// Commits on HEAD not yet on the remote, oldest first, with the author's local day.
export async function unpushedCommits() {
  if (!(await revParse('HEAD'))) return [];
  const range = (await revParse(REMOTE_REF)) ? `${REMOTE_REF}..HEAD` : 'HEAD';
  const out = await git('log', '--reverse', '--date=format-local:%Y-%m-%d', '--format=%H%x1f%s%x1f%ad', range);
  return out.split('\n').filter(Boolean).map(l => {
    const [sha, subject, day] = l.split('\x1f');
    return { sha, subject, day };
  });
}

export async function behindCount() {
  if (!(await revParse(REMOTE_REF))) return 0;
  const range = (await revParse('HEAD')) ? `HEAD..${REMOTE_REF}` : REMOTE_REF;
  return Number(await git('rev-list', '--count', range));
}

// Would git ignore this path? Works for paths that do not exist (--no-index
// also answers for tracked files), so it can probe the effective .gitignore rules.
export async function gitIgnores(path) {
  return (await run(['check-ignore', '-q', '--no-index', '--', path])).code === 0;
}

// How git sees a path: 'ignored', 'tracked' (in HEAD) or 'new'. Used to label
// change logs, since Syncthing reports new files as "modified".
export async function pathKind(path) {
  if ((await run(['check-ignore', '-q', '--', path])).code === 0) return 'ignored';
  const r = await run(['ls-tree', '--name-only', 'HEAD', '--', path]);
  return r.code === 0 && r.stdout.trim() ? 'tracked' : 'new';
}

export async function getStatus() {
  const head = await revParse('HEAD');
  const recent = head
    ? (await git('log', '-10', '--format=%H%x1f%s%x1f%aI')).split('\n').filter(Boolean).map(l => {
        const [hash, message, date] = l.split('\x1f');
        return { hash, message, date };
      })
    : [];
  const [pending, unpushed, behind] = await Promise.all([changes(), unpushedCommits(), behindCount()]);
  return { branch: BRANCH, uncommitted: pending.length, unpushed: unpushed.length, behind, recentCommits: recent };
}

// ── Committing ───────────────────────────────────────────────────────────────

// Keep large untracked files out of history for good by adding them to
// .git/info/exclude. Syncthing still syncs them.
async function excludeLargeFiles(pending) {
  const limit = config.maxFileMb * 1024 * 1024;
  const excluded = [];
  for (const { code, path } of pending) {
    if (code !== '??') continue;
    try {
      if ((await stat(join(VAULT, path))).size > limit) excluded.push(path);
    } catch { /* vanished */ }
  }
  if (excluded.length) {
    const escaped = excluded.map(p => '/' + p.replace(/([*?[\]\\!#])/g, '\\$1'));
    await appendFile(join(GIT_DIR, 'info', 'exclude'), `\n# over ${config.maxFileMb} MB, excluded by bridge\n${escaped.join('\n')}\n`);
    log.warn('Excluded large files from git (still synced by Syncthing)', { files: excluded });
  }
  return excluded;
}

// Commit whatever is on disk. In daily mode the day's commit is amended until
// it has been pushed, so history gets one commit per day.
export async function commitLocal() {
  await removeStaleLock();
  let pending = await changes();
  if (!pending.length) return null;

  const excluded = await excludeLargeFiles(pending);
  if (excluded.length) pending = await changes();
  if (!pending.length) return { excluded };

  const head = await revParse('HEAD');
  const day = today();
  let amend = false;
  if (config.commitMode === 'daily' && head) {
    const subject = await git('log', '-1', '--format=%s');
    const pushed = (await revParse(REMOTE_REF)) && (await tryRaw(['merge-base', '--is-ancestor', head, REMOTE_REF])) !== null;
    amend = subject.trim() === SUBJECT + day && !pushed;
  }

  await git('add', '-A');

  // Body lists every file changed by the commit (cumulative when amending).
  const base = amend ? (await revParse('HEAD~1')) ?? EMPTY_TREE : head ?? EMPTY_TREE;
  const files = (await git('diff', '--cached', '--name-status', base)).trim().split('\n').filter(Boolean);
  const body = files.slice(0, 200).join('\n') + (files.length > 200 ? `\n… and ${files.length - 200} more` : '');
  const subject = config.commitMode === 'daily'
    ? SUBJECT + day
    : SUBJECT + new Date().toLocaleString('sv-SE').slice(0, 16);

  await git('commit', '--no-verify', ...(amend ? ['--amend'] : []), '-m', subject, '-m', body || '(no changes)');
  const hash = await revParse('HEAD');
  log.info(amend ? 'Amended today\'s commit' : 'Committed', { hash: hash.slice(0, 7), changed: pending.length });
  return { hash, amend, changed: pending.length, excluded };
}

// ── Remote ───────────────────────────────────────────────────────────────────

export async function fetchRemote() {
  await git('fetch', '--prune', 'origin');
}

// Would replaying our commits on the remote conflict? Answered without touching
// the working tree (git >= 2.38), so Syncthing never sees a half-merged file.
export async function remoteMergeConflicts() {
  if (!(await revParse('HEAD'))) return [];
  const r = await run(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', REMOTE_REF]);
  if (r.code === 0) return [];
  if (r.code !== 1) throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
  // Exit 1 = conflicts; stdout is "<tree>\n<conflicted paths>".
  return r.stdout.trim().split('\n').slice(1).filter(Boolean);
}

// Rebase local commits onto the remote. On failure, abort so the tree is back
// to exactly what it was.
export async function rebaseOntoRemote() {
  if (!(await revParse('HEAD'))) {
    await git('reset', '--hard', REMOTE_REF);
    return;
  }
  const r = await run(['rebase', '--no-autostash', REMOTE_REF]);
  if (r.code !== 0) {
    await run(['rebase', '--abort']);
    throw new Error(`rebase failed and was aborted: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
}

export async function pushCommit(sha) {
  await git('push', '--porcelain', 'origin', `${sha}:refs/heads/${BRANCH}`);
  log.info('Pushed', { hash: sha.slice(0, 7) });
}

export { today };
