// Git-layer tests: commit messages and automatic conflict resolution.
// Uses throwaway repos in a temp dir (no Syncthing needed):
//   node --test test/merge.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const T = mkdtempSync(join(tmpdir(), 'bridge-merge-'));
const REMOTE = join(T, 'remote.git');
const VAULT = join(T, 'vault');
const DESK = join(T, 'desktop');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir, path, text) => writeFileSync(join(dir, path), text);
const read = (dir, path) => readFileSync(join(dir, path), 'utf8');
const ATTRS = '*.md merge=union\n';
let gm;

// Change something on the "desktop" and push it, like Obsidian Git would.
function desktop(fn) {
  sh(DESK, 'pull', '-q', '--rebase');
  fn();
  sh(DESK, 'add', '-A');
  sh(DESK, 'commit', '-qm', 'vault backup');
  sh(DESK, 'push', '-q');
}

// Commit in the vault, fetch, replay; returns the replay notes.
async function syncVault(sources) {
  await gm.commitLocal({ sources: new Map(Object.entries(sources ?? {})) });
  await gm.fetchRemote();
  const { notes } = await gm.replayOntoRemote();
  return notes;
}

const headMessage = () => sh(VAULT, 'log', '-1', '--format=%B');
const byPath = (notes, path) => notes.find(n => n.path === path);

before(async () => {
  sh(T, 'init', '-q', '--bare', '-b', 'main', REMOTE);
  sh(T, 'clone', '-q', REMOTE, DESK);
  for (const [k, v] of [['user.name', 'desk'], ['user.email', 'desk@x']]) sh(DESK, 'config', k, v);
  write(DESK, '.gitattributes', ATTRS);
  write(DESK, 'n.md', 'one\ntwo\nthree\n');
  write(DESK, 'far.md', 'top\n\n\n\n\n\nbottom\n');
  write(DESK, 'del.md', 'keep me\n');
  write(DESK, 'ren.md', 'renamed?\n');
  write(DESK, 'conf.json', '{"a":1}\n');
  write(DESK, 'p.png', 'PNG-base');
  sh(DESK, 'add', '-A');
  sh(DESK, 'commit', '-qm', 'base');
  sh(DESK, 'push', '-q', 'origin', 'main');
  sh(T, 'clone', '-q', REMOTE, VAULT);
  for (const [k, v] of [['user.name', 'vault'], ['user.email', 'vault@x']]) sh(VAULT, 'config', k, v);

  Object.assign(process.env, {
    VAULT_PATH: VAULT, SYNCTHING_FOLDER_ID: 'test', SYNCTHING_API_KEY: 'test',
    COMMIT_MODE: 'daily', STATUS_NOTE: '', LOG_LEVEL: 'error', BRIDGE_ENV: '/nonexistent',
  });
  gm = await import('../src/gitManager.js');
});

// KEEP_TMP=1 leaves the repos behind for inspection.
after(() => process.env.KEEP_TMP ? console.log(`kept ${T}`) : rmSync(T, { recursive: true, force: true }));

test('commit message names devices and counts changes', async () => {
  write(VAULT, 'phone.md', 'from phone\n');
  write(VAULT, 'n.md', 'one\ntwo\nthree\nfour\n');
  const sources = new Map([['phone.md', 'S24Ultra']]);
  await gm.commitLocal({ sources });
  const msg = headMessage();
  assert.match(msg.split('\n')[0], /^vault: \d{4}-\d\d-\d\d \(S24Ultra: 1 created, 1 edited\)$/);
  assert.match(msg, /^A\tphone\.md\t\[S24Ultra\]$/m);
  assert.match(msg, /^M\tn\.md$/m);
  assert.match(msg, /Changed on: S24Ultra \(1 file\)/);
  assert.equal(sources.size, 0, 'committed paths are taken out of the sources map');
});

