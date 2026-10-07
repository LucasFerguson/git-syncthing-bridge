import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Exit code for configuration errors. The systemd unit lists it in
// RestartPreventExitStatus so a bad config fails once instead of crash-looping.
export const EX_CONFIG = 78;

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(EX_CONFIG);
}

function int(name, def, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

// Read the API key straight from Syncthing's config so there is one source of
// truth and rotating the key in the GUI does not break the bridge.
function syncthingApiKey() {
  if (process.env.SYNCTHING_API_KEY) return process.env.SYNCTHING_API_KEY;
  const path = process.env.SYNCTHING_CONFIG || join(homedir(), '.local/state/syncthing/config.xml');
  if (!existsSync(path)) return '';
  const m = readFileSync(path, 'utf8').match(/<apikey>([^<]+)<\/apikey>/);
  return m ? m[1] : '';
}

const config = {
  vaultPath: process.env.VAULT_PATH || '/opt/vault/obsidian-vault',
  gitBranch: process.env.GIT_BRANCH || 'main',
  syncthingApiUrl: (process.env.SYNCTHING_API_URL || 'http://127.0.0.1:8384').replace(/\/$/, ''),
  syncthingApiKey: syncthingApiKey(),
  syncthingFolderId: process.env.SYNCTHING_FOLDER_ID || '',

  // Quiet period after Syncthing reports idle before touching git.
  debounceMs: int('DEBOUNCE_MS', 15_000),
  // How often to fetch from the remote (also a fallback trigger if events are missed).
  pullIntervalMs: int('PULL_INTERVAL_MS', 300_000, 30_000),
  // "daily": one commit per calendar day, amended locally, pushed after midnight.
  // "immediate": a commit per idle period, pushed right away.
  commitMode: process.env.COMMIT_MODE || 'daily',
  // Untracked files larger than this are excluded from git (still synced by
  // Syncthing). GitHub rejects any push containing a file over 100 MB, so one
  // big video would otherwise block every push from then on.
  maxFileMb: int('MAX_FILE_MB', 95, 1),
  // "warn": alert on .sync-conflict files but keep committing other notes.
  // "block": no commits at all until every conflict copy is resolved.
  conflictPolicy: process.env.CONFLICT_POLICY || 'warn',
  // Keep .obsidian (plugins, themes, settings) out of Syncthing so the phone
  // and the vault repo each keep their own configuration.
  syncthingIgnoreObsidian: (process.env.SYNCTHING_IGNORE_OBSIDIAN ?? 'true') !== 'false',
  // Note in the vault (relative path) with sync status and phone setup; empty disables it.
  statusNote: process.env.STATUS_NOTE ?? 'Vault Sync Status.md',

  notifyUrl: process.env.NOTIFY_URL || '',
  notifyToken: process.env.NOTIFY_TOKEN || '',

  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',
  dashboardPort: int('DASHBOARD_PORT', 3000, 1),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  logLevel: process.env.LOG_LEVEL || 'info',
};

const missing = [
  ['SYNCTHING_API_KEY (or a readable Syncthing config.xml)', config.syncthingApiKey],
  ['SYNCTHING_FOLDER_ID', config.syncthingFolderId],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) fail(`Missing required settings: ${missing.join(', ')}`);

if (!['daily', 'immediate'].includes(config.commitMode)) fail(`COMMIT_MODE must be "daily" or "immediate"`);
if (!['warn', 'block'].includes(config.conflictPolicy)) fail(`CONFLICT_POLICY must be "warn" or "block"`);
if (!existsSync(join(config.vaultPath, '.git'))) fail(`${config.vaultPath} is not a git repository — run scripts/init-vault.sh first`);

export default config;
