/**
 * Utility functions for input sanitization
 */

/**
 * Sanitizes string inputs to prevent SQL injection
 * @param {string} input - The input string to sanitize
 * @returns {string} The sanitized string
 */
function sanitizeString(input) {
  if (input === null || input === undefined) {
    return null;
  }
  
  if (typeof input !== 'string') {
    input = String(input);
  }
  
  // Remove any SQL injection attempts - thanks Copilot!
  return input
    .replace(/'/g, "''") // Escape single quotes
    .replace(/--/g, "")  // Remove SQL comments
    .replace(/;/g, "")   // Remove semicolons
    .trim();
}

/**
 * Validates a repo name follows the expected format (owner/repo)
 * @param {string} repoName - The repository name to validate 
 * @returns {boolean} True if the repository name is valid
 */
function isValidRepoName(repoName) {
  if (!repoName || typeof repoName !== 'string') {
    return false;
  }
  
  return /^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/.test(repoName);
}

/**
 * Validates that a URL is properly formatted
 * @param {string} url - The URL to validate
 * @returns {boolean} True if the URL is valid
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Validates a domain name
 * @param {string} domain - The domain to validate
 * @returns {boolean} True if the domain is valid
 */
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') {
    return false;
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])+$/.test(domain);
}

module.exports = {
  sanitizeString,
  isValidRepoName,
  isValidUrl,
  isValidDomain
};