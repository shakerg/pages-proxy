const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `pages-proxy-installations-${process.pid}-${Date.now()}.db`);
process.env.TRUSTED_PROXIES = '192.0.2.10/32,198.51.100.20/32';
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';

const database = require('../database');
const request = require('supertest');
const { app } = require('../index');

test('trusts forwarded client addresses only from configured proxy networks', () => {
  const trustProxy = app.get('trust proxy fn');

  assert.equal(trustProxy('192.0.2.10'), true);
  assert.equal(trustProxy('198.51.100.20'), true);
  assert.equal(trustProxy('192.0.2.11'), false);
  assert.equal(trustProxy('127.0.0.1'), false);
  assert.equal(trustProxy('10.0.0.1'), false);
});

test('redirects GitHub installation callbacks to the setup page', async () => {
  const response = await request(app)
    .get('/install')
    .query({
      installation_id: '500000',
      setup_action: 'install'
    });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    '/setup?installation_id=500000&setup_action=install'
  );
});

test('supports root callback URLs from existing GitHub App configuration', async () => {
  const response = await request(app)
    .get('/')
    .query({ installation_id: '500000' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/setup?installation_id=500000');
});

test('renders setup after following the installation callback redirect', async () => {
  const response = await request(app)
    .get('/setup')
    .query({
      installation_id: '500000',
      setup_action: 'install'
    });

  assert.equal(response.status, 200);
  assert.match(response.text, /name="installation_id" value="500000"/);
});

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

test('removes local installation data when GitHub sends an uninstall webhook', async () => {
  const installationId = 500004;
  await database.storeInstallationConfig(
    installationId,
    '4c18a91971a6076b06ffdd7f469d829c',
    'test-token-value-1234567890abcdefghijkl',
    'privacy@example.com'
  );

  const payload = JSON.stringify({
    action: 'deleted',
    installation: {
      id: installationId,
      account: { login: 'privacy-test', type: 'User' }
    }
  });
  const signature = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  const response = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', 'installation')
    .set('X-Hub-Signature-256', signature)
    .send(payload);

  assert.equal(response.status, 200);
  assert.equal(await database.getInstallationRecord(installationId), null);
  assert.equal(await database.getInstallationConfig(installationId), null);
});

test('removes the legacy plaintext GitHub token table', async () => {
  await database.getInstallationRecord(500000);
  const tokenTable = await new Promise((resolve, reject) => {
    const verificationDb = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
    verificationDb.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tokens'",
      (error, row) => {
        verificationDb.close();
        if (error) return reject(error);
        resolve(row || null);
      }
    );
  });

  assert.equal(tokenTable, null);
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