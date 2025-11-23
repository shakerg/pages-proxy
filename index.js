const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const webhooks = require('./webhooks');
const cloudflare = require('./cloudflare');
const database = require('./database');
require('dotenv').config();

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

// Setup UI endpoints
app.get('/setup', async (req, res) => {
  try {
    const installationId = req.query.installation_id;
    
    if (!installationId) {
      return res.status(400).send('Missing installation_id parameter');
    }
    
    const htmlPath = path.join(__dirname, 'views', 'setup.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Replace template variables
    html = html.replace(/{{INSTALLATION_ID}}/g, installationId);
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error serving setup page:', error);
    res.status(500).send('Failed to load setup page');
  }
});

app.post('/setup/complete', async (req, res) => {
  try {
    const { installation_id, zone_id, api_token, email } = req.body;
    
    if (!installation_id || !zone_id || !api_token) {
      return res.status(400).send('Missing required fields: installation_id, zone_id, or api_token');
    }
    
    console.log(`Storing configuration for installation ${installation_id}`);
    
    await database.storeInstallationConfig(
      parseInt(installation_id),
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
    res.status(500).send('Failed to save configuration: ' + error.message);
  }
});

app.post('/webhook', webhooks.handleWebhook);

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
    res.status(500).send('testStorePagesUrl failed: ' + error.message);
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
    res.status(500).send('testRemovePagesUrl failed: ' + error.message);
  }
});

app.post('/update-cname', async (req, res) => {
  const { domain, target, installation_id } = req.body;
  try {
    let config = null;
    
    // If installation_id provided, use per-installation credentials
    if (installation_id) {
      config = await database.getInstallationConfig(parseInt(installation_id));
      if (!config) {
        return res.status(404).send(`No configuration found for installation ${installation_id}`);
      }
      console.log(`Using per-installation config for installation ${installation_id}:`, {
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
    res.status(500).send('Failed to update CNAME record: ' + error.message);
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
    res.status(500).send('Failed to refresh token: ' + error.message);
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