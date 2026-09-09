#!/usr/bin/env node

/**
 * GitHub App Installation Administrator Script
 * 
 * Manages GitHub App installations using the App's credentials.
 * 
 * Usage:
 *   node admin-installations.js list                    # List all installations
 *   node admin-installations.js get <installation_id>   # Get specific installation details
 *   node admin-installations.js delete <installation_id> # Delete an installation
 *   node admin-installations.js status <installation_id> # Get installation status and config
 * 
 * Requires .env file with GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and optionally DB_PATH
 */

require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const jwt = require('jsonwebtoken');
const database = require('./database');

const command = process.argv[2];
const installationId = process.argv[3];

/**
 * Generate a GitHub App JWT for app-level operations (like listing installations)
 * This is different from installation tokens - it authenticates as the app itself
 */
function generateAppJWT() {
  const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
  const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
  
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued 60 seconds ago (account for clock skew)
    exp: now + (10 * 60), // Expiration time (10 minutes)
    iss: GITHUB_APP_ID, // GitHub App ID (as string)
  };
  
  const token = jwt.sign(payload, GITHUB_APP_PRIVATE_KEY, { algorithm: 'RS256' });
  return token;
}

async function getAppOctokit() {
  const appJWT = generateAppJWT();
  return new Octokit({
    auth: appJWT,
    userAgent: 'Pages-Proxy-Admin/1.0.0'
  });
}

async function getDatabaseState(installationId) {
  const record = await database.getInstallationRecord(installationId);
  const config = await database.getInstallationConfig(installationId);
  return { record, config };
}

function printDatabaseState(record, config) {
  if (!record) {
    console.log('DB Record: not tracked locally');
    console.log('⚠️  No configuration found in database');
    return;
  }

  console.log(`DB Record: tracked (${record.lifecycle_status || 'active'})`);
  console.log(`DB Config Status: ${record.config_status || 'pending'}`);

  if (record.last_setup_viewed_at) {
    console.log(`Last Setup View: ${new Date(record.last_setup_viewed_at).toLocaleString()}`);
  }

  if (record.last_webhook_at) {
    console.log(`Last Webhook Seen: ${new Date(record.last_webhook_at).toLocaleString()}`);
  }

  if (config) {
    console.log(`✅ Config stored: Zone ${config.cloudflare_zone_id}, Email: ${config.cloudflare_email || 'N/A'}`);
  } else {
    console.log('⚠️  No usable configuration found in database');
  }
}

