import config from './config.js';
import { log } from './logger.js';
import { start as startWatcher, watcher } from './syncthingWatcher.js';
import { commitAndPush, pull } from './gitManager.js';
import { startDashboard } from './dashboard/server.js';

let debounceTimer = null;

function scheduleCommit() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    log.info('Debounce elapsed — running commit & push');
    await commitAndPush();
  }, config.debounceMs);
  log.info(`Commit scheduled in ${config.debounceMs / 1000}s`);
}

watcher.on('syncComplete', () => {
  log.info('Sync complete signal received');
  scheduleCommit();
});

// Periodic pull from remote
async function schedulePull() {
  while (true) {
    await new Promise(r => setTimeout(r, config.pullIntervalMs));
    log.info('Scheduled pull from remote');
    await pull();
  }
}

log.info('Git-Syncthing Bridge starting', {
  vault: config.vaultPath,
  dashboardPort: config.dashboardPort,
  debounceMs: config.debounceMs,
  pullIntervalMs: config.pullIntervalMs,
});

startDashboard();
schedulePull();
startWatcher();
