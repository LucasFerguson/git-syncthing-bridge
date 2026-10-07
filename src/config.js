import 'dotenv/config';

const config = {
  vaultPath: process.env.VAULT_PATH || '/opt/vault/obsidian-vault',
  syncthingApiUrl: process.env.SYNCTHING_API_URL || 'http://127.0.0.1:8384',
  syncthingApiKey: process.env.SYNCTHING_API_KEY || '',
  syncthingFolderId: process.env.SYNCTHING_FOLDER_ID || '',
  debounceMs: parseInt(process.env.DEBOUNCE_MS || '15000'),
  pullIntervalMs: parseInt(process.env.PULL_INTERVAL_MS || '300000'),
  vaultRemote: process.env.VAULT_REMOTE || '',
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000'),
};

const missing = ['syncthingApiKey', 'syncthingFolderId', 'vaultRemote']
  .filter(k => !config[k]);

if (missing.length) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export default config;
