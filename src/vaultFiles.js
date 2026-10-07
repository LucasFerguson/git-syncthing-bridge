import { readFile, writeFile, access, readdir } from 'fs/promises';
import { join } from 'path';
import config from './config.js';
import { log } from './logger.js';
import { gitIgnores, pathKind } from './gitManager.js';
import { getIgnores, setIgnores } from './syncthing.js';
import { writeStatusNote } from './statusNote.js';

// Vault files the bridge relies on. The rule is: add what is missing, never
// overwrite. .gitignore and .stignore each get one marked block owned by the
// bridge; every line outside it belongs to the vault and is left untouched.
// checkVault() then verifies the *effective* rules (what git and Syncthing
// actually do), because an existing line elsewhere can still defeat them.

const GIT_BEGIN = '# >>> git-syncthing-bridge (managed block — edits inside it are overwritten)';
const GIT_END = '# <<< git-syncthing-bridge';
const ST_BEGIN = '// >>> git-syncthing-bridge (managed block — edits inside it are overwritten)';
const ST_END = '// <<< git-syncthing-bridge';

const CONFLICT_SAMPLE = 'Note.sync-conflict-20260101-120000-ABCDEFG.md';

function gitignoreBlock() {
  return [
    GIT_BEGIN,
    '# Syncthing internals and conflict copies (conflicts are reported by the bridge, never committed)',
    '.stfolder', '.stfolder/', '.stignore', '.stversions/', '*.sync-conflict-*', '.syncthing.*.tmp', '~syncthing~*.tmp',
    '# Obsidian per-device UI state and trash',
    '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.trash/',
    GIT_END,
  ];
}

// Syncthing uses the first matching pattern, so this block goes first.
// Conflict copies must never be listed: phone-side conflicts would then never
// reach the server and the bridge could not report them.
function stignoreBlock() {
  return [
    ST_BEGIN,
    '// The git repo stays on the server.',
    '/.git',
    ...(config.syncthingIgnoreObsidian ? ['// Phone and repo keep separate Obsidian plugins and settings.', '/.obsidian'] : []),
    ST_END,
  ];
}

// Replace the managed block in `lines`, or insert it (top or bottom) if absent.
function withBlock(lines, block, begin, end, atTop) {
  const i = lines.indexOf(begin);
  const j = lines.indexOf(end);
  if (i !== -1 && j > i) return [...lines.slice(0, i), ...block, ...lines.slice(j + 1)];
  const rest = [...lines];
  while (rest.length && !rest.at(-1).trim()) rest.pop();
  if (atTop) return [...block, ...(rest.length ? ['', ...rest] : [])];
  return [...rest, ...(rest.length ? [''] : []), ...block];
}

