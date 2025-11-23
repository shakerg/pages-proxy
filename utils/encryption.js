const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS_LEGACY = 100000; // Legacy iteration count (backward compatibility)
const ITERATIONS_CURRENT = 310000; // OWASP 2023 recommendation for PBKDF2-SHA256
const CURRENT_VERSION = 'v2'; // Version identifier for encrypted data format

/**
 * Derives an encryption key from the master password using PBKDF2
 * @param {string} password - Master password from environment
 * @param {Buffer} salt - Salt for key derivation
 * @param {number} iterations - Number of PBKDF2 iterations
 * @returns {Buffer} Derived encryption key
 */
function deriveKey(password, salt, iterations) {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts a plaintext string using AES-256-GCM
 * @param {string} plaintext - Data to encrypt
 * @returns {string} Base64-encoded encrypted data with format: v2:salt:iv:tag:ciphertext (v2 uses 310k iterations)
 */
function encrypt(plaintext) {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty value');
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable not set');
  }

  if (encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
  }

  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key from password and salt using current iteration count
  const key = deriveKey(encryptionKey, salt, ITERATIONS_CURRENT);

  // Create cipher
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  // Encrypt data
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  // Get authentication tag
  const tag = cipher.getAuthTag();

  // Combine version:salt:iv:tag:ciphertext (v2 format includes version identifier)
  return [
    CURRENT_VERSION,
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext
  ].join(':');
}

/**
 * Decrypts an encrypted string using AES-256-GCM
 * Supports both legacy (100k iterations, 4 parts) and current (310k iterations, 5 parts with version) formats
 * @param {string} encryptedData - Base64-encoded encrypted data
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedData) {
  if (!encryptedData) {
    throw new Error('Cannot decrypt empty value');
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable not set');
  }

  try {
    // Split into components
    const parts = encryptedData.split(':');
    
    let saltB64, ivB64, tagB64, ciphertext, iterations;
    
    // Detect format: v2 (5 parts) or legacy (4 parts)
    if (parts.length === 5 && parts[0] === 'v2') {
      // v2 format: v2:salt:iv:tag:ciphertext (310k iterations)
      [, saltB64, ivB64, tagB64, ciphertext] = parts;
      iterations = ITERATIONS_CURRENT;
    } else if (parts.length === 4) {
      // Legacy format: salt:iv:tag:ciphertext (100k iterations)
      [saltB64, ivB64, tagB64, ciphertext] = parts;
      iterations = ITERATIONS_LEGACY;
    } else {
      throw new Error('Invalid encrypted data format');
    }

    // Convert from base64
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');

    // Derive key from password and salt using appropriate iteration count
    const key = deriveKey(encryptionKey, salt, iterations);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    // Decrypt data
    let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Checks if a value is already encrypted (has the expected format)
 * @param {string} value - Value to check
 * @returns {boolean} True if value appears to be encrypted
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const parts = value.split(':');
  // v2 format (5 parts) or legacy format (4 parts)
  return parts.length === 4 || (parts.length === 5 && parts[0] === 'v2');
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted
};
