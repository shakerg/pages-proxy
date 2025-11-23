const sqlite3 = require('sqlite3').verbose();
const { sanitizeString, isValidRepoName, isValidUrl, isValidDomain } = require('./utils/sanitize');
const { encrypt, decrypt, isEncrypted } = require('./utils/encryption');
const cloudflare = require('./cloudflare');

const dbPath = process.env.DB_PATH || 'pages.db';
console.log(`Using database path: ${dbPath}`);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to pages.db database');
    
    db.exec('PRAGMA journal_mode = WAL;', (pragmaErr) => {
      if (pragmaErr) console.error('Error setting journal mode:', pragmaErr.message);
    });
    
    db.exec('PRAGMA synchronous = FULL;', (pragmaErr) => {
      if (pragmaErr) console.error('Error setting synchronous mode:', pragmaErr.message);
    });
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pages_urls (
    repo_name TEXT PRIMARY KEY,
    pages_url TEXT,
    custom_domain TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cloudflare_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name TEXT,
    cname_record TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    token TEXT,
    expires_at TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS installations (
    installation_id INTEGER PRIMARY KEY,
    cloudflare_zone_id TEXT,
    cloudflare_api_token TEXT,
    cloudflare_email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  console.log('Database tables initialized');
});

function extractGitHubDomain(pagesUrl) {
  if (!pagesUrl) return 'your.domain.com'; // Default fallback

  try {
    const url = new URL(pagesUrl);
    return url.hostname;
  } catch (e) {
    console.error('Error extracting GitHub domain from URL:', e);
    return 'your.domain.com';
  }
}

function runInTransaction(queries) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (beginErr) => {
        if (beginErr) {
          console.error('Error beginning transaction:', beginErr);
          return reject(beginErr);
        }
        
        try {
          const results = [];
          for (const query of queries) {
            results.push(query());
          }
          
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error('Error committing transaction:', commitErr);
              
              db.run('ROLLBACK', (rollbackErr) => {
                if (rollbackErr) {
                  console.error('Error rolling back transaction:', rollbackErr);
                }
                reject(commitErr);
              });
            } else {
              console.log('Transaction committed successfully');
              resolve(results);
            }
          });
        } catch (err) {
          console.error('Error in transaction:', err);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) {
              console.error('Error rolling back transaction:', rollbackErr);
            }
            reject(err);
          });
        }
      });
    });
  });
}

function storeCloudflareRecordId(repoName, recordId) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  if (!recordId) {
    return Promise.reject(new Error('Record ID is required'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);
  const sanitizedRecordId = sanitizeString(recordId);

  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('Error beginning transaction:', beginErr);
        return reject(beginErr);
      }
      
      const stmt = db.prepare(`INSERT OR REPLACE INTO cloudflare_records (repo_name, cname_record) VALUES (?, ?)`);
      stmt.run(sanitizedRepoName, sanitizedRecordId, function (err) {
        if (err) {
          console.error(`Error storing Cloudflare record for ${sanitizedRepoName}:`, err);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('Error rolling back transaction:', rollbackErr);
            stmt.finalize();
            return reject(err);
          });
        } else {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error('Error committing transaction:', commitErr);
              
              db.run('ROLLBACK', (rollbackErr) => {
                if (rollbackErr) console.error('Error rolling back transaction:', rollbackErr);
                stmt.finalize();
                return reject(commitErr);
              });
            } else {
              console.log(`Stored Cloudflare record ID for ${sanitizedRepoName}: ${sanitizedRecordId}`);
              stmt.finalize();
              resolve();
            }
          });
        }
      });
    });
  });
}

