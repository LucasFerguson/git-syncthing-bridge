import { EventEmitter } from 'events';
import { writeFile, rm, access } from 'fs/promises';
import { join } from 'path';
import config from './config.js';
import { log } from './logger.js';
import { alert, resolve } from './notify.js';
import * as gm from './gitManager.js';
import * as st from './syncthing.js';

// One sync cycle, strictly serialized:
//   Syncthing settled? → conflict copies? → commit → fetch → rebase (folder paused) → push
// Requests that arrive while a cycle runs set `rerun`, so the cycle repeats
// once it finishes instead of overlapping or being dropped.

export const syncEvents = new EventEmitter();

// Remote/network failures only alert after this long, so a brief outage is silent.
const REMOTE_ALERT_MS = 60 * 60 * 1000;
const PAUSE_MARKER = join(config.vaultPath, '.git', 'bridge-paused-syncthing');

const state = {
  phase: 'starting',
  lastCycleAt: null,
  lastCommitAt: null,
  lastFetchAt: null,
  lastPushAt: null,
  conflicts: [],
  mergeConflicts: [],
  lastError: null,
};
const failingSince = {}; // op -> timestamp of first consecutive failure

let current = null;
let rerun = false;
let forcePush = false;
let stopping = false;

function setPhase(phase) {
  state.phase = phase;
  syncEvents.emit('state', getState());
}

export function getState() {
  return { ...state, running: !!current };
}

export function requestCycle(trigger, { push = false } = {}) {
  if (stopping) return Promise.resolve();
  if (push) forcePush = true;
  if (current) {
    rerun = true;
    log.debug('Cycle already running — will rerun', { trigger });
    return current;
  }
  current = (async () => {
    try {
      do {
        rerun = false;
        await cycle(trigger);
        trigger = 'rerun';
      } while (rerun && !stopping);
    } finally {
      current = null;
      setPhase(stopping ? 'stopped' : 'idle');
    }
  })();
  return current;
}

function failed(op, err, title) {
  failingSince[op] ??= Date.now();
  state.lastError = { op, message: err.message, at: new Date().toISOString() };
  log.error(`${op} failed`, { err: err.message });
  if (Date.now() - failingSince[op] >= REMOTE_ALERT_MS) {
    alert(op, title, `${err.message}\nFailing since ${new Date(failingSince[op]).toLocaleString()}.`);
  }
}

function succeeded(op) {
  delete failingSince[op];
  resolve(op);
}

async function cycle(trigger) {
  state.lastCycleAt = new Date().toISOString();
  log.debug('Cycle start', { trigger });

  try {
    // 1. Only touch the vault when Syncthing has nothing in flight.
    setPhase('checking');
    const { settled, status } = await st.isSettled();
    if (!settled) {
      log.info('Syncthing not settled — deferring until it goes idle', { state: status.state, needTotalItems: status.needTotalItems });
      return;
    }

    // 2. Conflict copies. They are git-ignored, so committing is safe; the
    // question is only whether to keep backing up other notes meanwhile.
    state.conflicts = await gm.findConflictFiles();
    if (state.conflicts.length) {
      alert('sync-conflicts', 'Sync conflicts',
        `${state.conflicts.length} conflict copy(ies) need resolving, e.g. ${state.conflicts[0]}. Merge them in Obsidian and delete the .sync-conflict file.`);
      if (config.conflictPolicy === 'block') {
        log.warn('Conflict copies present — not committing (CONFLICT_POLICY=block)', { files: state.conflicts });
        return;
      }
    } else {
      resolve('sync-conflicts');
    }

    // 3. Commit locally. This only writes inside .git, which Syncthing ignores.
    setPhase('committing');
    const c = await gm.commitLocal();
    if (c?.hash) state.lastCommitAt = new Date().toISOString();
    if (c?.excluded?.length) {
      alert('large-files', 'Large files kept out of git', `${c.excluded.join(', ')} exceeded ${config.maxFileMb} MB. They still sync to the phone but have no git history.`);
    }
    succeeded('commit');

    // 4. Fetch.
    setPhase('fetching');
    try {
      await gm.fetchRemote();
      state.lastFetchAt = new Date().toISOString();
      succeeded('remote');
    } catch (err) {
      return failed('remote', err, 'Cannot reach git remote');
    }

    // 5. Integrate remote changes. Rebase rewrites files, so Syncthing is paused
    // around it and told to rescan afterwards.
    if (await gm.behindCount() > 0) {
      state.mergeConflicts = await gm.remoteMergeConflicts();
      if (state.mergeConflicts.length) {
        alert('diverged', 'Vault diverged from remote',
          `Local and remote both changed: ${state.mergeConflicts.join(', ')}. Still committing locally; pushes are on hold until this is resolved by hand.`);
        return;
      }
      setPhase('rebasing');
      try {
        await withFolderPaused(async () => {
          await gm.commitLocal(); // anything that landed between step 3 and the pause
          await gm.rebaseOntoRemote();
        });
      } catch (err) {
        alert('diverged', 'Vault diverged from remote', `${err.message}\nStill committing locally; pushes are on hold until this is resolved by hand.`);
        return;
      }
      log.info('Rebased onto remote');
      resolve('diverged');
    }
    state.mergeConflicts = [];

    // 6. Push.
    await maybePush();
  } catch (err) {
    failed('cycle', err, 'Sync cycle failing');
  }
}

async function maybePush() {
  const unpushed = await gm.unpushedCommits();
  const force = forcePush;
  forcePush = false;
  if (!unpushed.length) return succeeded('push');

  // Daily mode holds today's commit (it is still being amended) and pushes
  // everything from earlier days.
  const target = config.commitMode === 'immediate' || force
    ? unpushed.at(-1)
    : unpushed.filter(c => c.day < gm.today()).at(-1);
  if (!target) {
    log.debug('Holding today\'s commit until tomorrow', { unpushed: unpushed.length });
    return;
  }

  setPhase('pushing');
  try {
    await gm.pushCommit(target.sha);
    state.lastPushAt = new Date().toISOString();
    succeeded('push');
  } catch (err) {
    // A non-fast-forward is fixed by the next cycle's fetch + rebase.
    if (/non-fast-forward|fetch first|rejected/i.test(err.message)) rerun = true;
    failed('push', err, 'Push failing');
  }
}

async function withFolderPaused(fn) {
  await writeFile(PAUSE_MARKER, new Date().toISOString());
  await st.setPaused(true);
  try {
    await fn();
  } finally {
    await st.setPaused(false);
    await rm(PAUSE_MARKER, { force: true });
    await st.rescan().catch(err => log.warn('Rescan request failed', { err: err.message }));
  }
}

// Undo anything a crash left half-done, then do a full cycle.
export async function startup() {
  setPhase('reconciling');
  await gm.reconcile();
  if (await access(PAUSE_MARKER).then(() => true, () => false)) {
    log.warn('Folder was left paused by a previous run — resuming it');
    await st.setPaused(false);
    await rm(PAUSE_MARKER, { force: true });
  }
  setPhase('idle');
}

export async function shutdown(timeoutMs = 45_000) {
  stopping = true;
  if (current) {
    log.info('Waiting for the running cycle to finish');
    await Promise.race([current, new Promise(r => setTimeout(r, timeoutMs))]);
  }
}
