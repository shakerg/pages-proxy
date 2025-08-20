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

app.use(bodyParser.json());

app.post('/webhook', webhooks.handleWebhook);

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
  const { domain, target } = req.body;
  try {
    await cloudflare.updateOrCreateCNAMERecord(domain, target);
    res.status(200).send('CNAME record updated successfully');
  } catch (error) {
    console.error('Error updating CNAME record:', error);
    res.status(500).send('Failed to update CNAME record');
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