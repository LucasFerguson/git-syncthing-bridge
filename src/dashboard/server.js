import express from 'express';
import { createServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config.js';
import { log, bus as logBus } from '../logger.js';
import { activeAlerts } from '../notify.js';
import { getStatus } from '../gitManager.js';
import { listTree } from '../vaultFiles.js';
import { requestCycle, getState, syncEvents } from '../sync.js';
import { watcher } from '../syncthing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);

// ── Auth ─────────────────────────────────────────────────────────────────────

const digest = s => createHash('sha256').update(s).digest();
const expected = digest(`${config.dashboardUser}:${config.dashboardPassword}`);

function authorized(header) {
  const m = /^Basic (.+)$/.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(digest(Buffer.from(m[1], 'base64').toString()), expected);
}

function basicAuth(req, res, next) {
  if (authorized(req.headers.authorization)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="vault-bridge", charset="UTF-8"');
  res.statusCode = 401;
  res.end('Authentication required');
}

app.disable('x-powered-by');
app.use(basicAuth);
// Socket.IO handshakes bypass Express, so guard the engine too. (Its `res` can
// be a stub on WebSocket upgrades, so reject via next(err) rather than res.*.)
io.engine.use((req, _res, next) => next(authorized(req.headers.authorization) ? undefined : new Error('unauthorized')));

// State-changing requests must carry a custom header. Browsers will not add one
// cross-origin without a CORS preflight, which we never grant — blocks CSRF via
// cached Basic credentials.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-bridge'] !== '1') return res.status(403).json({ ok: false, error: 'missing X-Bridge header' });
  next();
});

// ── Live updates ─────────────────────────────────────────────────────────────

const recentLogs = [];
const MAX_LOGS = 300;
let syncthingState = 'unknown';

logBus.on('log', entry => {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  io.emit('log', entry);
});
syncEvents.on('state', s => io.emit('bridgeState', s));
watcher.on('state', s => { syncthingState = s; io.emit('syncState', s); });

io.on('connection', socket => {
  socket.emit('logHistory', recentLogs);
  socket.emit('syncState', syncthingState);
  socket.emit('bridgeState', getState());
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', async (_req, res) => {
  try {
    res.json({
      ok: true,
      syncthing: syncthingState,
      bridge: getState(),
      alerts: activeAlerts(),
      commitMode: config.commitMode,
      git: await getStatus(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Folder and file names only; contents are never served.
app.get('/api/tree', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await listTree()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync', (_req, res) => {
  requestCycle('dashboard');
  res.json({ ok: true });
});

// Push everything now, including today's not-yet-final daily commit.
app.post('/api/push', (_req, res) => {
  requestCycle('dashboard-push', { push: true });
  res.json({ ok: true });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

// The VPN address may not exist yet at boot, so keep retrying the bind.
export function startDashboard() {
  if (!config.dashboardPassword) {
    log.warn('DASHBOARD_PASSWORD not set — dashboard disabled');
    return;
  }
  const listen = () => httpServer.listen(config.dashboardPort, config.dashboardHost);
  httpServer.on('listening', () => log.info(`Dashboard on http://${config.dashboardHost}:${config.dashboardPort}`));
  httpServer.on('error', err => {
    if (['EADDRNOTAVAIL', 'EADDRINUSE'].includes(err.code)) {
      log.warn(`Dashboard cannot bind ${config.dashboardHost}:${config.dashboardPort} (${err.code}) — retrying in 30s`);
      setTimeout(listen, 30_000);
    } else {
      log.error('Dashboard server error', { err: err.message });
    }
  });
  listen();
}

export function stopDashboard() {
  return new Promise(r => {
    io.close();
    httpServer.close(() => r());
    setTimeout(r, 2_000);
  });
}
