import config from './config.js';
import { log } from './logger.js';

// Alerting with de-duplication: an alert fires when a problem starts, repeats
// at most once a day while it persists, and sends a "resolved" message when it
// clears. NOTIFY_URL is an ntfy topic URL (plain-text POST with a Title header),
// which also works with most generic webhooks. Without it, alerts are log-only.

const REPEAT_MS = 24 * 60 * 60 * 1000;
const active = new Map(); // key -> { title, since, lastSent }

async function send(title, message, priority = 'default') {
  if (!config.notifyUrl) return;
  try {
    const headers = { Title: `Vault: ${title}`, Priority: priority, 'Content-Type': 'text/plain' };
    if (config.notifyToken) headers.Authorization = `Bearer ${config.notifyToken}`;
    const res = await fetch(config.notifyUrl, {
      method: 'POST', headers, body: message, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn('Notification rejected', { status: res.status });
  } catch (err) {
    log.warn('Notification failed', { err: err.message });
  }
}

export function alert(key, title, message) {
  const now = Date.now();
  const a = active.get(key);
  if (a && now - a.lastSent < REPEAT_MS) return;
  active.set(key, { title, since: a?.since ?? now, lastSent: now });
  log.warn(`ALERT ${title}: ${message}`);
  return send(title, message, 'high');
}

export function resolve(key) {
  const a = active.get(key);
  if (!a) return;
  active.delete(key);
  log.info(`Resolved: ${a.title}`);
  return send(`${a.title} — resolved`, 'Back to normal.', 'low');
}

export function activeAlerts() {
  return [...active.entries()].map(([key, a]) => ({ key, title: a.title, since: new Date(a.since).toISOString() }));
}

export { send as sendNow };
