import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from './logger.js';
import { getNextProxyAgent } from './proxy-manager.js';

// State management for API key and refresh
let currentApiKey = null;
let currentRefreshToken = null;
let lastRefreshTime = null;
let clientId = null;
let authSource = null; // 'env' or 'file' or 'factory_key' or 'v2' or 'client'
let authFilePath = null;
let factoryApiKey = null; // From FACTORY_API_KEY environment variable
let currentOrgId = null; // Active Factory organization id
let v2Credentials = null; // Raw payload of ~/.factory/auth.v2.loginkeychain

const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const REFRESH_INTERVAL_HOURS = 6; // Refresh every 6 hours
const TOKEN_VALID_HOURS = 8; // Token valid for 8 hours

// New droid CLI credential storage (AES-256-GCM, key kept in the macOS Keychain)
const V2_CREDENTIALS_PATH = path.join(os.homedir(), '.factory', 'auth.v2.loginkeychain');
const KEYCHAIN_SERVICE = 'Factory CLI';
const KEYCHAIN_ACCOUNTS = ['auth-encryption-key-security-cli', 'auth-encryption-key'];

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: 26 characters using Crockford's Base32
 * First 10 chars: timestamp (48 bits)
 * Last 16 chars: random (80 bits)
 */
function generateULID() {
  // Crockford's Base32 alphabet (no I, L, O, U to avoid confusion)
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  
  // Get timestamp in milliseconds
  const timestamp = Date.now();
  
  // Encode timestamp to 10 characters
  let time = '';
  let ts = timestamp;
  for (let i = 9; i >= 0; i--) {
    const mod = ts % 32;
    time = ENCODING[mod] + time;
    ts = Math.floor(ts / 32);
  }
  
  // Generate 16 random characters
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    const rand = Math.floor(Math.random() * 32);
    randomPart += ENCODING[rand];
  }
  
  return time + randomPart;
}

/**
 * Generate a client ID in format: client_01{ULID}
 */
function generateClientId() {
  const ulid = generateULID();
  return `client_01${ulid}`;
}

/**
 * Read the AES-256-GCM key droid stores in the macOS Keychain.
 */
function readKeychainKey() {
  for (const account of KEYCHAIN_ACCOUNTS) {
    try {
      const value = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (value) {
        const key = Buffer.from(value, 'base64');
        if (key.length === 32) {
          logDebug(`Loaded credential encryption key from keychain account "${account}"`);
          return key;
        }
        logDebug(`Keychain account "${account}" returned an unexpected key length: ${key.length}`);
      }
    } catch (error) {
      logDebug(`Keychain lookup failed for account "${account}": ${error.message}`);
    }
  }
  return null;
}

/**
 * Decrypt a droid v2 credential payload. Format: iv:authTag:ciphertext (all base64).
 */
