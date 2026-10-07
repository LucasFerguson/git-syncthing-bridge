import { simpleGit } from 'simple-git';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import config from './config.js';
import { log } from './logger.js';

export const gitEvents = new EventEmitter();

const git = simpleGit(config.vaultPath);

async function findConflictFiles(dir) {
  const conflicts = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.includes('.sync-conflict-')) conflicts.push(full);
    }
  }
  await walk(dir);
  return conflicts;
}

export async function commitAndPush() {
  try {
    const conflicts = await findConflictFiles(config.vaultPath);
    if (conflicts.length > 0) {
      log.warn('Sync-conflict files detected — skipping commit until resolved', { conflicts });
      gitEvents.emit('conflict', conflicts);
      return { ok: false, reason: 'conflicts', conflicts };
    }

    const status = await git.status();
    if (status.files.length === 0) {
      log.info('No changes to commit');
      return { ok: true, reason: 'nothing-to-commit' };
    }

    const timestamp = new Date().toISOString();
    await git.add('-A');
    const result = await git.commit(`sync: ${timestamp}`);
    log.info('Committed', { hash: result.commit, files: status.files.length });

    await git.push();
    log.info('Pushed to remote');

    gitEvents.emit('commit', { hash: result.commit, files: status.files.length, timestamp });
    return { ok: true, hash: result.commit };
  } catch (err) {
    log.error('commitAndPush failed', { err: err.message });
    gitEvents.emit('error', err.message);
    return { ok: false, reason: err.message };
  }
}

export async function pull() {
  try {
    const result = await git.pull('origin', undefined, { '--rebase': null });
    if (result.summary.changes > 0 || result.summary.insertions > 0) {
      log.info('Pulled changes from remote', result.summary);
    } else {
      log.debug('Pull: already up to date');
    }
    gitEvents.emit('pull', result.summary);
    return { ok: true, summary: result.summary };
  } catch (err) {
    log.error('pull failed', { err: err.message });
    gitEvents.emit('error', err.message);
    return { ok: false, reason: err.message };
  }
}

export async function getStatus() {
  const status = await git.status();
  const log_ = await git.log({ maxCount: 5 });
  return { status, recentCommits: log_.all };
}
