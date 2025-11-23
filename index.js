const express = require('express');
const bodyParser = require('body-parser');
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

const { generateToken, setupTokenRefresh } = require('./utils/tokenManager');
const app = express();
const port = process.env.PORT || 3000;

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

// Setup UI endpoints
app.get('/setup', setupPageLimiter, async (req, res) => {
  try {
    const installationId = req.query.installation_id;
    
    // XSS protection: validate installation_id is numeric before using in HTML
    if (!installationId || !/^\d+$/.test(installationId)) {
      return res.status(400).send('Invalid or missing installation_id parameter. Must be a numeric GitHub App installation ID.');
    }
    
    const htmlPath = path.join(__dirname, 'views', 'setup.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
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
    console.log('Generating initial GitHub App token...');
    
    await generateToken();
    
    setupTokenRefresh();
    
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      console.log('Token refresh schedule is active');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();