async function storePagesUrl(repoName, pagesUrl, customDomain) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  if (pagesUrl && !isValidUrl(pagesUrl)) {
    return Promise.reject(new Error('Invalid pages URL format'));
  }
  
  if (customDomain && !isValidDomain(customDomain)) {
    return Promise.reject(new Error('Invalid custom domain format'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);
  const sanitizedPagesUrl = pagesUrl ? sanitizeString(pagesUrl) : null;
  const sanitizedCustomDomain = customDomain ? sanitizeString(customDomain) : null;

  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], async (err, row) => {
      if (err) {
        console.error('Database error when querying pages_urls:', err);
        return reject(err);
      }

      try {
        if (row) {
          const stmt = db.prepare(`UPDATE pages_urls SET pages_url = ?, custom_domain = ? WHERE repo_name = ?`);
          stmt.run(sanitizedPagesUrl, sanitizedCustomDomain, sanitizedRepoName, function (updateErr) {
            if (updateErr) {
              console.error('Error updating pages_urls table:', updateErr);
              stmt.finalize();
              return reject(updateErr);
            }
            console.log(`Updated database entry for ${sanitizedRepoName} with custom domain ${sanitizedCustomDomain}`);
            stmt.finalize();
          });
        } else {
          const stmt = db.prepare(`INSERT INTO pages_urls (repo_name, pages_url, custom_domain) VALUES (?, ?, ?)`);
          stmt.run(sanitizedRepoName, sanitizedPagesUrl, sanitizedCustomDomain, function (insertErr) {
            if (insertErr) {
              console.error('Error inserting into pages_urls table:', insertErr);
              stmt.finalize();
              return reject(insertErr);
            }
            console.log(`Inserted new database entry for ${sanitizedRepoName} with custom domain ${sanitizedCustomDomain}`);
            stmt.finalize();
          });
        }

        try {
          if (sanitizedCustomDomain) {
            const githubDomain = extractGitHubDomain(sanitizedPagesUrl);
            console.log(`Creating/updating CNAME record for ${sanitizedCustomDomain} pointing to ${githubDomain}`);

            if (row && row.custom_domain && row.custom_domain !== sanitizedCustomDomain) {
              const oldRecordId = await getCloudflareRecordId(sanitizedRepoName);
              if (oldRecordId) {
                console.log(`Custom domain changed from ${row.custom_domain} to ${sanitizedCustomDomain}. Deleting old record ${oldRecordId}`);
                try {
                  await cloudflare.deleteARecord(oldRecordId);
                } catch (deleteErr) {
                  console.error('Failed to delete old Cloudflare record, but continuing:', deleteErr);
                }
              }
            
              try {
                const record = await cloudflare.createCNAMERecord(sanitizedCustomDomain, githubDomain);
                await storeCloudflareRecordId(sanitizedRepoName, record.id);
                console.log(`Created new Cloudflare record for ${sanitizedCustomDomain} pointing to ${githubDomain}`);
              } catch (createErr) {
                console.error('Failed to create new Cloudflare record, but database was updated:', createErr);
              }
            } else {
              const existingRecordId = await getCloudflareRecordId(sanitizedRepoName);
              if (existingRecordId) {
                try {
                  await cloudflare.updateCNAMERecord(process.env.CLOUDFLARE_ZONE_ID, existingRecordId, { 
                    name: sanitizedCustomDomain, 
                    content: githubDomain // Use the GitHub domain, not the full pages URL
                  });
                  console.log(`Updated existing Cloudflare record for ${sanitizedCustomDomain} pointing to ${githubDomain}`);
                } catch (updateErr) {
                  console.error('Failed to update Cloudflare record, but database was updated:', updateErr);
                }
              } else {
                try {
                  const record = await cloudflare.createCNAMERecord(sanitizedCustomDomain, githubDomain);
                  await storeCloudflareRecordId(sanitizedRepoName, record.id);
                  console.log(`Created new Cloudflare record for ${sanitizedCustomDomain} pointing to ${githubDomain}`);
                } catch (createErr) {
                  console.error('Failed to create Cloudflare record, but database was updated:', createErr);
                }
              }
            }
          } else if (row && row.custom_domain) {
            const recordId = await getCloudflareRecordId(sanitizedRepoName);
            if (recordId) {
              try {
                await cloudflare.deleteARecord(recordId);
                console.log(`Deleted Cloudflare record for ${row.custom_domain} because custom domain was removed`);
              } catch (deleteErr) {
                console.error('Failed to delete Cloudflare record, but database was updated:', deleteErr);
              }
            }
          }
        } catch (cloudflareErr) {
          console.error('Error with Cloudflare operations, but database was updated successfully:', cloudflareErr);
        }

        resolve();
      } catch (error) {
        console.error('Unexpected error in storePagesUrl:', error);
        reject(error);
      }
    });
  });
}

