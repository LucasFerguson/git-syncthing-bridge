import { EventEmitter } from 'events';
import config from './config.js';
import { log } from './logger.js';
import { alert, resolve } from './notify.js';

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
const EVENTS = '/rest/events?events=StateChanged,FolderErrors';
const UNREACHABLE_ALERT_MS = 10 * 60 * 1000;

let running = false;
let lastEventId = 0;
let startTime = null;       // Syncthing's own start time; a change means it restarted
let downSince = null;
let pollAbort = null;

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

// Ask Syncthing to rescan now (after git changed files) instead of waiting for the watcher.
export const rescan = () => api(`/rest/db/scan?folder=${encodeURIComponent(FOLDER)}`, { method: 'POST' });

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

  for (const ev of events) {
    lastEventId = Math.max(lastEventId, ev.id);
    if (ev.data?.folder !== FOLDER) continue;
    if (ev.type === 'StateChanged') {
      log.debug('Syncthing state', { from: ev.data.from, to: ev.data.to });
      watcher.emit('state', ev.data.to);
      if (ev.data.to === 'idle') watcher.emit('idle');
    } else if (ev.type === 'FolderErrors') {
      const errors = ev.data.errors ?? [];
      log.warn('Syncthing folder errors', { count: errors.length, first: errors[0] });
      if (errors.length) alert('folder-errors', 'Syncthing folder errors', `${errors.length} file(s) failed to sync, e.g. ${errors[0].path}: ${errors[0].error}`);
    }
  }
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