function decryptV2Credentials(raw, key) {
  const parts = raw.trim().split(':');
  if (parts.length !== 3) {
    throw new Error('Unexpected auth.v2 credential format');
  }

  const [iv, authTag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

/**
 * Load credentials written by droid >= 0.2xx (~/.factory/auth.v2.loginkeychain).
 */
function loadV2Credentials() {
  try {
    if (!fs.existsSync(V2_CREDENTIALS_PATH)) {
      return null;
    }

    const key = readKeychainKey();
    if (!key) {
      logError('Cannot read the droid credential encryption key from the macOS Keychain');
      return null;
    }

    const data = decryptV2Credentials(fs.readFileSync(V2_CREDENTIALS_PATH, 'utf-8'), key);
    if (!data || typeof data !== 'object') {
      return null;
    }

    v2Credentials = data;
    return data;
  } catch (error) {
    logError(`Failed to load ${V2_CREDENTIALS_PATH}`, error);
    return null;
  }
}

/**
 * Persist refreshed tokens back into the droid v2 credential file, re-encrypted
 * with the same Keychain key so the droid CLI keeps working.
 */
function saveV2Tokens(accessToken, refreshToken) {
  try {
    const key = readKeychainKey();
    if (!key || !v2Credentials) {
      logError('Skipping credential save: encryption key or previous payload unavailable');
      return;
    }

    const payload = {
      ...v2Credentials,
      access_token: accessToken,
      refresh_token: refreshToken
    };

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encoded = `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;

    fs.writeFileSync(V2_CREDENTIALS_PATH, encoded, { mode: 0o600 });
    v2Credentials = payload;
    logDebug(`Tokens saved to ${V2_CREDENTIALS_PATH}`);
  } catch (error) {
    logError('Failed to save tokens to the droid v2 credential file', error);
  }
}

/**
 * Factory-side organization id carried in the access token, used for the
 * x-factory-org-id upstream header.
 *
 * The WorkOS refresh response also returns an `organization_id`, but that is
 * WorkOS' own organization record id. The Factory gateway does not know it, so
 * never promote it to the active organization.
 */
function getTokenExternalOrgId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.external_org_id === 'string' && payload.external_org_id
      ? payload.external_org_id
      : null;
  } catch (error) {
    return null;
  }
}

/**
 * Access token expiry (ms since epoch) parsed from a JWT, or null when unavailable.
 */
function getTokenExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch (error) {
    return null;
  }
}

/**
 * Load auth configuration with priority system
 * Priority: FACTORY_API_KEY > refresh token mechanism > client authorization
 */
function loadAuthConfig() {
  // 1. Check FACTORY_API_KEY environment variable (highest priority)
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    logInfo('Using fixed API key from FACTORY_API_KEY environment variable');
    factoryApiKey = factoryKey.trim();
    authSource = 'factory_key';

    // Still pick up the active organization from the droid credential file when present,
    // so upstream calls carry x-factory-org-id.
    const v2 = loadV2Credentials();
    currentOrgId = (v2?.access_token ? getTokenExternalOrgId(v2.access_token) : null)
      || v2?.active_organization_id
      || null;

    return { type: 'factory_key', value: factoryKey.trim() };
  }

  // 2. Check refresh token mechanism (DROID_REFRESH_KEY)
  const envRefreshKey = process.env.DROID_REFRESH_KEY;
  if (envRefreshKey && envRefreshKey.trim() !== '') {
    logInfo('Using refresh token from DROID_REFRESH_KEY environment variable');
    authSource = 'env';
    authFilePath = path.join(process.cwd(), 'auth.json');
    return { type: 'refresh', value: envRefreshKey.trim() };
  }

  // 3. Check the current droid credential storage (~/.factory/auth.v2.loginkeychain)
  const v2 = loadV2Credentials();
  if (v2) {
    currentOrgId = (v2.access_token ? getTokenExternalOrgId(v2.access_token) : null)
      || v2.active_organization_id
      || null;

    if (v2.refresh_token) {
      logInfo('Using credentials from ~/.factory/auth.v2.loginkeychain');
      authSource = 'v2';
      authFilePath = V2_CREDENTIALS_PATH;
      currentApiKey = v2.access_token ?? null;
      currentRefreshToken = v2.refresh_token;

      // Treat the stored access token as fresh until it actually nears expiry.
      const expiryMs = currentApiKey ? getTokenExpiryMs(currentApiKey) : null;
      lastRefreshTime = expiryMs
        ? expiryMs - REFRESH_INTERVAL_HOURS * 60 * 60 * 1000
        : Date.now();

      return { type: 'refresh', value: v2.refresh_token };
    }

    if (v2.access_token) {
      logInfo('Using access token from ~/.factory/auth.v2.loginkeychain (no refresh token present)');
      authSource = 'v2-fixed';
      currentApiKey = v2.access_token;
      return { type: 'fixed', value: v2.access_token };
    }
  }

  // 4. Check ~/.factory/auth.json (legacy droid storage)
  const homeDir = os.homedir();
  const factoryAuthPath = path.join(homeDir, '.factory', 'auth.json');
  
  try {
    if (fs.existsSync(factoryAuthPath)) {
      const authContent = fs.readFileSync(factoryAuthPath, 'utf-8');
      const authData = JSON.parse(authContent);
      
      if (authData.refresh_token && authData.refresh_token.trim() !== '') {
        logInfo('Using refresh token from ~/.factory/auth.json');
        authSource = 'file';
        authFilePath = factoryAuthPath;
        
        // Also load access_token if available
        if (authData.access_token) {
          currentApiKey = authData.access_token.trim();
        }
        
        return { type: 'refresh', value: authData.refresh_token.trim() };
      }
    }
  } catch (error) {
    logError('Error reading ~/.factory/auth.json', error);
  }

  // 5. No configured auth found - will use client authorization
  logInfo('No auth configuration found, will use client authorization headers');
  authSource = 'client';
  return { type: 'client', value: null };
}

/**
 * Refresh API key using refresh token
 */
async function refreshApiKey() {
  if (!currentRefreshToken) {
    throw new Error('No refresh token available');
  }

  if (!clientId) {
    clientId = 'client_01HNM792M5G5G1A2THWPXKFMXB';
    logDebug(`Using fixed client ID: ${clientId}`);
  }

  logInfo('Refreshing API key...');

  try {
    // Create form data
    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', currentRefreshToken);
    formData.append('client_id', clientId);

    const proxyAgentInfo = getNextProxyAgent(REFRESH_URL);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    };

    if (proxyAgentInfo?.agent) {
      fetchOptions.agent = proxyAgentInfo.agent;
    }

    const response = await fetch(REFRESH_URL, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    // Update tokens
    currentApiKey = data.access_token;
    currentRefreshToken = data.refresh_token;
    lastRefreshTime = Date.now();

    // Log user info
    if (data.user) {
      logInfo(`Authenticated as: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
      logInfo(`User ID: ${data.user.id}`);
    }

    // Only the token's external_org_id is usable upstream; the WorkOS
    // organization_id is a different identifier the Factory gateway rejects.
    const externalOrgId = getTokenExternalOrgId(data.access_token);
    if (externalOrgId) {
      currentOrgId = externalOrgId;
      logInfo(`Factory organization ID: ${externalOrgId}`);
    }

    // Save tokens back to the storage they came from
    if (authSource === 'v2') {
      saveV2Tokens(data.access_token, data.refresh_token);
    } else {
      saveTokens(data.access_token, data.refresh_token);
    }

    logInfo(`New Refresh-Key: ${currentRefreshToken}`);
    logInfo('API key refreshed successfully');
    return data.access_token;

  } catch (error) {
    logError('Failed to refresh API key', error);
    throw error;
  }
}

/**
 * Save tokens to appropriate file
 */
function saveTokens(accessToken, refreshToken) {
  try {
    const authData = {
      access_token: accessToken,
      refresh_token: refreshToken,
      last_updated: new Date().toISOString()
    };

    // Ensure directory exists
    const dir = path.dirname(authFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // If saving to ~/.factory/auth.json, preserve other fields
    if (authSource === 'file' && fs.existsSync(authFilePath)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
        Object.assign(authData, existingData, {
          access_token: accessToken,
          refresh_token: refreshToken,
          last_updated: authData.last_updated
        });
      } catch (error) {
        logError('Error reading existing auth file, will overwrite', error);
      }
    }

    fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2), 'utf-8');
    logDebug(`Tokens saved to ${authFilePath}`);

  } catch (error) {
    logError('Failed to save tokens', error);
  }
}

