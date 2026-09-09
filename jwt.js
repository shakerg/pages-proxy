const fs = require('fs');
const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

require('dotenv').config();

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

console.log('App ID:', GITHUB_APP_ID);
console.log('Installation ID:', GITHUB_INSTALLATION_ID);

/**
 * Generates a GitHub App Installation Access Token
 * 
 * The token will have the following permissions based on the GitHub App:
 * - Contents: Read (to access repository content including CNAME files)
 * - Pages: Write (to read and manage GitHub Pages settings)
 * - Metadata: Read (for basic repository information)
 * 
 * @returns {Promise<string>} The installation access token
 */
async function getInstallationAccessToken() {
  try {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    const payload = {
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (10 * 60),
      iss: GITHUB_APP_ID,
    };
    
    const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
    console.log('JWT generated successfully');
    
    const response = await fetch(`https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch installation access token: ${response.statusText}, Details: ${errorText}`);
    }
    
    const data = await response.json();
    console.log('Installation Access Token generated successfully');
        console.log(`Token expires: ${data.expires_at}`);
    
    return data.token;
  } catch (error) {
    console.error('Error in getInstallationAccessToken:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('Generating GitHub App installation token...');
    const accessToken = await getInstallationAccessToken();
    // Never print or persist the short-lived access token.
    console.log('GitHub App installation token generated successfully and kept in memory only.');
    console.log(`Token length: ${accessToken.length}`);
  } catch (error) {
    console.error('Failed to generate token:', error.message);
  }
}

main();