test('daily amend keeps earlier device tags and adds new ones', async () => {
  write(VAULT, 'server.md', 'x\n');
  await gm.commitLocal({ sources: new Map([['server.md', 'server']]) });
  const msg = headMessage();
  assert.match(msg.split('\n')[0], /\(S24Ultra, server: 2 created, 1 edited\)$/);
  assert.match(msg, /^A\tphone\.md\t\[S24Ultra\]$/m);
  assert.match(msg, /^A\tserver\.md\t\[server\]$/m);
  assert.equal(sh(VAULT, 'rev-list', '--count', 'origin/main..HEAD'), '1', 'still one commit for today');
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('mergeDriver reports the union rule', async () => {
  assert.equal(await gm.mergeDriver('Some note.md'), 'union');
  assert.equal(await gm.mergeDriver('photo.png'), 'unspecified');
});

test('same lines edited on both sides: union keeps both, no stop', async () => {
  desktop(() => write(DESK, 'n.md', 'one\nDESKTOP\nthree\nfour\n'));
  write(VAULT, 'n.md', 'one\nPHONE\nthree\nfour\n');
  const notes = await syncVault({ 'n.md': 'S24Ultra' });
  assert.equal(byPath(notes, 'n.md')?.how, 'union');
  const text = read(VAULT, 'n.md');
  assert.ok(text.includes('DESKTOP') && text.includes('PHONE'), text);
  assert.ok(text.indexOf('DESKTOP') < text.indexOf('PHONE'), 'remote lines first');
  assert.ok(!text.includes('<<<<<<<'));
  assert.equal(sh(VAULT, 'rev-parse', 'HEAD~1'), sh(VAULT, 'rev-parse', 'origin/main'), 'linear: replayed on top of remote');
  assert.match(headMessage(), /^Merged onto remote [0-9a-f]{7} .*\n- n\.md: edited on both sides in the same place/m);
  assert.equal(sh(VAULT, 'status', '--porcelain'), '', 'working tree matches the new HEAD');
});

test('amending after a merge keeps the merge notes', async () => {
  write(VAULT, 'later.md', 'later\n');
  await gm.commitLocal({ sources: new Map([['later.md', 'S24Ultra']]) });
  const msg = headMessage();
  assert.match(msg, /^A\tlater\.md\t\[S24Ultra\]$/m);
  assert.match(msg, /^Merged onto remote [0-9a-f]{7}/m);
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('edits in different places merge cleanly and are noted as merged', async () => {
  desktop(() => write(DESK, 'far.md', 'TOP\n\n\n\n\n\nbottom\n'));
  write(VAULT, 'far.md', 'top\n\n\n\n\n\nBOTTOM\n');
  const notes = await syncVault();
  assert.equal(byPath(notes, 'far.md')?.how, 'merged');
  assert.equal(read(VAULT, 'far.md'), 'TOP\n\n\n\n\n\nBOTTOM\n');
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('binary and JSON changed on both sides: both copies kept', async () => {
  desktop(() => { write(DESK, 'p.png', 'PNG-desktop'); write(DESK, 'conf.json', '{"a":"desktop"}\n'); });
  write(VAULT, 'p.png', 'PNG-phone');
  write(VAULT, 'conf.json', '{"a":"phone"}\n');
  const notes = await syncVault();
  for (const [path, mine, theirs] of [['p.png', 'PNG-phone', 'PNG-desktop'], ['conf.json', '{"a":"phone"}\n', '{"a":"desktop"}\n']]) {
    const n = byPath(notes, path);
    assert.equal(n?.how, 'kept-both', path);
    assert.equal(read(VAULT, path), mine, `${path} keeps this vault's version`);
    const copy = n.text.match(/saved as "(.+)"$/)[1];
    assert.match(copy, /^(p|conf) \(remote conflict \d{4}-\d\d-\d\d \d{4}\)\.(png|json)$/);
    assert.equal(read(VAULT, copy), theirs, `${copy} holds the remote version`);
    assert.equal(sh(VAULT, 'ls-files', '--', copy), copy, 'copy is committed');
  }
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('edited here, deleted on remote: the edited file is kept', async () => {
  desktop(() => sh(DESK, 'rm', '-q', 'del.md'));
  write(VAULT, 'del.md', 'keep me\nedited on phone\n');
  const notes = await syncVault();
  assert.equal(byPath(notes, 'del.md')?.how, 'kept-edited');
  assert.equal(read(VAULT, 'del.md'), 'keep me\nedited on phone\n');
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('renamed here, deleted on remote: the renamed file is kept', async () => {
  desktop(() => sh(DESK, 'rm', '-q', 'ren.md'));
  sh(VAULT, 'mv', 'ren.md', 'ren2.md');
  const notes = await syncVault();
  assert.equal(byPath(notes, 'ren2.md')?.how, 'kept-renamed');
  assert.equal(byPath(notes, 'ren.md'), undefined, 'the old name is not reported as merged');
  assert.ok(existsSync(join(VAULT, 'ren2.md')));
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('a note without the union rule is kept as two copies', async () => {
  desktop(() => { write(DESK, '.gitattributes', ''); });
  write(VAULT, '.gitattributes', '');
  await syncVault();
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
  desktop(() => write(DESK, 'n.md', 'rewritten on desktop\n'));
  write(VAULT, 'n.md', 'rewritten on phone\n');
  const notes = await syncVault();
  assert.equal(byPath(notes, 'n.md')?.how, 'kept-both');
  assert.equal(read(VAULT, 'n.md'), 'rewritten on phone\n');
  assert.ok(readdirSync(VAULT).some(f => f.startsWith('n (remote conflict ') && f.endsWith('.md')));
  await gm.pushCommit(sh(VAULT, 'rev-parse', 'HEAD'));
});

test('only behind: fast-forward with no notes', async () => {
  desktop(() => write(DESK, 'new-on-desktop.md', 'hi\n'));
  const notes = await syncVault();
  assert.deepEqual(notes, []);
  assert.equal(sh(VAULT, 'rev-parse', 'HEAD'), sh(VAULT, 'rev-parse', 'origin/main'));
  assert.equal(read(VAULT, 'new-on-desktop.md'), 'hi\n');
});

test('history stays linear', () => {
  assert.equal(sh(VAULT, 'log', '--merges', '--oneline'), '');
});
