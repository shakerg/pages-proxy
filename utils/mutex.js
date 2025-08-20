/**
 * A simple mutex implementation for avoiding race conditions
 */

class Mutex {
  constructor() {
    this.locking = Promise.resolve();
    this._locked = false;
    this.owner = null;
  }

  /**
   * Check if mutex is currently locked
   * @returns {boolean} True if locked
   */
  get isLocked() {
    return this._locked;
  }

  /**
   * Acquire the mutex lock
   * @returns {Promise<function>} A release function to be called when done
   */
  async acquire() {
    const current = this.locking;
    
    let release;
    
    this.locking = new Promise(resolve => {
      release = () => {
        this._locked = false;
        this.owner = null;
        resolve();
      };
    });

    await current;
    
    const stack = new Error().stack;
    this.owner = stack.split('\n').slice(2).join('\n');
    
    this._locked = true;
    
    return release;
  }

  /**
   * Execute a function with the mutex lock
   * @param {Function} fn - The function to execute with the lock
   * @returns {Promise<any>} The result of the function
   */
  async withLock(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = Mutex;