/**
 * Check if API key needs refresh (older than 6 hours)
 */
function shouldRefresh() {
  if (!lastRefreshTime) {
    return true;
  }

  const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60);
  return hoursSinceRefresh >= REFRESH_INTERVAL_HOURS;
}

/**
 * Initialize auth system - load auth config and setup initial API key if needed
 */
export async function initializeAuth() {
  try {
    const authConfig = loadAuthConfig();
    
    if (authConfig.type === 'factory_key') {
      // Using fixed FACTORY_API_KEY, no refresh needed
      logInfo('Auth system initialized with fixed API key');
    } else if (authConfig.type === 'fixed') {
      // Using a stored access token without a refresh token
      logInfo('Auth system initialized with stored access token');
    } else if (authConfig.type === 'refresh') {
      // Using refresh token mechanism
      currentRefreshToken = authConfig.value;

      if (authSource === 'v2') {
        // Credentials written by the droid CLI; only refresh when the access token is stale.
        if (shouldRefresh()) {
          logInfo('Stored access token is expired or near expiry, refreshing...');
          await refreshApiKey();
        } else {
          logInfo('Using unexpired access token from ~/.factory/auth.v2.loginkeychain');
        }
      } else {
        // Always refresh on startup to get fresh token
        await refreshApiKey();
      }

      logInfo('Auth system initialized with refresh token mechanism');
    } else {
      // Using client authorization, no setup needed
      logInfo('Auth system initialized for client authorization mode');
    }
    
    logInfo('Auth system initialized successfully');
  } catch (error) {
    logError('Failed to initialize auth system', error);
    throw error;
  }
}

/**
 * Active Factory organization id, used for the x-factory-org-id upstream header.
 */
export function getOrgId() {
  return process.env.FACTORY_ORG_ID || currentOrgId || null;
}

/**
 * Get API key based on configured authorization method
 * @param {string} clientAuthorization - Authorization header from client request (optional)
 */
export async function getApiKey(clientAuthorization = null) {
  // Priority 1: FACTORY_API_KEY environment variable
  if (authSource === 'factory_key' && factoryApiKey) {
    return `Bearer ${factoryApiKey}`;
  }

  // Priority 2: stored access token without a refresh token
  if (authSource === 'v2-fixed') {
    if (!currentApiKey) {
      throw new Error('No API key available from ~/.factory/auth.v2.loginkeychain.');
    }
    return `Bearer ${currentApiKey}`;
  }
  
  // Priority 3: Refresh token mechanism
  if (authSource === 'env' || authSource === 'file' || authSource === 'v2') {
    // Check if we need to refresh
    if (shouldRefresh()) {
      logInfo('API key needs refresh (6+ hours old)');
      await refreshApiKey();
    }

    if (!currentApiKey) {
      throw new Error('No API key available from refresh token mechanism.');
    }

    return `Bearer ${currentApiKey}`;
  }
  
  // Priority 4: Client authorization header
  if (clientAuthorization) {
    logDebug('Using client authorization header');
    return clientAuthorization;
  }
  
  // No authorization available
  throw new Error('No authorization available. Please configure FACTORY_API_KEY, refresh token, or provide client authorization.');
}
