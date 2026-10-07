import { EventEmitter } from 'events';
import config from './config.js';
import { log } from './logger.js';

export const watcher = new EventEmitter();

const BASE = config.syncthingApiUrl;
const HEADERS = { 'X-API-Key': config.syncthingApiKey };
const FOLDER = config.syncthingFolderId;

let lastEventId = 0;
let running = false;

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Syncthing API ${res.status}: ${url}`);
  return res.json();
}

async function getFolderStatus() {
  return fetchJson(`${BASE}/rest/db/status?folder=${FOLDER}`);
}

async function pollEvents() {
  const url = `${BASE}/rest/events?events=StateChanged,FolderSummary&folder=${FOLDER}&since=${lastEventId}&timeout=55`;
  const events = await fetchJson(url);

  let sawIdle = false;
  let needItems = null;

  for (const ev of events) {
    if (ev.id > lastEventId) lastEventId = ev.id;

    if (ev.type === 'StateChanged' && ev.data.folder === FOLDER) {
      log.debug('Syncthing state change', { from: ev.data.from, to: ev.data.to });
      watcher.emit('stateChange', ev.data.to);
      if (ev.data.to === 'idle') sawIdle = true;
    }

    if (ev.type === 'FolderSummary' && ev.data.folder === FOLDER) {
      needItems = ev.data.summary?.needTotalItems ?? ev.data.needTotalItems ?? null;
      log.debug('FolderSummary', { needTotalItems: needItems });
    }
  }

  if (sawIdle) {
    // Confirm via direct status query — event data alone can be stale
    const status = await getFolderStatus();
    const isClean = status.state === 'idle' && status.needTotalItems === 0;
    log.info('Syncthing idle', { needTotalItems: status.needTotalItems, clean: isClean });
    if (isClean) watcher.emit('syncComplete');
  }
}

export async function start() {
  running = true;

  // Check current state on startup before waiting for events
  try {
    const status = await getFolderStatus();
    log.info('Syncthing initial state', { state: status.state, needTotalItems: status.needTotalItems });
    if (status.state === 'idle' && status.needTotalItems === 0) {
      log.info('Vault already in sync on startup');
    }
    watcher.emit('stateChange', status.state);
  } catch (err) {
    log.error('Failed to get initial Syncthing status', { err: err.message });
  }

  log.info('Syncthing event watcher started', { folder: FOLDER });

  while (running) {
    try {
      await pollEvents();
    } catch (err) {
      log.error('Syncthing poll error — retrying in 10s', { err: err.message });
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

export function stop() {
  running = false;
}
