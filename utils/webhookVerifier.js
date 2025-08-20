/**
 * Webhook signature verification utility
 */
const crypto = require('crypto');
const logger = require('./logger');

/**
 * Verify the signature of a GitHub webhook request
 * 
 * @param {object} req - Express request object
 * @param {string} secret - The webhook secret
 * @returns {boolean} Whether the signature is valid
 */
function verifyWebhookSignature(req, secret) {
  try {
    if (!secret) {
      logger.warn('No webhook secret provided for verification');
      return process.env.NODE_ENV !== 'production'; // Only allow in non-production
    }

    const signature = req.headers['x-hub-signature-256'];
    
    if (!signature) {
      logger.warn('No signature found in webhook request');
      return false;
    }

    const sigHashAlg = 'sha256';
    const sigPrefix = `${sigHashAlg}=`;

    if (!signature.startsWith(sigPrefix)) {
      logger.warn(`Invalid signature prefix: ${signature}`);
      return false;
    }

    const providedSignature = signature.slice(sigPrefix.length);
    const payload = JSON.stringify(req.body);
    const hmac = crypto.createHmac(sigHashAlg, secret);
    const digest = hmac.update(payload).digest('hex');

    const valid = crypto.timingSafeEqual(
      Buffer.from(providedSignature, 'hex'),
      Buffer.from(digest, 'hex')
    );

    if (!valid) {
      logger.warn('Webhook signature verification failed');
    } else {
      logger.debug('Webhook signature verified successfully');
    }

    return valid;
  } catch (error) {
    logger.error('Error verifying webhook signature:', error);
    return false;
  }
}

module.exports = {
  verifyWebhookSignature
};