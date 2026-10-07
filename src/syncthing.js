import { EventEmitter } from 'events';
import config from './config.js';
import { log } from './logger.js';
import { alert, resolve } from './notify.js';
import { pathKind } from './gitManager.js';

// Emits:
//   'state'  (folderState)   every folder state change, for the dashboard
//   'idle'                   folder went idle — something may need committing
//   'resync'                 we (re)connected and may have missed events
export const watcher = new EventEmitter();

const BASE = config.syncthingApiUrl;
const FOLDER = config.syncthingFolderId;
const HEADERS = { 'X-API-Key': config.syncthingApiKey, 'Content-Type': 'application/json' };
const LONG_POLL_S = 60;
// A filtered event stream has its own id sequence (separate from the global
// one), so the cursor must always come from this same filter.
const EVENTS = '/rest/events?events=StateChanged,FolderErrors,LocalChangeDetected,RemoteChangeDetected';
// Per-file change lines logged per poll; a big batch (e.g. a photo import) is summarized.
const MAX_CHANGE_LINES = 25;
const UNREACHABLE_ALERT_MS = 10 * 60 * 1000;

let running = false;
let lastEventId = 0;
let startTime = null;       // Syncthing's own start time; a change means it restarted
let downSince = null;
let pollAbort = null;
let deviceNames = new Map(); // full device ID -> name, for "changed by <phone>"

async function api(path, { method = 'GET', body, timeoutMs = 15_000, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(`${BASE}${path}`, {
    method, headers: HEADERS, body: body && JSON.stringify(body), signal: AbortSignal.any(signals),
  });
  if (!res.ok) throw new Error(`Syncthing ${method} ${path.split('?')[0]} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const folderStatus = () => api(`/rest/db/status?folder=${encodeURIComponent(FOLDER)}`);

// Idle with nothing left to pull and no pull errors: the folder on disk matches
// what Syncthing believes is the newest version.
export async function isSettled() {
  const s = await folderStatus();
  return { settled: s.state === 'idle' && s.needTotalItems === 0 && !s.pullErrors, status: s };
}

export async function setPaused(paused) {
  await api(`/rest/config/folders/${encodeURIComponent(FOLDER)}`, { method: 'PATCH', body: { paused } });
  log.info(paused ? 'Paused Syncthing folder' : 'Resumed Syncthing folder');
}

export async function isPaused() {
  const f = await api(`/rest/config/folders/${encodeURIComponent(FOLDER)}`);
  return !!f.paused;
}

// The folder's ignore patterns: `ignore` is the raw .stignore lines, `expanded`
// the patterns Syncthing actually applies (with #include resolved).
export async function getIgnores() {
  const r = await api(`/rest/db/ignores?folder=${encodeURIComponent(FOLDER)}`);
  return { ignore: r.ignore ?? [], expanded: r.expanded ?? [] };
}

// Writing through the API applies the new rules immediately (it also writes .stignore).
export async function setIgnores(lines) {
  await api(`/rest/db/ignores?folder=${encodeURIComponent(FOLDER)}`, { method: 'POST', body: { ignore: lines } });
}

// Ask Syncthing to rescan now (after git changed files) instead of waiting for the watcher.
export const rescan = () => api(`/rest/db/scan?folder=${encodeURIComponent(FOLDER)}`, { method: 'POST' });

// RemoteChangeDetected names the device by its short ID (first 7 chars).
async function deviceName(shortId) {
  const find = () => [...deviceNames].find(([id]) => id.startsWith(shortId))?.[1];
  if (!find()) {
    try {
      const devices = await api('/rest/config/devices');
      deviceNames = new Map(devices.map(d => [d.deviceID, d.name || d.deviceID.slice(0, 7)]));
    } catch { /* fall back to the short ID */ }
  }
  return find() ?? shortId;
}

// One log line per changed file. Git-ignored paths (Obsidian's workspace
// files, rewritten constantly) only log at debug level.
async function logChanges(changes) {
  let shown = 0;
  let hidden = 0;
  for (const ev of changes) {
    const { action, type, path, modifiedBy } = ev.data;
    const kind = action === 'deleted' ? null : await pathKind(path).catch(() => null);
    const verb = action === 'deleted' ? 'deleted' : kind === 'new' ? 'created' : 'edited';
    const what = type === 'dir' ? 'Folder' : 'File';
    const source = ev.type === 'RemoteChangeDetected' ? `from ${await deviceName(modifiedBy)}` : 'on server';
    const line = `${what} ${verb} ${source}: ${path}`;
    if (kind === 'ignored') log.debug(line);
    else if (shown++ < MAX_CHANGE_LINES) log.info(line);
    else hidden++;
  }
  if (hidden) log.info(`…and ${hidden} more file changes`);
}

async function checkRestart() {
  const sys = await api('/rest/system/status');
  if (startTime && sys.startTime !== startTime) {
    log.warn('Syncthing restarted — resetting event cursor');
    lastEventId = 0;
    watcher.emit('resync');
  }
  startTime = sys.startTime;
}

async function pollOnce() {
  pollAbort = new AbortController();
  const events = await api(
    `${EVENTS}&since=${lastEventId}&timeout=${LONG_POLL_S}`,
    { timeoutMs: (LONG_POLL_S + 15) * 1000, signal: pollAbort.signal },
  );

  if (!events.length) return checkRestart();

  const changes = [];
  for (const ev of events) {
    lastEventId = Math.max(lastEventId, ev.id);
    if (ev.data?.folder !== FOLDER) continue;
    if (ev.type === 'LocalChangeDetected' || ev.type === 'RemoteChangeDetected') {
      changes.push(ev);
    } else if (ev.type === 'StateChanged') {
      log.debug('Syncthing state', { from: ev.data.from, to: ev.data.to });
      watcher.emit('state', ev.data.to);
      if (ev.data.to === 'idle') watcher.emit('idle');
    } else if (ev.type === 'FolderErrors') {
      const errors = ev.data.errors ?? [];
      log.warn('Syncthing folder errors', { count: errors.length, first: errors[0] });
      if (errors.length) alert('folder-errors', 'Syncthing folder errors', `${errors.length} file(s) failed to sync, e.g. ${errors[0].path}: ${errors[0].error}`);
    }
  }
  if (changes.length) await logChanges(changes);
}

export async function start() {
  running = true;
  let backoff = 5_000;
  let connected = false;

  while (running) {
    try {
      if (!connected) {
        await checkRestart();
        // Skip the backlog: on (re)connect we reconcile from current state instead.
        const latest = await api(`${EVENTS}&since=0&limit=1&timeout=0`);
        lastEventId = latest.at(-1)?.id ?? 0;
        const s = await folderStatus();
        watcher.emit('state', s.state);
        log.info('Connected to Syncthing', { folder: FOLDER, state: s.state, needTotalItems: s.needTotalItems });
        connected = true;
        backoff = 5_000;
        if (downSince) resolve('syncthing-down');
        downSince = null;
        watcher.emit('resync');
      }
      await pollOnce();
    } catch (err) {
      if (!running) break;
      connected = false;
      downSince ??= Date.now();
      log.error(`Syncthing API error — retrying in ${backoff / 1000}s`, { err: err.message });
      if (Date.now() - downSince > UNREACHABLE_ALERT_MS) {
        alert('syncthing-down', 'Syncthing unreachable', `The bridge cannot reach the Syncthing API: ${err.message}`);
      }
      watcher.emit('state', 'unreachable');
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function stop() {
  running = false;
  pollAbort?.abort();
}
