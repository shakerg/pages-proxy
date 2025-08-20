const fs = require('fs');
const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const database = require('../database');
const Mutex = require('./mutex');
const { withRetry } = require('./retry');
const logger = require('./logger');
require('dotenv').config();

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

let tokenCache = null;

const tokenMutex = new Mutex();

/**
 * Determines if an error is retriable for token generation
 * @param {Error} error - The error to check
 * @returns {boolean} - Whether the error should be retried
 */
function isRetriableError(error) {
  // Retry on network errors and rate limiting
  if (error.name === 'FetchError') return true;
  if (error.status === 429) return true; // Rate limiting
  if (error.status >= 500) return true;  // Server errors
  return false; 
}

/**
 * Generates a GitHub App Installation Access Token and stores it in the database
 * 
 * The token will have the following permissions based on the GitHub App:
 * - Contents: Read (to access repository content including CNAME files)
 * - Pages: Write (to read and manage GitHub Pages settings)
 * - Metadata: Read (for basic repository information)
 * 
 * @returns {Promise<string>} The installation access token
 */
async function generateToken() {
  // Use mutex to prevent multiple simultaneous token generation attempts
  return tokenMutex.withLock(async () => {
    try {
      logger.info('Generating new GitHub App installation token...');
      
      if (tokenCache && tokenCache.expiresAt && new Date(tokenCache.expiresAt) > new Date()) {
        logger.info('Using cached token');
        process.env.GITHUB_APP_TOKEN = tokenCache.token;
        return tokenCache.token;
      }
      
      const isExpired = await database.isTokenExpired();
      if (!isExpired) {
        const tokenData = await database.getStoredToken();
        if (tokenData && tokenData.token) {
          logger.info('Using existing valid token from database');
          process.env.GITHUB_APP_TOKEN = tokenData.token;
          
          tokenCache = {
            token: tokenData.token,
            expiresAt: tokenData.expires_at
          };
          
          return tokenData.token;
        }
      }
      
      return withRetry(
        async () => {
          const payload = {
            iat: Math.floor(Date.now() / 1000), // Issued at time
            exp: Math.floor(Date.now() / 1000) + (10 * 60), // Expiration time (10 minutes)
            iss: GITHUB_APP_ID, // GitHub App ID
          };
          
          const token = jwt.sign(payload, GITHUB_APP_PRIVATE_KEY, { algorithm: 'RS256' });
          
          const response = await fetch(`https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            throw Object.assign(
              new Error(`Failed to fetch installation access token: ${response.statusText}, Details: ${errorText}`),
              { status: response.status }
            );
          }
          
          const data = await response.json();
          logger.info('Installation Access Token generated successfully, expires:', data.expires_at);
          
          await database.storeToken({
            token: data.token,
            expires_at: data.expires_at
          });
          
          tokenCache = {
            token: data.token,
            expiresAt: data.expires_at
          };
          
          process.env.GITHUB_APP_TOKEN = data.token;
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
      logger.error('Error generating token:', error.message);
      
      try {
        const tokenData = await database.getStoredToken();
        if (tokenData && tokenData.token) {
          logger.info('Falling back to existing token from database');
          process.env.GITHUB_APP_TOKEN = tokenData.token;
          return tokenData.token;
        }
      } catch (dbError) {
        logger.error('Error retrieving token from database:', dbError);
      }
      
      return process.env.GITHUB_APP_TOKEN;
    }
  });
}

async function checkAndRefreshToken() {
  try {
    const isExpired = await database.isTokenExpired();
    
    if (isExpired) {
      logger.info('Token is expired or will expire soon, refreshing...');
      await generateToken();
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error('Error checking token expiration:', error);
    return false;
  }
}

function setupTokenRefresh() {
  checkAndRefreshToken();
  
  const refreshInterval = 45 * 60 * 1000; 
  setInterval(() => {
    checkAndRefreshToken()
      .then(wasRefreshed => {
        if (wasRefreshed) {
          logger.info('Token refreshed successfully');
        } else {
          logger.debug('Token still valid, no refresh needed');
        }
      })
      .catch(err => logger.error('Failed to refresh token:', err.message));
  }, refreshInterval);
}

/**
 * Invalidate the token cache - useful for testing or forced refreshes
 */
function invalidateCache() {
  tokenCache = null;
}

module.exports = {
  generateToken,
  setupTokenRefresh,
  checkAndRefreshToken,
  invalidateCache
};