async function removePagesUrl(repoName) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);

  return new Promise(async (resolve, reject) => {
    const stmt = db.prepare(`DELETE FROM pages_urls WHERE repo_name = ?`);
    stmt.run(sanitizedRepoName, function (err) {
      if (err) {
        console.error(`Error deleting ${sanitizedRepoName} from pages_urls:`, err);
        stmt.finalize();
        return reject(err);
      }
      
      console.log(`Successfully deleted ${sanitizedRepoName} from pages_urls table`);
      stmt.finalize();
      
      getCloudflareRecordId(sanitizedRepoName)
        .then(recordId => {
          if (recordId) {
            console.log(`Found Cloudflare record ${recordId} for ${sanitizedRepoName}, attempting to delete...`);
            
            cloudflare.deleteARecord(recordId)
              .then(() => {
                console.log(`Successfully deleted Cloudflare record ${recordId} for ${sanitizedRepoName}`);
                
                const cfStmt = db.prepare(`DELETE FROM cloudflare_records WHERE repo_name = ?`);
                cfStmt.run(sanitizedRepoName, function(cfErr) {
                  if (cfErr) {
                    console.error(`Error deleting ${sanitizedRepoName} from cloudflare_records:`, cfErr);
                  } else {
                    console.log(`Successfully deleted ${sanitizedRepoName} from cloudflare_records table`);
                  }
                  cfStmt.finalize();
                  resolve();
                });
              })
              .catch(deleteErr => {
                console.error(`Error deleting Cloudflare record, but database entry was removed:`, deleteErr);
                
                const cfStmt = db.prepare(`DELETE FROM cloudflare_records WHERE repo_name = ?`);
                cfStmt.run(sanitizedRepoName, function(cfErr) {
                  if (cfErr) {
                    console.error(`Error deleting ${sanitizedRepoName} from cloudflare_records:`, cfErr);
                  } else {
                    console.log(`Successfully deleted ${sanitizedRepoName} from cloudflare_records table`);
                  }
                  cfStmt.finalize();
                  resolve();
                });
              });
          } else {
            console.log(`No Cloudflare record found for ${sanitizedRepoName}`);
            resolve();
          }
        })
        .catch(lookupErr => {
          console.error(`Error looking up Cloudflare record ID, but database entry was removed:`, lookupErr);
          resolve();
        });
    });
  });
}

function getCloudflareRecordId(repoName) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);

  return new Promise((resolve, reject) => {
    db.get(`SELECT cname_record FROM cloudflare_records WHERE repo_name = ?`, [sanitizedRepoName], (err, row) => {
      if (err) {
        return reject(err);
      }
      console.log(`Retrieved Cloudflare record ID for ${sanitizedRepoName}: ${row ? row.cname_record : 'not found'}`);
      resolve(row ? row.cname_record : null);
    });
  });
}

