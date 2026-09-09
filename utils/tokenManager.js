const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const Mutex = require('./mutex');
const { withRetry } = require('./retry');
const logger = require('./logger');
require('dotenv').config();

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

// Installation access tokens are deliberately memory-only. They are
// short-lived and can be regenerated from the GitHub App private key.
const tokenCache = new Map();
const tokenMutex = new Mutex();
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isRetriableError(error) {
  if (error.name === 'FetchError') return true;
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  return false;
}

function getCachedToken(installationId) {
  const cached = tokenCache.get(String(installationId));
  if (!cached) return null;

  if (new Date(cached.expiresAt).getTime() - EXPIRY_BUFFER_MS <= Date.now()) {
    tokenCache.delete(String(installationId));
    return null;
  }

  return cached.token;
}

/**
 * Generate a short-lived GitHub App installation access token.
 * Tokens are cached in memory only and are never written to SQLite,
 * environment variables, or logs.
 */
async function generateToken(installationId) {
  const targetInstallationId = installationId;
  if (!targetInstallationId || !/^\d+$/.test(String(targetInstallationId))) {
    throw new Error('A numeric GitHub installation ID is required');
  }

  return tokenMutex.withLock(async () => {
    const cachedToken = getCachedToken(targetInstallationId);
    if (cachedToken) {
      return cachedToken;
    }

    try {
      return await withRetry(
        async () => {
          const now = Math.floor(Date.now() / 1000);
          const appJwt = jwt.sign({
            iat: now - 60,
            exp: now + (10 * 60),
            iss: GITHUB_APP_ID,
          }, GITHUB_APP_PRIVATE_KEY, { algorithm: 'RS256' });

          const response = await fetch(`https://api.github.com/app/installations/${targetInstallationId}/access_tokens`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${appJwt}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'pages-proxy'
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw Object.assign(
              new Error(`Failed to fetch installation access token for ${targetInstallationId}: ${response.statusText}, Details: ${errorText}`),
              { status: response.status }
            );
          }

          const data = await response.json();
          tokenCache.set(String(targetInstallationId), {
            token: data.token,
            expiresAt: data.expires_at
          });
          logger.info(`Generated short-lived GitHub App token for installation ${targetInstallationId}`);
          return data.token;
        },
        {
          maxRetries: 5,
          initialDelay: 1000,
          maxDelay: 15000,
          shouldRetry: isRetriableError
        }
      );
    } catch (error) {
      logger.error(`Error generating token for installation ${targetInstallationId}:`, error.message);
      throw error;
    }
  });
}

function invalidateCache(installationId = null) {
  if (installationId === null) {
    tokenCache.clear();
    return;
  }
  tokenCache.delete(String(installationId));
}

module.exports = {
  generateToken,
  invalidateCache
};
