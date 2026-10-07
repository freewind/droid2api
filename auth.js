import fs from 'fs';
import { fileURLToPath } from 'url';
import { logInfo, logDebug } from './logger.js';

// Static Factory API key auth: FACTORY_API_KEY never expires, so there is no
// refresh flow and no droid credential file reading. The key comes from
// environment variables, or from a .env file in the project root (gitignored).
let apiKey = null;
let orgId = null;

/**
 * Load KEY=VALUE pairs from the .env file in the project root. Real
 * environment variables take precedence and are never overwritten.
 */
function loadEnvFile() {
  const envPath = fileURLToPath(new URL('.env', import.meta.url));
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  logDebug(`Loaded ${envPath}`);
}

/**
 * Initialize auth system - validate the required FACTORY_API_KEY environment
 * variable and pick up the optional FACTORY_ORG_ID used for x-factory-org-id.
 */
export function initializeAuth() {
  loadEnvFile();
  const key = process.env.FACTORY_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('FACTORY_API_KEY environment variable is required.');
  }
  apiKey = key.trim();
  orgId = process.env.FACTORY_ORG_ID?.trim() || null;

  logInfo('Auth system initialized with fixed FACTORY_API_KEY');
  if (orgId) {
    logInfo(`Factory organization ID: ${orgId}`);
  }
}

/**
 * Upstream Authorization header value.
 */
export function getApiKey() {
  return `Bearer ${apiKey}`;
}

/**
 * Active Factory organization id, used for the x-factory-org-id upstream header.
 */
export function getOrgId() {
  return orgId;
}
