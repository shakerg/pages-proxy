/**
 * Utility functions for input sanitization
 */

/**
 * Sanitizes string inputs for database storage
 * Note: SQL injection is prevented by parameterized queries (prepared statements).
 * This function only validates input format and length.
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
  
  // Trim whitespace and enforce max length to prevent DOS
  const sanitized = input.trim();
  
  if (sanitized.length > 2048) {
    throw new Error('Input exceeds maximum allowed length (2048 characters)');
  }
  
  return sanitized;
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