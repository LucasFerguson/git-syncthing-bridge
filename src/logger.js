import { EventEmitter } from 'events';

// Logs go to stdout/stderr only; under systemd they land in journald, which
// handles timestamps, rotation and size limits. No log files to rotate.

export const bus = new EventEmitter();

const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = ORDER[process.env.LOG_LEVEL] ?? ORDER.info;

function emit(level, message, data) {
  const entry = { level: level.toUpperCase(), message, data: data ?? {}, timestamp: new Date().toISOString() };
  if (ORDER[level] >= threshold) {
    const extra = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    (level === 'error' || level === 'warn' ? console.error : console.log)(`[${entry.level}] ${message}${extra}`);
  }
  if (level !== 'debug') bus.emit('log', entry);
}

export const log = {
  debug: (msg, data) => emit('debug', msg, data),
  info:  (msg, data) => emit('info', msg, data),
  warn:  (msg, data) => emit('warn', msg, data),
  error: (msg, data) => emit('error', msg, data),
};
