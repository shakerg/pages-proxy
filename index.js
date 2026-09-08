const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const validator = require('validator');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const webhooks = require('./webhooks');
const cloudflare = require('./cloudflare');
const database = require('./database');
require('dotenv').config();

// Rate limiter for /webhook endpoint: Allow max 60 requests per minute per IP
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  standardHeaders: true, // Return rate limit info in the RateLimit-* headers
  legacyHeaders: false, // Disable the X-RateLimit-* headers
});

const { generateToken } = require('./utils/tokenManager');
const app = express();

// Trust forwarded client details only when the immediate proxy is explicitly
// allowlisted by the operator. Proxy trust remains disabled by default.
const trustedProxies = (process.env.TRUSTED_PROXIES || '')
  .split(',')
  .map((proxy) => proxy.trim())
  .filter(Boolean);
app.set('trust proxy', trustedProxies.length > 0 ? trustedProxies : false);

const port = process.env.PORT || 3000;

function getAdminApiKey() {
  return process.env.ADMIN_API_KEY || '';
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch (error) {
    return false;
  }
}

function requireAdminAccess(req, res, next) {
  const configuredAdminKey = getAdminApiKey();
  if (!configuredAdminKey) {
    return res.status(404).send('Not found');
  }

  const queryKey = typeof req.query.key === 'string' ? req.query.key : '';
  const providedKey = req.get('x-admin-api-key') || queryKey || '';
  if (!safeEqual(providedKey, configuredAdminKey)) {
    return res.status(401).send('Unauthorized');
  }

  next();
}

async function buildAdminInstallationsResponse() {
  const installations = await database.listInstallationRecords();
  const summary = installations.reduce((accumulator, installation) => {
    accumulator.total += 1;
    accumulator.by_config_status[installation.config_status] = (accumulator.by_config_status[installation.config_status] || 0) + 1;
    accumulator.by_lifecycle_status[installation.lifecycle_status] = (accumulator.by_lifecycle_status[installation.lifecycle_status] || 0) + 1;

    if (installation.config_status !== 'configured' && installation.lifecycle_status === 'active') {
      accumulator.pending_setup += 1;
    }

    return accumulator;
  }, {
    total: 0,
    pending_setup: 0,
    by_config_status: {},
    by_lifecycle_status: {}
  });

  return {
    generated_at: new Date().toISOString(),
    summary,
    installations: installations.map((installation) => ({
      ...installation,
      has_configuration: installation.config_status === 'configured',
      setup_url: `/setup?installation_id=${installation.installation_id}`
    }))
  };
}

function formatTimestamp(value) {
  if (!value) {
    return '&mdash;';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return validator.escape(String(value));
  }

  return validator.escape(date.toLocaleString());
}

function renderSummaryCards(summary) {
  const cards = [
    ['Tracked installations', String(summary.total)],
    ['Pending setup', String(summary.pending_setup)],
    ['Configured', String(summary.by_config_status.configured || 0)],
    ['Setup viewed', String(summary.by_config_status.setup_viewed || 0)],
    ['Pending', String(summary.by_config_status.pending || 0)],
    ['Active', String(summary.by_lifecycle_status.active || 0)],
    ['Suspended', String(summary.by_lifecycle_status.suspended || 0)],
    ['Deleted', String(summary.by_lifecycle_status.deleted || 0)]
  ];

  return cards.map(([label, value]) => `
    <article class="summary-card">
      <span class="summary-label">${validator.escape(label)}</span>
      <strong class="summary-value">${validator.escape(value)}</strong>
    </article>
  `).join('');
}

function renderInstallationRows(installations) {
  if (installations.length === 0) {
    return '<tr><td colspan="10">No installation records tracked yet.</td></tr>';
  }

  return installations.map((installation) => {
    const account = installation.account_login ? validator.escape(installation.account_login) : '&mdash;';
    const accountType = installation.account_type ? validator.escape(installation.account_type) : '&mdash;';
    const lifecycleStatus = validator.escape(installation.lifecycle_status || 'unknown');
    const configStatus = validator.escape(installation.config_status || 'unknown');
    const repositorySelection = installation.repository_selection ? validator.escape(installation.repository_selection) : '&mdash;';
    const setupLink = `<a href="${validator.escape(installation.setup_url)}">setup</a>`;

    return `
      <tr>
        <td>${validator.escape(String(installation.installation_id))}</td>
        <td>${account}</td>
        <td>${accountType}</td>
        <td>${lifecycleStatus}</td>
        <td>${configStatus}</td>
        <td>${repositorySelection}</td>
        <td>${formatTimestamp(installation.setup_completed_at)}</td>
        <td>${formatTimestamp(installation.last_setup_viewed_at)}</td>
        <td>${formatTimestamp(installation.last_webhook_at)}</td>
        <td>${setupLink}</td>
      </tr>
    `;
  }).join('');
}

if (!fs.existsSync(path.join(__dirname, 'utils'))) {
  fs.mkdirSync(path.join(__dirname, 'utils'));
}

if (!fs.existsSync(path.join(__dirname, 'views'))) {
  fs.mkdirSync(path.join(__dirname, 'views'));
}