const exists = p => access(p).then(() => true, () => false);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function ensureVaultFiles() {
  const v = config.vaultPath;

  // Empty .nomedia keeps Android's media scanner (gallery, Google Photos backup)
  // out of the vault. A normal file, so Syncthing carries it to the phone.
  if (!(await exists(join(v, '.nomedia')))) {
    await writeFile(join(v, '.nomedia'), '');
    log.info('Created .nomedia');
  }

  if (config.statusNote && !(await exists(join(v, config.statusNote)))) {
    await writeStatusNote({ committedAt: null, lastPushAt: null });
    log.info(`Created ${config.statusNote}`);
  }

  const gi = join(v, '.gitignore');
  const giText = (await exists(gi)) ? await readFile(gi, 'utf8') : '';
  const giLines = giText ? giText.replace(/\n$/, '').split('\n') : [];
  const giNext = withBlock(giLines, gitignoreBlock(), GIT_BEGIN, GIT_END, false);
  if (!same(giLines, giNext)) {
    await writeFile(gi, giNext.join('\n') + '\n');
    log.info(giText ? 'Added bridge block to existing .gitignore (your lines untouched)' : 'Created .gitignore');
  }

  const { ignore } = await getIgnores();
  const stNext = withBlock(ignore, stignoreBlock(), ST_BEGIN, ST_END, true);
  if (!same(ignore, stNext)) {
    await setIgnores(stNext);
    log.info(ignore.length ? 'Added bridge block to existing .stignore (your lines untouched)' : 'Created .stignore');
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

// Normalized, non-negated Syncthing patterns: "(?d)/.git/**" -> "/.git/**".
function stPatterns(expanded) {
  return expanded
    .filter(p => !p.startsWith('!') && !p.startsWith('//'))
    .map(p => p.replace(/^(\(\?[di]\))+/, ''));
}
const stHides = (patterns, name) => patterns.some(p => [name, `/${name}`, '*', '.*', '/.*'].includes(p));

let lastChecks = [];
export const vaultChecks = () => lastChecks;

// Each check: { id, label, ok: true | false | null (pending), detail }.
export async function checkVault() {
  const checks = [];
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok, detail });
  const v = config.vaultPath;

  // .nomedia
  const nomedia = await exists(join(v, '.nomedia'));
  add('nomedia', '.nomedia exists in vault root', nomedia, nomedia ? '' : 'Phone photos in the vault may show up in the gallery / Google Photos.');
  if (nomedia) {
    const kind = await pathKind('.nomedia');
    add('nomedia-git', '.nomedia is committed to git',
      kind === 'tracked' ? true : kind === 'new' ? null : false,
      kind === 'ignored' ? 'A .gitignore line outside the bridge block ignores .nomedia.' : kind === 'new' ? 'Will be committed on the next cycle.' : '');
  }

  // Effective git rules
  const gitConflict = await gitIgnores(CONFLICT_SAMPLE);
  add('git-conflicts', 'git ignores Syncthing conflict copies', gitConflict, gitConflict ? '' : 'Conflict copies could be committed.');
  const gitInternals = (await gitIgnores('.stfolder')) && (await gitIgnores('.stversions/x.md'));
  add('git-internals', 'git ignores Syncthing internals (.stfolder, .stversions)', gitInternals);
  const keptOut = [];
  for (const p of ['Note.md', 'attachments/photo.jpg', 'IMG_0001.png', 'video.mp4', '.nomedia']) {
    if (await gitIgnores(p)) keptOut.push(p);
  }
  add('git-keeps', 'git keeps notes and photos', !keptOut.length,
    keptOut.length ? `Your .gitignore excludes: ${keptOut.join(', ')}` : '');

  // Effective Syncthing rules
  const { ignore, expanded } = await getIgnores();
  const pats = stPatterns(expanded);
  const stGit = pats.some(p => ['.git', '/.git', '.git/**', '/.git/**'].includes(p));
  add('st-git', 'Syncthing ignores .git', stGit, stGit ? '' : 'The git repo would be synced to the phone.');
  // Report the .stignore lines as written, not Syncthing's expanded variants.
  const hidesConflicts = pats.some(p => p.includes('sync-conflict'))
    ? ignore.filter(l => l.includes('sync-conflict') && !l.trim().startsWith('//') && !l.trim().startsWith('!'))
    : [];
  add('st-conflicts', 'Syncthing does not hide conflict copies', !hidesConflicts.length,
    hidesConflicts.length ? `Remove from .stignore: ${hidesConflicts.join(', ')}` : '');
  if (config.syncthingIgnoreObsidian) {
    const stObs = pats.some(p => ['.obsidian', '/.obsidian', '/.obsidian/**'].includes(p));
    add('st-obsidian', 'Syncthing ignores .obsidian (separate phone config)', stObs);
  }
  const stNomedia = stHides(pats, '.nomedia');
  add('st-nomedia', 'Syncthing syncs .nomedia to the phone', !stNomedia, stNomedia ? 'A .stignore pattern hides .nomedia.' : '');

  // Log only when the result changes, so a persistent failure is not spammed.
  const summary = c => `${c.id}:${c.ok}`;
  if (checks.map(summary).join() !== lastChecks.map(summary).join()) {
    for (const c of checks.filter(c => c.ok === false)) log.warn(`Vault check failed: ${c.label}`, c.detail ? { detail: c.detail } : undefined);
    if (checks.every(c => c.ok !== false)) log.info('Vault checks passed', { checks: checks.length });
  }
  lastChecks = checks;
  return checks;
}

// Folder and file names for the dashboard's tree viewer. Names only — file
// contents are never read. Symlinks are listed as files and not followed.
const TREE_SKIP = new Set(['.git', '.stversions', '.stfolder']);
const TREE_MAX_ENTRIES = 20_000;

export async function listTree() {
  let count = 0;
  let truncated = false;
  async function walk(dir) {
    const node = { dirs: [], files: [] };
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const e of entries) {
      if (TREE_SKIP.has(e.name)) continue;
      if (++count > TREE_MAX_ENTRIES) { truncated = true; break; }
      if (e.isDirectory()) node.dirs.push({ name: e.name, ...(await walk(join(dir, e.name))) });
      else node.files.push(e.name);
    }
    return node;
  }
  const tree = await walk(config.vaultPath);
  return { tree, count: Math.min(count, TREE_MAX_ENTRIES), truncated };
}
