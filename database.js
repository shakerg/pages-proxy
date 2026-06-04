const sqlite3 = require('sqlite3').verbose();
const { sanitizeString, isValidRepoName, isValidUrl, isValidDomain } = require('./utils/sanitize');
const { encrypt, decrypt, isEncrypted } = require('./utils/encryption');
const cloudflare = require('./cloudflare');

const dbPath = process.env.DB_PATH || 'pages.db';
console.log(`Using database path: ${dbPath}`);

const INSTALLATION_TRACKING_COLUMNS = [
  ['account_login', 'TEXT'],
  ['account_type', 'TEXT'],
  ['target_type', 'TEXT'],
  ['repository_selection', 'TEXT'],
  ['github_created_at', 'TEXT'],
  ['github_updated_at', 'TEXT'],
  ['suspended_at', 'TEXT'],
  ['config_status', "TEXT DEFAULT 'pending'"],
  ['lifecycle_status', "TEXT DEFAULT 'active'"],
  ['setup_completed_at', 'TEXT'],
  ['last_setup_viewed_at', 'TEXT'],
  ['last_webhook_at', 'TEXT'],
  ['deleted_at', 'TEXT']
];

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to pages.db database');
    
    // Performance and durability settings
    db.exec('PRAGMA journal_mode = WAL;', (pragmaErr) => {
      if (pragmaErr) console.error('Error setting journal mode:', pragmaErr.message);
    });
    
    db.exec('PRAGMA synchronous = FULL;', (pragmaErr) => {
      if (pragmaErr) console.error('Error setting synchronous mode:', pragmaErr.message);
    });
    
    // Security and integrity settings
    db.exec('PRAGMA foreign_keys = ON;', (pragmaErr) => {
      if (pragmaErr) {
        console.error('Error enabling foreign keys:', pragmaErr.message);
      } else {
        console.log('Database foreign key constraints enabled');
      }
    });
    
    // Limit WAL journal size to 64MB to prevent unbounded growth
    db.exec('PRAGMA journal_size_limit = 67108864;', (pragmaErr) => {
      if (pragmaErr) {
        console.error('Error setting journal size limit:', pragmaErr.message);
      } else {
        console.log('Database journal size limit set to 64MB');
      }
    });
    
    // Set busy timeout to 5 seconds (prevents immediate failures under contention)
    db.configure('busyTimeout', 5000);
    console.log('Database busy timeout set to 5 seconds');
  }
});

let installationsSchemaReady = Promise.resolve();

function runStatement(sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

function getSingleRow(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(err);
      }
      resolve(row || null);
    });
  });
}

function getAllRows(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        return reject(err);
      }
      resolve(rows || []);
    });
  });
}

function runWithParams(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        return reject(err);
      }
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    return null;
  }

  return normalized.toISOString();
}

function deriveConfigStatus(row) {
  if (row.cloudflare_zone_id && row.cloudflare_api_token) {
    return 'configured';
  }

  if (row.last_setup_viewed_at) {
    return 'setup_viewed';
  }

  return 'pending';
}

function deriveLifecycleStatus(row) {
  if (row.deleted_at) {
    return 'deleted';
  }

  if (row.suspended_at) {
    return 'suspended';
  }

  return 'active';
}

async function ensureInstallationsSchema() {
  const columns = await getAllRows('PRAGMA table_info(installations)');
  const existingColumns = new Set(columns.map((column) => column.name));

  for (const [columnName, definition] of INSTALLATION_TRACKING_COLUMNS) {
    if (!existingColumns.has(columnName)) {
      await runStatement(`ALTER TABLE installations ADD COLUMN ${columnName} ${definition}`);
    }
  }

  await runStatement(`
    UPDATE installations
    SET config_status = CASE
      WHEN cloudflare_zone_id IS NOT NULL AND cloudflare_api_token IS NOT NULL THEN 'configured'
      WHEN last_setup_viewed_at IS NOT NULL THEN 'setup_viewed'
      ELSE 'pending'
    END
    WHERE config_status IS NULL OR config_status = ''
  `);

  await runStatement(`
    UPDATE installations
    SET lifecycle_status = CASE
      WHEN deleted_at IS NOT NULL THEN 'deleted'
      WHEN suspended_at IS NOT NULL THEN 'suspended'
      ELSE 'active'
    END
    WHERE lifecycle_status IS NULL OR lifecycle_status = ''
  `);
}