async function storeToken(tokenData) {
  if (!tokenData || !tokenData.token || !tokenData.expires_at) {
    return Promise.reject(new Error('Token data missing required fields'));
  }
  
  const { token, expires_at } = tokenData;
  const sanitizedToken = sanitizeString(token);
  const sanitizedExpiresAt = sanitizeString(expires_at);
  const now = new Date().toISOString();
  
  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('Error beginning transaction:', beginErr);
        return reject(beginErr);
      }
      
      const stmt = db.prepare(`INSERT OR REPLACE INTO tokens (id, token, expires_at, created_at) VALUES (?, ?, ?, ?)`);
      stmt.run('github_app_token', sanitizedToken, sanitizedExpiresAt, now, function (err) {
        if (err) {
          console.error(`Error storing token:`, err);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('Error rolling back transaction:', rollbackErr);
            stmt.finalize();
            return reject(err);
          });
        } else {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error('Error committing transaction:', commitErr);
              
              db.run('ROLLBACK', (rollbackErr) => {
                if (rollbackErr) console.error('Error rolling back transaction:', rollbackErr);
                stmt.finalize();
                return reject(commitErr);
              });
            } else {
              console.log(`Stored GitHub App token with expiry: ${sanitizedExpiresAt}`);
              stmt.finalize();
              resolve(tokenData);
            }
          });
        }
      });
    });
  });
}

