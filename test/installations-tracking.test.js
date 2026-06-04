const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `pages-proxy-installations-${process.pid}-${Date.now()}.db`);

const database = require('../database');

test('tracks installation lifecycle before configuration is saved', async () => {
  const record = await database.upsertInstallationRecord({
    installation_id: 500001,
    account_login: 'example-org',
    account_type: 'Organization',
    target_type: 'Organization',
    repository_selection: 'all',
    last_webhook_at: new Date().toISOString()
  });

  assert.equal(record.installation_id, 500001);
  assert.equal(record.config_status, 'pending');
  assert.equal(record.lifecycle_status, 'active');

  const config = await database.getInstallationConfig(500001);
  assert.equal(config, null);
});

test('marks setup page visits without treating the installation as configured', async () => {
  await database.upsertInstallationRecord({
    installation_id: 500002,
    last_setup_viewed_at: new Date().toISOString()
  });

  const record = await database.getInstallationRecord(500002);
  assert.equal(record.config_status, 'setup_viewed');
  assert.equal(record.lifecycle_status, 'active');
  assert.equal(record.cloudflare_api_token, undefined);
});

test('stores encrypted credentials and exposes them only through getInstallationConfig', async () => {
  await database.storeInstallationConfig(
    500003,
    '4c18a91971a6076b06ffdd7f469d829c',
    'test-token-value-1234567890abcdefghijkl',
    'ops@example.com'
  );

  const record = await database.getInstallationRecord(500003);
  assert.equal(record.config_status, 'configured');
  assert.equal(record.lifecycle_status, 'active');
  assert.equal(record.cloudflare_api_token, undefined);

  const config = await database.getInstallationConfig(500003);
  assert.equal(config.cloudflare_zone_id, '4c18a91971a6076b06ffdd7f469d829c');
  assert.equal(config.cloudflare_api_token, 'test-token-value-1234567890abcdefghijkl');
  assert.equal(config.cloudflare_email, 'ops@example.com');
  assert.ok(config.setup_completed_at);
});

test.after(() => {
  try {
    fs.rmSync(process.env.DB_PATH, { force: true });
  } catch (error) {
    // Ignore temp file cleanup failures.
  }
});