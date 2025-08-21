# GitHub Pages Proxy

GitHub Pages Proxy is a Node.js Express application that acts as middleware between GitHub Pages and Cloudflare DNS, automatically creating, updating, and removing CNAME records when repositories change GitHub Pages custom domains.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

### Bootstrap, build, and run the repository:

- Install Node.js 20+ (confirmed working with v20.19.4)
- `npm install` -- takes 4-14 seconds to complete. NEVER CANCEL. Set timeout to 60+ seconds.
- Create `.env` file with required environment variables (see Environment Variables section)
- `node index.js` -- starts the server on PORT (default 3000). Requires valid GitHub App credentials to start fully.

### Code Quality:

- `npx prettier --write .` -- auto-formats all code in 2 seconds. NEVER CANCEL. Set timeout to 30+ seconds.
- `npx eslint@8 . --fix` -- lints and auto-fixes code style issues in 2 seconds. NEVER CANCEL. Set timeout to 30+ seconds.
- `npx eslint@8 .` -- checks for remaining linting issues. May show warnings but should not have blocking errors.

### Testing and Validation:

- ALWAYS test database operations using the test endpoints when making changes to database logic.
- Run the endpoint validation script to ensure database functionality works without external APIs.
- Test endpoints: `/test-store`, `/test-remove`, `/health` (see Validation section for examples).

## Environment Variables

Create a `.env` file in the project root with the following variables:

```ini
PORT=3000
DB_PATH=pages.db

# GitHub App (required for full operation)
GITHUB_APP_ID=<your_app_id>
GITHUB_INSTALLATION_ID=<installation_id>
GITHUB_WEBHOOK_SECRET=<webhook_secret>
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Cloudflare (required for DNS operations)
CLOUDFLARE_ZONE_ID=<zone_id>
CLOUDFLARE_API_TOKEN=<api_token_with_dns_permissions>
CLOUDFLARE_EMAIL=<account_email>
CLOUDFLARE_GLOBAL_API_KEY=<global_api_key>
```

**CRITICAL**: The application requires valid GitHub App credentials to start fully. Without them, the server will fail during token generation. Use test endpoints for database validation without requiring GitHub authentication.

## Docker

The application includes a Dockerfile for containerization:

- `docker build -t pages-proxy:local .` -- takes 2-5 minutes. NEVER CANCEL. Set timeout to 10+ minutes.
- Docker build may fail in environments with SSL certificate issues. This is a known limitation.
- The build process installs sqlite3, build-essential, and python3 dependencies.

## Validation

### Manual Functional Testing

ALWAYS run through complete end-to-end scenarios after making changes:

#### Database Operations (No External APIs Required):

```bash
# 1. Start a test server that bypasses GitHub authentication
cat > test_server.js << 'EOF'
const express = require('express');
const bodyParser = require('body-parser');
const database = require('./database');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.post('/test-store', async (req, res) => {
  try {
    const { repoName, pagesUrl, customDomain } = req.body;
    await database.testStorePagesUrl(repoName, pagesUrl, customDomain);
    res.status(200).send('Success');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.post('/test-remove', async (req, res) => {
  try {
    const { repoName } = req.body;
    await database.testRemovePagesUrl(repoName);
    res.status(200).send('Success');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(3000, () => console.log('Test server running on port 3000'));
EOF

# 2. Start test server
node test_server.js &
sleep 3

# 3. Test health endpoint
curl -s http://localhost:3000/health

# 4. Test database store operation
curl -X POST http://localhost:3000/test-store \
  -H 'Content-Type: application/json' \
  -d '{"repoName":"test/repo","pagesUrl":"https://test.github.io/repo","customDomain":"example.com"}'

# 5. Test database remove operation
curl -X POST http://localhost:3000/test-remove \
  -H 'Content-Type: application/json' \
  -d '{"repoName":"test/repo"}'

# 6. Clean up
kill %1
rm test_server.js
```

#### Expected Results:

- Health endpoint returns "OK"
- Store operation returns "Success" and logs database insertion
- Remove operation returns "Success" and logs database deletion
- SQLite database file `pages.db` is created with proper schema

## Timing Expectations

**NEVER CANCEL these operations** - always wait for completion:

- **npm install**: 4-14 seconds (clean install). Set timeout to 60+ seconds.
- **ESLint**: 1-3 seconds. Set timeout to 30+ seconds.
- **Prettier**: 1-2 seconds. Set timeout to 30+ seconds.
- **Docker build**: 2-5 minutes (may fail with SSL issues). Set timeout to 10+ minutes.
- **Application startup**: 1-3 seconds to fail without credentials, 5-10 seconds with valid credentials.

## Repository Structure

### Key Files:

- `index.js` - Main Express server with endpoints and startup logic
- `database.js` - SQLite database operations and schema management
- `webhooks.js` - GitHub webhook handlers for repository, pages, and page_build events
- `cloudflare.js` - Cloudflare DNS API integration for CNAME record management
- `utils/tokenManager.js` - GitHub App authentication and token management
- `utils/sanitize.js` - Input validation utilities
- `.eslintrc.js` - ESLint configuration (older format, requires ESLint 8.x)
- `.prettierrc` - Prettier formatting configuration
- `Dockerfile` - Container build configuration

### Database Schema:

- `pages_urls` - Maps repository names to GitHub Pages URLs and custom domains
- `cloudflare_records` - Tracks Cloudflare DNS record IDs for cleanup
- `tokens` - Stores GitHub App installation access tokens with expiration

### Critical Dependencies:

- Node.js 20+ (confirmed with v20.19.4)
- SQLite3 for database operations
- Express for web server
- @octokit/rest for GitHub API integration
- jsonwebtoken for GitHub App authentication
- cloudflare package for DNS management

## Common Tasks

### When modifying webhook handlers (`webhooks.js`):

1. Always test with the test endpoints first
2. Use `npx eslint@8 . --fix` to maintain code style
3. Verify database operations work correctly before testing with actual webhooks

### When updating database schema (`database.js`):

1. Always backup existing database: `cp pages.db pages.db.backup`
2. Test schema changes with fresh database creation
3. Validate with test endpoints before deploying

### When changing authentication logic (`utils/tokenManager.js`):

1. Cannot test without valid GitHub App credentials
2. Use the `/refresh-token` endpoint for manual token testing
3. Check token expiration logic with database queries

### When updating Cloudflare integration (`cloudflare.js`):

1. Test with mock responses first
2. Use the `/update-cname` endpoint for manual testing
3. Cannot fully test without valid Cloudflare API credentials

## Limitations

- **GitHub App credentials required**: Application cannot start fully without valid private key
- **External API dependencies**: Full functionality requires GitHub App and Cloudflare API access
- **Docker SSL issues**: Container builds may fail in environments with certificate chain issues
- **ESLint version sensitivity**: Must use ESLint 8.x due to older configuration format

## Quick Validation Commands

```bash
# Full validation sequence (run after any changes)
npm install                           # Install dependencies
npx prettier --write .               # Format code
npx eslint@8 . --fix                 # Fix linting issues
npx eslint@8 .                       # Check remaining issues
# Run manual endpoint tests (see Validation section)
```

Use these commands to ensure your changes integrate properly with the existing codebase and maintain code quality standards.