async function listInstallations() {
  try {
    const octokit = await getAppOctokit();
    console.log('\n📋 Fetching all installations...\n');
    
    const { data: installations } = await octokit.rest.apps.listInstallations();
    
    if (installations.length === 0) {
      console.log('No installations found.');
      return;
    }
    
    console.log(`Found ${installations.length} installation(s):\n`);
    
    for (const install of installations) {
      const { record, config } = await getDatabaseState(install.id);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Installation ID: ${install.id}`);
      console.log(`Account: ${install.account.login} (${install.account.type})`);
      console.log(`Target Type: ${install.target_type}`);
      console.log(`Created: ${new Date(install.created_at).toLocaleString()}`);
      console.log(`Updated: ${new Date(install.updated_at).toLocaleString()}`);
      console.log(`Repository Selection: ${install.repository_selection}`);
      console.log(`Suspended: ${install.suspended_at ? 'Yes (' + new Date(install.suspended_at).toLocaleString() + ')' : 'No'}`);
      console.log(`Permissions: ${JSON.stringify(install.permissions, null, 2)}`);

      printDatabaseState(record, config);
    }
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
  } catch (error) {
    console.error('❌ Error listing installations:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

async function getInstallation(id) {
  try {
    const octokit = await getAppOctokit();
    console.log(`\n🔍 Fetching installation ${id}...\n`);
    
    const { data: install } = await octokit.rest.apps.getInstallation({
      installation_id: parseInt(id)
    });
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Installation ID: ${install.id}`);
    console.log(`Account: ${install.account.login} (${install.account.type})`);
    console.log(`Account URL: ${install.account.html_url}`);
    console.log(`Target Type: ${install.target_type}`);
    console.log(`App ID: ${install.app_id}`);
    console.log(`App Slug: ${install.app_slug}`);
    console.log(`Created: ${new Date(install.created_at).toLocaleString()}`);
    console.log(`Updated: ${new Date(install.updated_at).toLocaleString()}`);
    console.log(`Repository Selection: ${install.repository_selection}`);
    console.log(`Suspended: ${install.suspended_at ? 'Yes (' + new Date(install.suspended_at).toLocaleString() + ')' : 'No'}`);
    console.log(`Has Single File Name: ${install.has_multiple_single_files ? 'Yes' : 'No'}`);
    console.log(`\nPermissions:`);
    console.log(JSON.stringify(install.permissions, null, 2));
    console.log(`\nEvents:`);
    console.log(install.events.join(', '));
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    // Check database configuration
    try {
      const { record, config } = await getDatabaseState(parseInt(id, 10));
      if (record) {
        console.log(`DB Lifecycle Status: ${record.lifecycle_status}`);
        console.log(`DB Config Status: ${record.config_status}`);
        if (record.last_setup_viewed_at) {
          console.log(`DB Last Setup View: ${new Date(record.last_setup_viewed_at).toLocaleString()}`);
        }
        if (record.last_webhook_at) {
          console.log(`DB Last Webhook Seen: ${new Date(record.last_webhook_at).toLocaleString()}`);
        }
      }
      if (config) {
        console.log(`✅ Configuration found in database:`);
        console.log(`   Zone ID: ${config.cloudflare_zone_id}`);
        console.log(`   Email: ${config.cloudflare_email || 'N/A'}`);
        console.log(`   Created: ${new Date(config.created_at).toLocaleString()}`);
        console.log(`   Updated: ${new Date(config.updated_at).toLocaleString()}`);
      } else {
        console.log(`⚠️  No usable configuration found in database for this installation`);
        console.log(`   User needs to visit /setup?installation_id=${id} to configure credentials`);
      }
    } catch (err) {
      console.error(`❌ Error checking database config: ${err.message}`);
    }
    
    // List repositories (if repository_selection is 'selected')
    if (install.repository_selection === 'selected') {
      try {
        const { data: repos } = await octokit.rest.apps.listInstallationReposForAuthenticatedApp({
          installation_id: parseInt(id)
        });
        console.log(`\n📚 Selected Repositories (${repos.total_count}):`);
        repos.repositories.forEach(repo => {
          console.log(`   - ${repo.full_name}`);
        });
      } catch (err) {
        console.error(`⚠️  Could not fetch repositories: ${err.message}`);
      }
    }
    
    console.log('');
    
  } catch (error) {
    console.error(`❌ Error fetching installation ${id}:`, error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

async function deleteInstallation(id) {
  try {
    const octokit = await getAppOctokit();
    
    // First get installation details
    const { data: install } = await octokit.rest.apps.getInstallation({
      installation_id: parseInt(id)
    });
    
    console.log(`\n⚠️  About to delete installation:`);
    console.log(`   ID: ${install.id}`);
    console.log(`   Account: ${install.account.login} (${install.account.type})`);
    console.log(`   Created: ${new Date(install.created_at).toLocaleString()}\n`);
    
    // Confirm deletion (require explicit confirmation via environment or direct call)
    const confirmEnv = process.env.CONFIRM_DELETE;
    if (confirmEnv !== 'yes' && process.argv[4] !== '--confirm') {
      console.log(`❌ Deletion cancelled. To proceed, run with --confirm flag:`);
      console.log(`   node admin-installations.js delete ${id} --confirm`);
      console.log(`   OR set environment variable: CONFIRM_DELETE=yes\n`);
      process.exit(1);
    }
    
    console.log(`🗑️  Deleting installation ${id}...`);
    
    await octokit.rest.apps.deleteInstallation({
      installation_id: parseInt(id)
    });
    
    console.log(`✅ Installation ${id} deleted successfully from GitHub\n`);

    const result = await database.deleteInstallationRecord(parseInt(id, 10));
    console.log(`🗄️  Removed ${result.changes} local installation record(s).\n`);

  } catch (error) {
    console.error(`❌ Error deleting installation ${id}:`, error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

async function getInstallationStatus(id) {
  try {
    console.log(`\n📊 Installation Status Report for ID: ${id}\n`);
    
    // GitHub API check
    const octokit = await getAppOctokit();
    let githubInstall;
    try {
      const { data } = await octokit.rest.apps.getInstallation({
        installation_id: parseInt(id)
      });
      githubInstall = data;
      console.log(`✅ GitHub Installation: ACTIVE`);
      console.log(`   Account: ${githubInstall.account.login} (${githubInstall.account.type})`);
      console.log(`   Suspended: ${githubInstall.suspended_at ? 'YES' : 'NO'}`);
    } catch (err) {
      if (err.status === 404) {
        console.log(`❌ GitHub Installation: NOT FOUND (deleted or never existed)`);
      } else {
        console.log(`❌ GitHub Installation: ERROR - ${err.message}`);
      }
    }
    
    // Database config check
    let record = null;
    try {
      record = await database.getInstallationRecord(parseInt(id, 10));
      const config = await database.getInstallationConfig(parseInt(id, 10));
      if (record) {
        console.log(`ℹ️  Database Tracking: PRESENT`);
        console.log(`   Lifecycle Status: ${record.lifecycle_status}`);
        console.log(`   Config Status: ${record.config_status}`);
        if (record.last_setup_viewed_at) {
          console.log(`   Last Setup View: ${new Date(record.last_setup_viewed_at).toLocaleString()}`);
        }
        if (record.last_webhook_at) {
          console.log(`   Last Webhook Seen: ${new Date(record.last_webhook_at).toLocaleString()}`);
        }
      } else {
        console.log(`ℹ️  Database Tracking: ABSENT`);
      }
      if (config) {
        console.log(`✅ Database Configuration: PRESENT`);
        console.log(`   Zone ID: ${config.cloudflare_zone_id}`);
        console.log(`   Email: ${config.cloudflare_email || 'N/A'}`);
        console.log(`   Last Updated: ${new Date(config.updated_at).toLocaleString()}`);
      } else {
        console.log(`❌ Database Configuration: MISSING`);
        console.log(`   Action needed: User must visit /setup?installation_id=${id}`);
      }
    } catch (err) {
      console.log(`❌ Database Configuration: ERROR - ${err.message}`);
    }
    
    // Overall status
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    if (githubInstall && !githubInstall.suspended_at) {
      const config = await database.getInstallationConfig(parseInt(id, 10));
      if (config) {
        console.log(`Status: ✅ FULLY CONFIGURED AND ACTIVE`);
      } else if (record) {
        console.log(`Status: ⚠️  TRACKED BUT SETUP INCOMPLETE`);
        console.log(`Action: Direct user to setup URL to complete configuration`);
      } else {
        console.log(`Status: ⚠️  INSTALLED BUT NOT CONFIGURED`);
        console.log(`Action: Direct user to setup URL to complete configuration`);
      }
    } else {
      console.log(`Status: ❌ INSTALLATION ISSUE (suspended or deleted)`);
    }
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
  } catch (error) {
    console.error(`❌ Error getting status for installation ${id}:`, error.message);
    process.exit(1);
  }
}

async function syncInstallations() {
  try {
    const octokit = await getAppOctokit();
    console.log('\n🔄 Syncing GitHub installations into local tracking database...\n');

    const { data: installations } = await octokit.rest.apps.listInstallations();

    for (const install of installations) {
      await database.upsertInstallationRecord({
        installation_id: install.id,
        account_login: install.account.login,
        account_type: install.account.type,
        target_type: install.target_type,
        repository_selection: install.repository_selection,
        github_created_at: install.created_at,
        github_updated_at: install.updated_at,
        suspended_at: install.suspended_at,
        deleted_at: null,
        last_webhook_at: new Date().toISOString()
      });
    }

    console.log(`✅ Synced ${installations.length} installation(s) into the local database.\n`);
  } catch (error) {
    console.error('❌ Error syncing installations:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

async function main() {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
    console.error('❌ Missing required environment variables: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY');
    console.error('   Ensure .env file is configured correctly.');
    process.exit(1);
  }
  
  switch (command) {
    case 'list':
      await listInstallations();
      break;
      
    case 'get':
      if (!installationId) {
        console.error('❌ Usage: node admin-installations.js get <installation_id>');
        process.exit(1);
      }
      await getInstallation(installationId);
      break;
      
    case 'delete':
      if (!installationId) {
        console.error('❌ Usage: node admin-installations.js delete <installation_id> [--confirm]');
        process.exit(1);
      }
      await deleteInstallation(installationId);
      break;
      
    case 'status':
      if (!installationId) {
        console.error('❌ Usage: node admin-installations.js status <installation_id>');
        process.exit(1);
      }
      await getInstallationStatus(installationId);
      break;

    case 'sync':
      await syncInstallations();
      break;
      
    default:
      console.log(`
GitHub App Installation Administrator

Usage:
  node admin-installations.js list                      List all installations
  node admin-installations.js sync                      Sync GitHub installations into local DB
  node admin-installations.js get <installation_id>     Get installation details
  node admin-installations.js status <installation_id>  Check installation status
  node admin-installations.js delete <installation_id>  Delete installation (requires --confirm)

Examples:
  node admin-installations.js list
  node admin-installations.js sync
  node admin-installations.js get 82122594
  node admin-installations.js status 82122594
  node admin-installations.js delete 82122594 --confirm

Environment Variables (from .env):
  GITHUB_APP_ID          - GitHub App ID
  GITHUB_APP_PRIVATE_KEY - RSA private key (inline)
  DB_PATH                - SQLite database path (optional)
  CONFIRM_DELETE         - Set to 'yes' to skip confirmation prompt
      `);
      process.exit(command ? 1 : 0);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
