import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config.js';
import { bus as logBus } from '../logger.js';
import { gitEvents, commitAndPush, pull, getStatus } from '../gitManager.js';
import { watcher } from '../syncthingWatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);

// Keep a rolling buffer of recent log entries for new clients
const recentLogs = [];
const MAX_LOGS = 200;

logBus.on('log', entry => {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  io.emit('log', entry);
});

gitEvents.on('commit', data => io.emit('commit', data));
gitEvents.on('pull', data => io.emit('pull', data));
gitEvents.on('conflict', files => io.emit('conflict', files));
gitEvents.on('error', msg => io.emit('gitError', msg));
watcher.on('stateChange', state => io.emit('syncState', state));
watcher.on('syncComplete', () => io.emit('syncComplete'));

app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', async (_req, res) => {
  try {
    const gitStatus = await getStatus();
    res.json({ ok: true, git: gitStatus });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/logs', (_req, res) => res.json(recentLogs));

app.post('/api/pull', async (_req, res) => {
  const result = await pull();
  res.json(result);
});

app.post('/api/commit', async (_req, res) => {
  const result = await commitAndPush();
  res.json(result);
});

io.on('connection', socket => {
  // Replay recent logs so a new browser tab catches up immediately
  socket.emit('logHistory', recentLogs);
});

export function startDashboard() {
  httpServer.listen(config.dashboardPort, () => {
    console.log(`[dashboard] Running at http://localhost:${config.dashboardPort}`);
  });
}
