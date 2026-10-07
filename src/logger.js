import { EventEmitter } from 'events';

export const bus = new EventEmitter();

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

function emit(level, message, data = {}) {
  const entry = {
    level: LEVELS[level],
    message,
    data,
    timestamp: new Date().toISOString(),
  };
  const line = `[${entry.timestamp}] [${entry.level}] ${message}`;
  if (data && Object.keys(data).length) {
    console[level === 'error' ? 'error' : 'log'](line, data);
  } else {
    console[level === 'error' ? 'error' : 'log'](line);
  }
  bus.emit('log', entry);
}

export const log = {
  info:  (msg, data) => emit('info', msg, data),
  warn:  (msg, data) => emit('warn', msg, data),
  error: (msg, data) => emit('error', msg, data),
  debug: (msg, data) => emit('debug', msg, data),
};