// Use raw body parser for webhook signature verification
app.use('/webhook', bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rate limiting for setup endpoints to prevent brute-force attacks
const setupPageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per window (page loads)
  message: 'Too many setup page requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const setupTestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 credential test attempts per window
  message: 'Too many credential test attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const setupCompleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 configuration saves per window
  message: 'Too many configuration save attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

function getInstallationId(query) {
  const installationId = query.installation_id;
  return typeof installationId === 'string' && /^\d+$/.test(installationId)
    ? installationId
    : null;
}

function redirectInstallationToSetup(req, res, next) {
  const installationId = getInstallationId(req.query);
  if (!installationId) {
    return next();
  }

  const setupParams = new URLSearchParams({ installation_id: installationId });
  if (typeof req.query.setup_action === 'string') {
    setupParams.set('setup_action', req.query.setup_action);
  }

  return res.redirect(302, `/setup?${setupParams.toString()}`);
}

// GitHub appends installation_id and setup_action to the configured Setup URL.
app.get(['/install', '/'], redirectInstallationToSetup);

// Setup UI endpoints
app.get('/setup', setupPageLimiter, async (req, res) => {
  try {
    const installationId = getInstallationId(req.query);
    
    // XSS protection: validate installation_id is numeric before using in HTML
    if (!installationId) {
      return res.status(400).send('Invalid or missing installation_id parameter. Must be a numeric GitHub App installation ID.');
    }
    
    const htmlPath = path.join(__dirname, 'views', 'setup.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    try {
      await database.upsertInstallationRecord({
        installation_id: parseInt(installationId, 10),
        last_setup_viewed_at: new Date().toISOString()
      });
    } catch (trackingError) {
      console.error('Error tracking setup page view:', trackingError);
    }
    
    // Replace template variables (safe: validated as numeric above)
    html = html.replace(/{{INSTALLATION_ID}}/g, installationId);
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error serving setup page:', error);
    res.status(500).send('Failed to load setup page');
  }
});

app.post('/setup/test', setupTestLimiter, async (req, res) => {
  try {
    const { zone_id, api_token, email } = req.body;
    
    if (!zone_id || !api_token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: zone_id or api_token' 
      });
    }
    
    // SSRF Protection: Validate zone_id is a valid Cloudflare zone ID format
    // Cloudflare zone IDs are 32-character hexadecimal strings (not UUIDs)
    if (!/^[a-f0-9]{32}$/i.test(zone_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid zone_id format: must be a 32-character hexadecimal string'
      });
    }
    
    // Additional SSRF protection: Validate API token format (should be alphanumeric + some special chars)
    if (!/^[A-Za-z0-9_-]{40,}$/.test(api_token)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid api_token format'
      });
    }
    
    console.log(`Testing Cloudflare credentials for zone ${zone_id}...`);
    
    // SSRF Protection: Hardcode Cloudflare API base URL to prevent URL manipulation
    const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
    
    // Test 1: Verify the API token is valid
    const verifyResponse = await fetch(`${CLOUDFLARE_API_BASE}/user/tokens/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${api_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json();
      console.error('Token verification failed:', errorData);
      return res.status(400).json({
        success: false,
        error: 'Invalid API token',
        details: errorData.errors || 'Token verification failed'
      });
    }
    
    const verifyData = await verifyResponse.json();
    console.log('Token verified:', verifyData.result.status);
    
    // Test 2: Verify the zone exists and is accessible
    // SSRF Protection: Use template literal with validated zone_id only
    const zoneResponse = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zone_id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${api_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!zoneResponse.ok) {
      const errorData = await zoneResponse.json();
      console.error('Zone access failed:', errorData);
      return res.status(400).json({
        success: false,
        error: 'Cannot access zone',
        details: errorData.errors || 'Zone not found or insufficient permissions'
      });
    }
    
    const zoneData = await zoneResponse.json();
    const zoneName = zoneData.result.name;
    console.log(`Zone verified: ${zoneName}`);
    
    // Test 3: Verify DNS permissions by listing DNS records (read permission)
    // SSRF Protection: Use base URL constant with validated zone_id
    const dnsResponse = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zone_id}/dns_records?per_page=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${api_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!dnsResponse.ok) {
      const errorData = await dnsResponse.json();
      console.error('DNS read permission check failed:', errorData);
      return res.status(400).json({
        success: false,
        error: 'Insufficient DNS permissions',
        details: 'Token does not have DNS read/write permissions for this zone'
      });
    }
    
    console.log('✅ All credential tests passed');
    
    res.json({
      success: true,
      message: 'Credentials verified successfully',
      zone_name: zoneName,
      token_status: verifyData.result.status
    });
    
  } catch (error) {
    console.error('Error testing credentials:', error);
    res.status(500).json({
      success: false,
      error: 'Test failed',
      details: error.message
    });
  }
});

app.post('/setup/complete', setupCompleteLimiter, async (req, res) => {
  try {
    const { installation_id, zone_id, api_token, email } = req.body;
    
    if (!installation_id || !zone_id || !api_token) {
      return res.status(400).send('Missing required fields: installation_id, zone_id, or api_token');
    }
    
    // Format string protection: validate installation_id is numeric before logging
    const numericInstallationId = parseInt(installation_id);
    if (isNaN(numericInstallationId)) {
      return res.status(400).send('Invalid installation_id: must be a number');
    }
    
    console.log(`Storing configuration for installation ${numericInstallationId}`);
    
    await database.storeInstallationConfig(
      numericInstallationId,
      zone_id,
      api_token,
      email || null
    );
    
    const htmlPath = path.join(__dirname, 'views', 'success.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error saving configuration:', error);
    // Don't expose internal error details to user
    res.status(500).send('Failed to save configuration. Please try again.');
  }
});

app.post('/webhook', webhookLimiter, webhooks.handleWebhook);

const adminDashboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many dashboard requests, please try again later.'
});

app.get('/admin/installations', requireAdminAccess, async (req, res) => {
  try {
    const payload = await buildAdminInstallationsResponse();
    res.json(payload);
  } catch (error) {
    console.error('Error loading admin installations:', error);
    res.status(500).json({ error: 'Failed to load installation state' });
  }
});

app.get('/admin/dashboard', requireAdminAccess, adminDashboardLimiter, async (req, res) => {
  try {
    const payload = await buildAdminInstallationsResponse();
    const htmlPath = path.join(__dirname, 'views', 'admin-installations.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const installations = payload.installations.map((installation) => ({
      ...installation,
      setup_url: `${installation.setup_url}&key=${encodeURIComponent(String(req.query.key || ''))}`
    }));

    html = html.replace('{{GENERATED_AT}}', validator.escape(new Date(payload.generated_at).toLocaleString()));
    html = html.replace('{{SUMMARY_CARDS}}', renderSummaryCards(payload.summary));
    html = html.replace('{{INSTALLATION_ROWS}}', renderInstallationRows(installations));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    res.status(500).send('Failed to load admin dashboard');
  }
});

// Health endpoints for Kubernetes liveness/readiness probes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.head('/health', (req, res) => {
  res.status(200).end();
});

app.post('/test-store', async (req, res) => {
  console.log('Invoking testStorePagesUrl with payload:', req.body);
  try {
    const { repoName, pagesUrl, customDomain } = req.body;
    await database.testStorePagesUrl(repoName, pagesUrl, customDomain);
    res.status(200).send('testStorePagesUrl executed successfully - database only, no Cloudflare operations');
  } catch (error) {
    console.error('Error in test-store:', error);
    // Don't expose internal error details to user
    res.status(500).send('testStorePagesUrl failed. Check server logs for details.');
  }
});

app.post('/test-remove', async (req, res) => {
  console.log('Invoking testRemovePagesUrl with payload:', req.body);
  try {
    const { repoName } = req.body;
    await database.testRemovePagesUrl(repoName);
    res.status(200).send('testRemovePagesUrl executed successfully - database only, no Cloudflare operations');
  } catch (error) {
    console.error('Error in test-remove:', error);
    // Don't expose internal error details to user
    res.status(500).send('testRemovePagesUrl failed. Check server logs for details.');
  }
});

app.post('/update-cname', async (req, res) => {
  const { domain, target, installation_id } = req.body;
  try {
    let config = null;
    
    // If installation_id provided, use per-installation credentials
    if (installation_id) {
      // Format string protection: validate installation_id is numeric
      const numericInstallationId = parseInt(installation_id);
      if (isNaN(numericInstallationId)) {
        return res.status(400).send('Invalid installation_id: must be a number');
      }
      
      config = await database.getInstallationConfig(numericInstallationId);
      if (!config) {
        // Don't echo user input in error message - use validated numeric value
        return res.status(404).send(`No configuration found for installation ${numericInstallationId}`);
      }
      console.log(`Using per-installation config for installation ${numericInstallationId}:`, {
        has_zone_id: !!config.cloudflare_zone_id,
        has_api_token: !!config.cloudflare_api_token,
        has_email: !!config.cloudflare_email,
        zone_id_value: config.cloudflare_zone_id
      });
    }
    
    await cloudflare.updateOrCreateCNAMERecord(domain, target, config);
    res.status(200).send('CNAME record updated successfully');
  } catch (error) {
    console.error('Error updating CNAME record:', error);
    // Don't expose internal error details to user
    res.status(500).send('Failed to update CNAME record. Check server logs for details.');
  }
});

app.post('/refresh-token', async (req, res) => {
  try {
    const token = await generateToken();
    res.status(200).json({ 
      message: 'Token refreshed successfully',
      tokenPreview: token.substring(0, 5) + '...' // Show just a preview for security
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    // Don't expose internal error details to user
    res.status(500).send('Failed to refresh token. Check server logs for details.');
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).send('Something broke!');
});

async function startServer() {
  try {
    console.log('Starting server initialization...');

    // Installation tokens are customer-scoped and generated on demand from
    // the installation ID included in GitHub webhook payloads. A removed or
    // stale test installation must not prevent the shared service from
    // starting for every other customer.
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      console.log('GitHub installation tokens will be generated on demand');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };