/**
 * Utility for implementing exponential backoff retry logic
 */

/**
 * Sleeps for a given number of milliseconds
 * @param {number} ms - The number of milliseconds to sleep
 * @returns {Promise<void>} A promise that resolves after the specified time
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry a function with exponential backoff
 * 
 * @param {Function} fn - The function to retry
 * @param {Object} options - Options for the retry behavior
 * @param {number} options.maxRetries - Maximum number of retries before giving up
 * @param {number} options.initialDelay - Initial delay in ms
 * @param {number} options.maxDelay - Maximum delay between retries in ms
 * @param {Function} options.shouldRetry - Function that determines if a retry should occur based on the error
 * @returns {Promise<any>} The result of the function or throws the final error
 */
async function withRetry(fn, {
  maxRetries = 5,
  initialDelay = 300,
  maxDelay = 10000,
  shouldRetry = () => true,
} = {}) {
  let retryCount = 0;
  let delay = initialDelay;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retryCount++;
      
      if (retryCount > maxRetries || !shouldRetry(error)) {
        throw error;
      }
      
      delay = Math.min(delay * 2 * (1 + Math.random() * 0.2), maxDelay);
      
      console.log(`Retry attempt ${retryCount} after ${Math.floor(delay)}ms for:`, error.message);
      
      await sleep(delay);
    }
  }
}

module.exports = {
  sleep,
  withRetry
};