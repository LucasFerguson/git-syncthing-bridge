import { readFile, writeFile, access, readdir } from 'fs/promises';
import { join } from 'path';
import config from './config.js';
import { log } from './logger.js';

// Files the bridge keeps in shape inside the vault. Each is rewritten only when
// its content is wrong, so this is safe to run on every start.

const BEGIN = '# >>> git-syncthing-bridge (managed block — edits inside it are overwritten)';
const END = '# <<< git-syncthing-bridge';

function gitignoreBlock() {
  return [
    BEGIN,
    '# Syncthing internals and conflict copies (conflicts are reported by the bridge, never committed)',
    '.stfolder', '.stfolder/', '.stignore', '.stversions/', '*.sync-conflict-*', '.syncthing.*.tmp', '~syncthing~*.tmp',
    '# Obsidian per-device UI state and trash',
    '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.trash/',
    END,
  ].join('\n');
}

const exists = p => access(p).then(() => true, () => false);

async function ensureManagedBlock(path, block) {
  const current = (await exists(path)) ? await readFile(path, 'utf8') : '';
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}`);
  const next = re.test(current)
    ? current.replace(re, block)
    : (current.trimEnd() ? current.trimEnd() + '\n\n' : '') + block + '\n';
  if (next !== current) {
    await writeFile(path, next);
    log.info('Updated managed file', { file: path.replace(config.vaultPath + '/', '') });
  }
}

export async function ensureVaultFiles() {
  const v = config.vaultPath;

  // Empty .nomedia keeps Android's media scanner (gallery, Google Photos backup)
  // out of the vault. It is a normal file, so Syncthing carries it to the phone.
  if (!(await exists(join(v, '.nomedia')))) {
    await writeFile(join(v, '.nomedia'), '');
    log.info('Created .nomedia');
  }

  await ensureManagedBlock(join(v, '.gitignore'), gitignoreBlock());

  // .stignore is local to this server and never synced. It must keep .git out
  // of Syncthing; conflict copies must NOT be listed, or phone-side conflicts
  // would never reach the server and the bridge could not see them.
  const stignore = join(v, '.stignore');
  const st = (await exists(stignore)) ? await readFile(stignore, 'utf8') : '';
  const lines = st.split('\n').map(l => l.trim()).filter(l => !l.startsWith('//'));
  if (lines.some(l => l.includes('sync-conflict'))) {
    log.warn('.stignore lists sync-conflict files — phone-side conflicts will be hidden from the bridge');
  }
  if (!lines.includes('.git') && !lines.includes('/.git')) {
    await writeFile(stignore, '// Server-local Syncthing ignores (not synced). Keep .git out of the phone.\n/.git\n' + st);
    log.info('Added /.git to .stignore');
  }
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
