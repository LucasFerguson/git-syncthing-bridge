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
// First body line of the notes a replay adds; carried over when a commit is amended.
const MERGE_MARK = 'Merged onto remote ';

// Never prompt, never trust an unknown host key, and give up on dead connections
// instead of hanging the daemon.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4',
};

// Run git; resolves with the exit code instead of throwing.
function run(args, { timeoutMs = 120_000, env = {} } = {}) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: VAULT, env: { ...ENV, ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

// Run git; throws with stderr on a non-zero exit.
async function git(...args) {
  return gitEnv({}, ...args);
}

async function gitEnv(env, ...args) {
  const r = await run(args, { env });
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

// Commit date of the remote branch: a stand-in for "last push" after a restart.
export const remoteHeadDate = () => tryRaw(['log', '-1', '--format=%cI', REMOTE_REF]);

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

// The merge driver .gitattributes assigns to a path: 'union', 'unspecified', …
export async function mergeDriver(path) {
  const out = await tryRaw(['check-attr', 'merge', '--', path]);
  return out?.split(': ').at(-1) ?? 'unspecified';
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

// ── Commit messages ──────────────────────────────────────────────────────────
//
//   vault: 2026-10-09 (S24Ultra: 1 created, 2 edited)
//
//   Changed on: S24Ultra (3 files)
//   A = created, M = edited, D = deleted, R = renamed
//
//   A	Pantheon.md	[S24Ultra]
//   M	001-Home/Logs/Movie Log.md	[S24Ultra]
//
// File lines are tab-separated so an amend can read the device tags back.

const VERB = { A: 'created', C: 'created', M: 'edited', T: 'edited', D: 'deleted', R: 'renamed' };

// "R100\told\tnew\t[dev]" -> { status: 'R', paths: ['old', 'new'], device: 'dev' }
function parseFileLine(line) {
  const parts = line.split('\t');
  const m = /^([ACDMRT])\d*$/.exec(parts[0]);
  if (!m || parts.length < 2) return null;
  const device = /^\[(.+)\]$/.exec(parts.at(-1))?.[1];
  return { status: m[1], paths: parts.slice(1, device ? -1 : undefined), device };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function buildMessage(subjectPrefix, files, quietPath) {
  const counted = files.filter(f => f.paths.at(-1) !== quietPath);
  const devices = [...new Set(counted.map(f => f.device).filter(Boolean))];
  const counts = {};
  for (const f of counted) counts[VERB[f.status]] = (counts[VERB[f.status]] ?? 0) + 1;
  const summary = ['created', 'edited', 'deleted', 'renamed'].filter(v => counts[v]).map(v => `${counts[v]} ${v}`).join(', ');
  const who = devices.length ? `${devices.join(', ')}: ` : '';
  const subject = summary ? `${subjectPrefix} (${who}${summary})` : subjectPrefix;

  const perDevice = devices.map(d => `${d} (${plural(counted.filter(f => f.device === d).length, 'file')})`);
  const lines = files.slice(0, 200).map(f => [f.status, ...f.paths, ...(f.device ? [`[${f.device}]`] : [])].join('\t'));
  if (files.length > 200) lines.push(`… and ${files.length - 200} more`);
  const body = [
    ...(perDevice.length ? [`Changed on: ${perDevice.join(', ')}`] : []),
    'A = created, M = edited, D = deleted, R = renamed',
    '',
    ...(lines.length ? lines : ['(no changes)']),
  ].join('\n');
  return { subject, body };
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

const isDaySubject = (subject, day) => subject === SUBJECT + day || subject.startsWith(`${SUBJECT}${day} (`);

// Commit whatever is on disk. In daily mode the day's commit is amended until
// it has been pushed, so history gets one commit per day. `beforeCommit` runs
// just before staging, only when something other than `quietPath` changed —
// used to stamp the status note without it ever triggering a commit itself.
// `sources` maps path -> device name (from Syncthing events); committed paths
// are removed from it.
export async function commitLocal({ beforeCommit, quietPath, sources = new Map() } = {}) {
  await removeStaleLock();
  let pending = await changes();
  if (!pending.length) return null;

  const excluded = await excludeLargeFiles(pending);
  if (excluded.length) pending = await changes();
  if (!pending.length) return { excluded };

  const head = await revParse('HEAD');
  const day = today();
  let amend = false;
  let prevBody = '';
  if (config.commitMode === 'daily' && head) {
    const subject = (await git('log', '-1', '--format=%s')).trim();
    const pushed = (await revParse(REMOTE_REF)) && (await tryRaw(['merge-base', '--is-ancestor', head, REMOTE_REF])) !== null;
    amend = isDaySubject(subject, day) && !pushed;
    if (amend) prevBody = await git('log', '-1', '--format=%b');
  }

  if (beforeCommit && pending.some(p => p.path !== quietPath)) await beforeCommit();
  await git('add', '-A');

  // Body lists every file changed by the commit (cumulative when amending),
  // tagged with the device that changed it when Syncthing told us.
  const prevDevices = new Map();
  for (const l of prevBody.split('\n')) {
    const f = parseFileLine(l);
    if (f?.device) prevDevices.set(f.paths.at(-1), f.device);
  }
  const base = amend ? (await revParse('HEAD~1')) ?? EMPTY_TREE : head ?? EMPTY_TREE;
  const files = (await git('diff', '--cached', '--name-status', base)).split('\n').map(parseFileLine).filter(Boolean);
  for (const f of files) {
    const path = f.paths.at(-1);
    f.device = sources.get(path) ?? sources.get(f.paths[0]) ?? prevDevices.get(path);
  }
  const prefix = config.commitMode === 'daily'
    ? SUBJECT + day
    : SUBJECT + new Date().toLocaleString('sv-SE').slice(0, 16);
  const { subject, body } = buildMessage(prefix, files, quietPath);
  // Notes from an earlier auto-merge stay with the commit when it is amended.
  const i = prevBody.indexOf(MERGE_MARK);
  const mergeNotes = i === -1 ? '' : prevBody.slice(i).trim();

  await git('commit', '--no-verify', ...(amend ? ['--amend'] : []), '-m', subject, '-m', body, ...(mergeNotes ? ['-m', mergeNotes] : []));
  for (const f of files) for (const p of f.paths) sources.delete(p);
  const hash = await revParse('HEAD');
  log.info(amend ? 'Amended today\'s commit' : 'Committed', { hash: hash.slice(0, 7), changed: pending.length });
  return { hash, amend, changed: pending.length, excluded };
}

// ── Remote ───────────────────────────────────────────────────────────────────

export async function fetchRemote() {
  await git('fetch', '--prune', 'origin');
}

// Integrating remote changes never stops syncing. Local commits are replayed
// onto the remote one at a time (a rebase done in memory with
// `git merge-tree`, so the working tree is only touched once, at the end):
//   - notes edited on both sides merge line by line; `*.md merge=union` in
//     .gitattributes keeps both sides' lines where they overlap
//   - a file changed on both sides that cannot be merged (photos, JSON, notes
//     without the union rule) is kept twice: this vault's version keeps the
//     name, the remote's is saved next to it as "<name> (remote conflict <date>)"
//   - edit vs delete keeps the edited file; renames keep every name git left
// Every resolution is written into the replayed commit's message and returned
// so the caller can log it. Returns { notes: [{ path, how, text }] }.
export async function replayOntoRemote() {
  if (!(await revParse('HEAD'))) {
    await git('reset', '--hard', REMOTE_REF);
    return { notes: [] };
  }
  const remote = await revParse(REMOTE_REF);
  const local = (await git('rev-list', '--reverse', '--topo-order', `${REMOTE_REF}..HEAD`)).split('\n').filter(Boolean);
  if (!local.length) {
    await git('merge', '--ff-only', '-q', REMOTE_REF);
    return { notes: [] };
  }
  if ((await git('rev-list', '--merges', `${REMOTE_REF}..HEAD`)).trim()) {
    throw new Error('Unpushed history contains a merge commit; integrate the remote by hand');
  }

  let tip = remote;
  const allNotes = [];
  for (const c of local) {
    const parent = await revParse(`${c}^`);
    if (!parent) throw new Error(`Local commit ${c.slice(0, 7)} has no parent; integrate the remote by hand`);
    const { tree, notes } = await mergeOne(parent, tip, c);
    if (tree === (await git('rev-parse', `${tip}^{tree}`)).trim()) {
      log.info('Dropped a local commit already contained in the remote', { hash: c.slice(0, 7) });
      continue;
    }
    const [name, email, date, message] = (await git('log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', c)).split('\0');
    let msg = message.trimEnd();
    if (notes.length) {
      msg += `\n\n${MERGE_MARK}${tip.slice(0, 7)} (changed on another device as well):\n`
        + notes.map(n => `- ${n.path}: ${n.text}`).join('\n');
    }
    const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
    tip = (await gitEnv(env, 'commit-tree', tree, '-p', tip, '-m', msg)).trim();
    allNotes.push(...notes);
  }

  // Moves the branch and rewrites only the files that differ; refuses (and
  // changes nothing) if that would clobber uncommitted work.
  await git('reset', '--keep', tip);
  return { notes: allNotes };
}

// Paths added or modified (not deleted) between two commits.
const changedPaths = async (from, to) =>
  (await git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=AMT', from, to)).split('\0').filter(Boolean);

// Cherry-pick `commit` (whose parent is `base`) onto `onto` in memory.
// Returns the resolved tree and a note per file that needed resolving.
async function mergeOne(base, onto, commit) {
  const r = await run(['merge-tree', '-z', '--write-tree', `--merge-base=${base}`, onto, commit]);
  if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
  const parts = r.stdout.split('\0');
  let tree = parts[0];

  // Conflicted file info: "<mode> <oid> <stage>\t<path>". Stage 2 = remote
  // side (onto), stage 3 = this vault's commit.
  const stages = new Map();
  let i = 1;
  for (; i < parts.length && parts[i] !== ''; i++) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    if (!stages.has(m[4])) stages.set(m[4], {});
    stages.get(m[4])[m[3]] = { mode: m[1], oid: m[2] };
  }
  // Informational messages: "<n>\0<path>…\0<type>\0<message>\0".
  const messages = [];
  for (i++; i < parts.length && parts[i] !== ''; ) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 1) break;
    messages.push({ paths: parts.slice(i + 1, i + 1 + n), type: parts[i + 1 + n], text: parts[i + 2 + n] });
    i += n + 3;
  }

  const notes = [];
  const noted = new Set();
  const note = (path, how, text) => { notes.push({ path, how, text }); noted.add(path); };

  // Both sides have a version git could not merge: keep both files.
  const blob = s => s && /^100(644|755)$/.test(s.mode);
  const overrides = [];
  for (const [path, s] of stages) {
    if (!blob(s[2]) || !blob(s[3])) continue;
    if (s[2].oid === s[3].oid) { overrides.push([s[3].mode, s[3].oid, path]); continue; }
    const copy = await freeName(tree, remoteCopyName(path));
    overrides.push([s[3].mode, s[3].oid, path], [s[2].mode, s[2].oid, copy]);
    note(path, 'kept-both', `changed on both sides and could not be merged; this vault's version keeps the name, the remote's was saved as "${copy}"`);
  }
  if (overrides.length) tree = await applyToTree(tree, overrides);

  for (const msg of messages) {
    const path = msg.paths[0];
    if (!msg.type.startsWith('CONFLICT') || noted.has(path)) continue;
    const s = stages.get(path) ?? {};
    if (msg.type === 'CONFLICT (modify/delete)') {
      note(path, 'kept-edited', s[3] ? 'edited here but deleted on the remote; kept the edited file' : 'deleted here but edited on the remote; kept the edited file');
    } else if (msg.type === 'CONFLICT (rename/delete)') {
      note(path, 'kept-renamed', `renamed (from ${msg.paths.slice(1).join(', ')}) on one side and deleted on the other; kept the renamed file`);
    } else if (msg.type.startsWith('CONFLICT (rename')) {
      note(path, 'kept-renamed', `renamed differently on both sides; kept every name (${msg.text})`);
    } else {
      note(path, 'other', msg.text);
    }
  }

  // Files changed on both sides that merged without a conflict: either the
  // edits touched different lines, or the union rule kept both sides' lines.
  const ours = new Set(await changedPaths(base, onto));
  const both = (await changedPaths(base, commit)).filter(p => ours.has(p) && !noted.has(p));
  if (both.length) {
    // Without .gitattributes, which of them would have conflicted?
    const plain = await run([`--attr-source=${EMPTY_TREE}`, 'merge-tree', '-z', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, onto, commit]);
    const wouldConflict = new Set(plain.code === 1 ? plain.stdout.split('\0').slice(1).filter(Boolean) : []);
    for (const p of both) {
      if (wouldConflict.has(p)) note(p, 'union', 'edited on both sides in the same place; kept both versions\' lines (remote first), tidy up by hand');
      else note(p, 'merged', 'edited on both sides in different places; merged cleanly');
    }
  }
  return { tree, notes };
}

// "dir/Photo.png" -> "dir/Photo (remote conflict 2026-10-11 1430).png"
function remoteCopyName(path) {
  const slash = path.lastIndexOf('/') + 1;
  const name = path.slice(slash);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const now = new Date();
  const stamp = `${now.toLocaleDateString('en-CA')} ${now.toTimeString().slice(0, 5).replace(':', '')}`;
  return `${path.slice(0, slash)}${stem} (remote conflict ${stamp})${ext}`;
}

async function freeName(tree, name) {
  let candidate = name;
  for (let n = 2; (await run(['cat-file', '-e', `${tree}:${candidate}`])).code === 0; n++) {
    candidate = name.replace(/\)(\.[^.]*)?$/, ` ${n})$1`);
  }
  return candidate;
}

// Write `tree` with some paths replaced, using a scratch index.
async function applyToTree(tree, entries) {
  const env = { GIT_INDEX_FILE: join(GIT_DIR, 'bridge-merge.index') };
  try {
    await gitEnv(env, 'read-tree', tree);
    for (const [mode, oid, path] of entries) await gitEnv(env, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`);
    return (await gitEnv(env, 'write-tree')).trim();
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

export async function pushCommit(sha) {
  await git('push', '--porcelain', 'origin', `${sha}:refs/heads/${BRANCH}`);
  log.info('Pushed', { hash: sha.slice(0, 7) });
}

export { today };