async function getStoredToken() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT token, expires_at FROM tokens WHERE id = ?`, ['github_app_token'], (err, row) => {
      if (err) {
        console.error('Error retrieving token from database:', err);
        return reject(err);
      }
      
      if (row) {
        console.log(`Retrieved token from database with expiry: ${row.expires_at}`);
      } else {
        console.log('No token found in database');
      }
      
      resolve(row);
    });
  });
}

async function isTokenExpired() {
  try {
    const tokenData = await getStoredToken();
    if (!tokenData) return true; // No token stored, so it's expired
    
    const expiryTime = new Date(tokenData.expires_at).getTime();
    const now = new Date().getTime();
    
    // Add a buffer of 5 minutes to ensure we refresh before actual expiration
    const buffer = 5 * 60 * 1000; // 5 minutes in milliseconds
    const isExpired = now + buffer >= expiryTime;
    
    if (isExpired) {
      console.log('Token is expired or will expire soon');
    } else {
      console.log(`Token is still valid until ${tokenData.expires_at}`);
    }
    
    return isExpired;
  } catch (error) {
    console.error('Error checking if token is expired:', error);
    return true;
  }
}

async function testStorePagesUrl(repoName, pagesUrl, customDomain) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  if (pagesUrl && !isValidUrl(pagesUrl)) {
    return Promise.reject(new Error('Invalid pages URL format'));
  }
  
  if (customDomain && !isValidDomain(customDomain)) {
    return Promise.reject(new Error('Invalid custom domain format'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);
  const sanitizedPagesUrl = pagesUrl ? sanitizeString(pagesUrl) : null;
  const sanitizedCustomDomain = customDomain ? sanitizeString(customDomain) : null;

  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('[TEST] Error beginning transaction:', beginErr);
        return reject(beginErr);
      }
      
      db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], (err, row) => {
        if (err) {
          console.error('[TEST] Database error when querying pages_urls:', err);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
            return reject(err);
          });
          return;
        }

        try {
          if (row) {
            const stmt = db.prepare(`UPDATE pages_urls SET pages_url = ?, custom_domain = ? WHERE repo_name = ?`);
            stmt.run(sanitizedPagesUrl, sanitizedCustomDomain, sanitizedRepoName, function (updateErr) {
              if (updateErr) {
                console.error('[TEST] Error updating pages_urls table:', updateErr);
                stmt.finalize();
                
                db.run('ROLLBACK', (rollbackErr) => {
                  if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                  return reject(updateErr);
                });
                return;
              }
              
              console.log(`[TEST] Updated database entry for ${sanitizedRepoName} with custom domain ${sanitizedCustomDomain}`);
              stmt.finalize();
              
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('[TEST] Error committing transaction:', commitErr);
                  
                  db.run('ROLLBACK', (rollbackErr) => {
                    if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                    return reject(commitErr);
                  });
                  return;
                }
                
                db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], (verifyErr, updatedRow) => {
                  if (verifyErr) {
                    console.error('[TEST] Error verifying update:', verifyErr);
                    return reject(verifyErr);
                  }
                  console.log('[TEST] Verified updated record:', updatedRow);
                  resolve(updatedRow);
                });
              });
            });
          } else {
            const stmt = db.prepare(`INSERT INTO pages_urls (repo_name, pages_url, custom_domain) VALUES (?, ?, ?)`);
            stmt.run(sanitizedRepoName, sanitizedPagesUrl, sanitizedCustomDomain, function (insertErr) {
              if (insertErr) {
                console.error('[TEST] Error inserting into pages_urls table:', insertErr);
                stmt.finalize();
                
                db.run('ROLLBACK', (rollbackErr) => {
                  if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                  return reject(insertErr);
                });
                return;
              }
              
              console.log(`[TEST] Inserted new database entry for ${sanitizedRepoName} with custom domain ${sanitizedCustomDomain}`);
              stmt.finalize();
              
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('[TEST] Error committing transaction:', commitErr);
                  
                  db.run('ROLLBACK', (rollbackErr) => {
                    if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                    return reject(commitErr);
                  });
                  return;
                }
                
                db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], (verifyErr, insertedRow) => {
                  if (verifyErr) {
                    console.error('[TEST] Error verifying insert:', verifyErr);
                    return reject(verifyErr);
                  }
                  
                  console.log('[TEST] Verified inserted record:', insertedRow);
                  resolve(insertedRow);
                });
              });
            });
          }
        } catch (error) {
          console.error('[TEST] Unexpected error in testStorePagesUrl:', error);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
            reject(error);
          });
        }
      });
    });
  });
}

async function testRemovePagesUrl(repoName) {
  if (!isValidRepoName(repoName)) {
    return Promise.reject(new Error('Invalid repository name format'));
  }
  
  const sanitizedRepoName = sanitizeString(repoName);
  
  return new Promise((resolve, reject) => {
    console.log(`[TEST] Starting removal of ${sanitizedRepoName} from database`);
    
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('[TEST] Error beginning transaction:', beginErr);
        return reject(beginErr);
      }
      
      db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], (checkErr, row) => {
        if (checkErr) {
          console.error(`[TEST] Error checking if ${sanitizedRepoName} exists:`, checkErr);
          
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
            return reject(checkErr);
          });
          return;
        }
        
        if (!row) {
          console.log(`[TEST] No record found for ${sanitizedRepoName} to delete`);
          
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error('[TEST] Error committing empty transaction:', commitErr);
              return reject(commitErr);
            }
            resolve({ deleted: false, message: 'Record not found' });
          });
          return;
        }
        
        console.log(`[TEST] Found record to delete: ${JSON.stringify(row)}`);
        
        const stmt = db.prepare(`DELETE FROM pages_urls WHERE repo_name = ?`);
        stmt.run(sanitizedRepoName, function (err) {
          if (err) {
            console.error(`[TEST] Error deleting ${sanitizedRepoName} from pages_urls:`, err);
            stmt.finalize();
            
            db.run('ROLLBACK', (rollbackErr) => {
              if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
              return reject(err);
            });
            return;
          }
          
          console.log(`[TEST] Successfully deleted ${sanitizedRepoName} from pages_urls table (${this.changes} row(s) affected)`);
          stmt.finalize();
          
          const cfStmt = db.prepare(`DELETE FROM cloudflare_records WHERE repo_name = ?`);
          cfStmt.run(sanitizedRepoName, function(cfErr) {
            if (cfErr) {
              console.error(`[TEST] Error deleting ${sanitizedRepoName} from cloudflare_records:`, cfErr);
              cfStmt.finalize();
              
              db.run('ROLLBACK', (rollbackErr) => {
                if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                return reject(cfErr);
              });
              return;
            }
            
            console.log(`[TEST] Successfully deleted ${sanitizedRepoName} from cloudflare_records table (${this.changes} row(s) affected)`);
            cfStmt.finalize();
            
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                console.error('[TEST] Error committing transaction:', commitErr);
                
                db.run('ROLLBACK', (rollbackErr) => {
                  if (rollbackErr) console.error('[TEST] Error rolling back transaction:', rollbackErr);
                  return reject(commitErr);
                });
                return;
              }
              
              console.log('[TEST] Transaction committed successfully');
              
              db.get(`SELECT * FROM pages_urls WHERE repo_name = ?`, [sanitizedRepoName], (verifyErr, verifyRow) => {
                if (verifyErr) {
                  console.error(`[TEST] Error verifying deletion:`, verifyErr);
                  return reject(verifyErr);
                }
                
                if (verifyRow) {
                  console.error(`[TEST] Record still exists after deletion: ${JSON.stringify(verifyRow)}`);
                  return reject(new Error('Failed to delete record'));
                }
                
                console.log(`[TEST] Verified deletion - record no longer exists for ${sanitizedRepoName}`);
                resolve({ deleted: true });
              });
            });
          });
        });
      });
    });
  });
}

function storeInstallationConfig(installationId, zoneId, apiToken, email = null) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    
    // Encrypt the API token before storing
    let encryptedToken;
    try {
      encryptedToken = encrypt(apiToken);
    } catch (error) {
      console.error('Error encrypting API token:', error);
      return reject(new Error('Failed to encrypt API token: ' + error.message));
    }
    
    db.run(
      `INSERT OR REPLACE INTO installations (installation_id, cloudflare_zone_id, cloudflare_api_token, cloudflare_email, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [installationId, zoneId, encryptedToken, email, now],
      function(err) {
        if (err) {
          console.error('Error storing installation config:', err);
          return reject(err);
        }
        console.log(`Stored encrypted config for installation ${installationId}`);
        resolve({ installation_id: installationId });
      }
    );
  });
}