async function getInstallationRecordRaw(installationId) {
  await installationsSchemaReady;
  return getSingleRow(
    'SELECT * FROM installations WHERE installation_id = ?',
    [installationId]
  );
}

async function persistInstallationRecord(row) {
  await installationsSchemaReady;
  const values = [
    row.installation_id,
    row.cloudflare_zone_id,
    row.cloudflare_api_token,
    row.cloudflare_email,
    row.created_at,
    row.updated_at,
    row.account_login,
    row.account_type,
    row.target_type,
    row.repository_selection,
    row.github_created_at,
    row.github_updated_at,
    row.suspended_at,
    row.config_status,
    row.lifecycle_status,
    row.setup_completed_at,
    row.last_setup_viewed_at,
    row.last_webhook_at,
    row.deleted_at
  ];

  await runWithParams(
    `INSERT OR REPLACE INTO installations (
      installation_id,
      cloudflare_zone_id,
      cloudflare_api_token,
      cloudflare_email,
      created_at,
      updated_at,
      account_login,
      account_type,
      target_type,
      repository_selection,
      github_created_at,
      github_updated_at,
      suspended_at,
      config_status,
      lifecycle_status,
      setup_completed_at,
      last_setup_viewed_at,
      last_webhook_at,
      deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values
  );
}

async function upsertInstallationRecord(details) {
  await installationsSchemaReady;
  const installationId = parseInt(details.installation_id ?? details.id, 10);
  if (Number.isNaN(installationId)) {
    throw new Error('Invalid installation ID');
  }

  const existing = await getInstallationRecordRaw(installationId);
  const now = new Date().toISOString();

  const nextRow = {
    installation_id: installationId,
    cloudflare_zone_id: details.cloudflare_zone_id !== undefined ? details.cloudflare_zone_id : existing?.cloudflare_zone_id ?? null,
    cloudflare_api_token: details.cloudflare_api_token !== undefined ? details.cloudflare_api_token : existing?.cloudflare_api_token ?? null,
    cloudflare_email: details.cloudflare_email !== undefined ? details.cloudflare_email : existing?.cloudflare_email ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    account_login: details.account_login !== undefined ? details.account_login : details.account?.login ?? existing?.account_login ?? null,
    account_type: details.account_type !== undefined ? details.account_type : details.account?.type ?? existing?.account_type ?? null,
    target_type: details.target_type !== undefined ? details.target_type : existing?.target_type ?? null,
    repository_selection: details.repository_selection !== undefined ? details.repository_selection : existing?.repository_selection ?? null,
    github_created_at: details.github_created_at !== undefined ? normalizeTimestamp(details.github_created_at) : normalizeTimestamp(details.created_at) ?? existing?.github_created_at ?? null,
    github_updated_at: details.github_updated_at !== undefined ? normalizeTimestamp(details.github_updated_at) : normalizeTimestamp(details.updated_at) ?? existing?.github_updated_at ?? null,
    suspended_at: details.suspended_at !== undefined ? normalizeTimestamp(details.suspended_at) : existing?.suspended_at ?? null,
    setup_completed_at: details.setup_completed_at !== undefined ? normalizeTimestamp(details.setup_completed_at) : existing?.setup_completed_at ?? null,
    last_setup_viewed_at: details.last_setup_viewed_at !== undefined ? normalizeTimestamp(details.last_setup_viewed_at) : existing?.last_setup_viewed_at ?? null,
    last_webhook_at: details.last_webhook_at !== undefined ? normalizeTimestamp(details.last_webhook_at) : existing?.last_webhook_at ?? null,
    deleted_at: details.deleted_at !== undefined ? normalizeTimestamp(details.deleted_at) : existing?.deleted_at ?? null,
    config_status: existing?.config_status ?? null,
    lifecycle_status: existing?.lifecycle_status ?? null
  };

  if (details.config_status !== undefined) {
    nextRow.config_status = details.config_status;
  }

  if (details.lifecycle_status !== undefined) {
    nextRow.lifecycle_status = details.lifecycle_status;
  }

  nextRow.config_status = nextRow.config_status || deriveConfigStatus(nextRow);
  nextRow.lifecycle_status = nextRow.lifecycle_status || deriveLifecycleStatus(nextRow);
  nextRow.config_status = deriveConfigStatus(nextRow);
  nextRow.lifecycle_status = deriveLifecycleStatus(nextRow);

  await persistInstallationRecord(nextRow);
  return nextRow;
}

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

  installationsSchemaReady = ensureInstallationsSchema().catch((error) => {
    console.error('Error ensuring installations schema:', error);
  });
  
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

        // Cloudflare DNS updates are now handled by webhook handlers, not database layer
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
  return new Promise(async (resolve, reject) => {
    const now = new Date().toISOString();

    let encryptedToken;
    try {
      encryptedToken = encrypt(apiToken);
    } catch (error) {
      console.error('Error encrypting API token:', error);
      return reject(new Error('Failed to encrypt API token: ' + error.message));
    }

    try {
      await upsertInstallationRecord({
        installation_id: installationId,
        cloudflare_zone_id: zoneId,
        cloudflare_api_token: encryptedToken,
        cloudflare_email: email,
        setup_completed_at: now,
        config_status: 'configured',
        deleted_at: null
      });
      console.log(`Stored encrypted config for installation ${installationId}`);
      resolve({ installation_id: installationId });
    } catch (err) {
      console.error('Error storing installation config:', err);
      reject(err);
    }
  });
}

async function getInstallationRecord(installationId, options = {}) {
  const row = await getInstallationRecordRaw(installationId);
  if (!row) {
    return null;
  }

  const includeSecret = options.includeSecret === true;
  const record = {
    ...row,
    config_status: row.config_status || deriveConfigStatus(row),
    lifecycle_status: row.lifecycle_status || deriveLifecycleStatus(row)
  };

  if (!includeSecret) {
    delete record.cloudflare_api_token;
    return record;
  }

  if (record.cloudflare_api_token) {
    try {
      record.cloudflare_api_token = decrypt(record.cloudflare_api_token);
    } catch (error) {
      console.error('Error decrypting API token for installation', installationId, ':', error);
      throw new Error('Failed to decrypt stored credentials');
    }
  }

  return record;
}

async function getInstallationConfig(installationId) {
  const record = await getInstallationRecord(installationId, { includeSecret: true });
  if (!record) {
    return null;
  }

  if (!record.cloudflare_zone_id || !record.cloudflare_api_token) {
    return null;
  }

  return record;
}

async function listInstallationRecords() {
  await installationsSchemaReady;
  const rows = await getAllRows(`
    SELECT *
    FROM installations
    ORDER BY COALESCE(last_webhook_at, last_setup_viewed_at, setup_completed_at, updated_at, created_at) DESC,
             installation_id DESC
  `);

  return rows.map((row) => {
    const record = {
      ...row,
      config_status: row.config_status || deriveConfigStatus(row),
      lifecycle_status: row.lifecycle_status || deriveLifecycleStatus(row)
    };

    delete record.cloudflare_api_token;
    return record;
  });
}

function updateInstallationConfig(installationId, updates) {
  return new Promise(async (resolve, reject) => {
    await installationsSchemaReady;
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
    
    fields.push('config_status = ?');
    values.push('configured');

    if (!fields.includes('setup_completed_at = ?')) {
      fields.push('setup_completed_at = ?');
      values.push(new Date().toISOString());
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
  upsertInstallationRecord,
  getInstallationRecord,
  listInstallationRecords,
  storeInstallationConfig,
  getInstallationConfig,
  updateInstallationConfig
};
