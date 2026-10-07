import { logInfo } from './logger.js';

// Static Factory API key auth: FACTORY_API_KEY never expires, so there is no
// refresh flow and no droid credential file reading. The key is injected via
// environment variables (e.g. the launchd plist).
let apiKey = null;
let orgId = null;

/**
 * Initialize auth system - validate the required FACTORY_API_KEY environment
 * variable and pick up the optional FACTORY_ORG_ID used for x-factory-org-id.
 */
export function initializeAuth() {
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