function getInstallationConfig(installationId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM installations WHERE installation_id = ?',
      [installationId],
      (err, row) => {
        if (err) {
          console.error('Error fetching installation config:', err);
          return reject(err);
        }
        
        if (!row) {
          return resolve(null);
        }
        
        // Decrypt the API token before returning
        if (row.cloudflare_api_token) {
          try {
            row.cloudflare_api_token = decrypt(row.cloudflare_api_token);
          } catch (error) {
            console.error('Error decrypting API token for installation', installationId, ':', error);
            return reject(new Error('Failed to decrypt stored credentials'));
          }
        }
        
        resolve(row);
      }
    );
  });
}

function updateInstallationConfig(installationId, updates) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];
    
    if (updates.cloudflare_zone_id) {
      fields.push('cloudflare_zone_id = ?');
      values.push(updates.cloudflare_zone_id);
    }
    if (updates.cloudflare_api_token) {
      // Encrypt the API token before updating
      try {
        const encryptedToken = encrypt(updates.cloudflare_api_token);
        fields.push('cloudflare_api_token = ?');
        values.push(encryptedToken);
      } catch (error) {
        console.error('Error encrypting API token:', error);
        return reject(new Error('Failed to encrypt API token: ' + error.message));
      }
    }
    if (updates.cloudflare_email !== undefined) {
      fields.push('cloudflare_email = ?');
      values.push(updates.cloudflare_email);
    }
    
    if (fields.length === 0) {
      return reject(new Error('No fields to update'));
    }
    
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(installationId);
    
    db.run(
      `UPDATE installations SET ${fields.join(', ')} WHERE installation_id = ?`,
      values,
      function(err) {
        if (err) {
          console.error('Error updating installation config:', err);
          return reject(err);
        }
        console.log(`Updated encrypted config for installation ${installationId}`);
        resolve({ installation_id: installationId, changes: this.changes });
      }
    );
  });
}

module.exports = { 
  storePagesUrl, 
  removePagesUrl, 
  getCloudflareRecordId, 
  storeCloudflareRecordId,
  testStorePagesUrl,
  testRemovePagesUrl,
  storeToken,
  getStoredToken,
  isTokenExpired,
  storeInstallationConfig,
  getInstallationConfig,
  updateInstallationConfig
};
