import config from './config.js';
import { log } from './logger.js';
import { sendNow } from './notify.js';
import { ensureVaultFiles } from './vaultFiles.js';
import * as st from './syncthing.js';
import { requestCycle, startup, shutdown } from './sync.js';
import { startDashboard, stopDashboard } from './dashboard/server.js';

let debounceTimer = null;

function scheduleCycle(trigger) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => requestCycle(trigger), config.debounceMs);
  log.debug(`Cycle scheduled in ${config.debounceMs / 1000}s`, { trigger });
}

// Fatal errors: tell the user, then exit and let systemd restart us.
async function die(kind, err) {
  log.error(`${kind} — exiting`, { err: err?.stack || String(err) });
  await Promise.race([
    sendNow('Bridge crashed', `${kind}: ${err?.message || err}\nsystemd will restart it.`, 'high'),
    new Promise(r => setTimeout(r, 5_000)),
  ]);
  process.exit(1);
}
process.on('uncaughtException', err => die('Uncaught exception', err));
process.on('unhandledRejection', err => die('Unhandled rejection', err));

async function stop(signal) {
  log.info(`${signal} received — shutting down`);
  clearTimeout(debounceTimer);
  st.stop();
  await shutdown();
  await stopDashboard();
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

log.info('Git-Syncthing Bridge starting', {
  vault: config.vaultPath,
  folder: config.syncthingFolderId,
  commitMode: config.commitMode,
  conflictPolicy: config.conflictPolicy,
  notifications: config.notifyUrl ? 'on' : 'off (NOTIFY_URL unset)',
});

startDashboard();

// Syncthing reachable and folder settled? → cycle. Missed events are covered
// by 'resync' (reconnect/restart) and the periodic timer below.
st.watcher.on('idle', () => scheduleCycle('syncthing-idle'));
st.watcher.on('resync', () => scheduleCycle('syncthing-resync'));
setInterval(() => requestCycle('timer'), config.pullIntervalMs);

try {
  // Syncthing may still be starting after a reboot; both steps need its API
  // (.stignore is written through it), so retry for a few minutes.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureVaultFiles();
      await startup();
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      log.warn('Startup reconciliation failed — retrying in 15s', { err: err.message });
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
} catch (err) {
  await die('Startup failed', err);
}

st.start();
