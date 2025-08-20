/**
 * Custom logger with sensitive data masking
 */

// List of patterns to mask in logs
const SENSITIVE_PATTERNS = [
  { regex: /(Bearer\s+)([A-Za-z0-9-._~+/]+=*)/g, replacement: '$1[REDACTED]' }, // Bearer tokens
  { regex: /(Authorization:\s*Bearer\s+)([A-Za-z0-9-._~+/]+=*)/g, replacement: '$1[REDACTED]' }, // Auth headers
  { regex: /(token["']?\s*[=:]\s*["']?)([A-Za-z0-9-._~+/]+=*)(["']?)/g, replacement: '$1[REDACTED]$3' }, // Token assignments
  { regex: /(password["']?\s*[=:]\s*["']?)(.+?)(["']?)/g, replacement: '$1[REDACTED]$3' }, // Passwords
  { regex: /(key["']?\s*[=:]\s*["']?)(.+?)(["']?)/g, replacement: '$1[REDACTED]$3' }, // API keys
  { regex: /(secret["']?\s*[=:]\s*["']?)(.+?)(["']?)/g, replacement: '$1[REDACTED]$3' }, // Secrets
  { regex: /-----BEGIN[^-]+?PRIVATE KEY-----[^-]+?-----END[^-]+?PRIVATE KEY-----/gs, replacement: '[REDACTED PRIVATE KEY]' }, // Private keys
];

/**
 * Mask sensitive data in a log message
 * @param {string} message - The message to mask
 * @returns {string} The masked message
 */
function maskSensitiveData(message) {
  if (typeof message !== 'string') {
    return message;
  }

  let maskedMessage = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    maskedMessage = maskedMessage.replace(pattern.regex, pattern.replacement);
  }
  return maskedMessage;
}

/**
 * Format arguments for logging
 * @param {Array} args - Arguments to format
 * @returns {string} Formatted string with sensitive data masked
 */
function formatArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'string') {
      return maskSensitiveData(arg);
    } else if (arg instanceof Error) {
      const maskedError = new Error(maskSensitiveData(arg.message));
      maskedError.stack = maskSensitiveData(arg.stack);
      return maskedError;
    } else if (arg instanceof Object) {
      try {
        const stringified = JSON.stringify(arg);
        return maskSensitiveData(stringified);
      } catch (e) {
        return '[Object that cannot be stringified]';
      }
    }
    return arg;
  });
}

/**
 * Get the current timestamp for log entries
 * @returns {string} Formatted timestamp
 */
function timestamp() {
  return new Date().toISOString();
}

const logger = {
  error(...args) {
    console.error(`[ERROR] ${timestamp()}:`, ...formatArgs(args));
  },
  
  warn(...args) {
    console.warn(`[WARN] ${timestamp()}:`, ...formatArgs(args));
  },
  
  info(...args) {
    console.info(`[INFO] ${timestamp()}:`, ...formatArgs(args));
  },
  
  debug(...args) {
    if (process.env.DEBUG) {
      console.debug(`[DEBUG] ${timestamp()}:`, ...formatArgs(args));
    }
  },
  
  trace(...args) {
    if (process.env.TRACE) {
      console.trace(`[TRACE] ${timestamp()}:`, ...formatArgs(args));
    }
  }
};

module.exports = logger;