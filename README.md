<img width="120" height="120" alt="AppLogo" src="https://github.com/user-attachments/assets/75bee55d-a13c-46ff-85e1-886b18d96951" />

# GitHub Pages Proxy

A GitHub Marketplace app that automatically syncs GitHub Pages custom domains with Cloudflare DNS. When you configure a custom domain for GitHub Pages, this app creates the corresponding CNAME record in Cloudflare—no manual DNS updates required.

## Use Cases

- **Multi-site Management**: Automatically manage DNS for dozens of GitHub Pages sites
- **Team Deployments**: Enable instant custom domain setup for documentation sites
- **CI/CD Integration**: Trigger DNS updates as part of automated deployments

---

## Installation & Setup

You have two options: use the hosted Marketplace app (recommended) or self-host from source.

### Option 1: Use the GitHub Marketplace App (Recommended)

The easiest way to use Pages Proxy is to install it directly from the GitHub Marketplace. The app is hosted and maintained, so you don't need to run any infrastructure.

#### Step 1: Install the App

1. Go to [GitHub Marketplace - Pages Proxy](https://github.com/marketplace/pages-proxy)
2. Click **"Install it for free"**
3. Select the organization or account where you want to use it
4. Grant access to the repositories that use GitHub Pages
5. After installation, GitHub will redirect you to the setup page

#### Step 2: Configure Cloudflare Credentials

You'll be redirected to a secure setup page where you enter your Cloudflare credentials:

1. **Cloudflare Zone ID** - Find this in your Cloudflare dashboard → Select your domain → Overview (right sidebar)
   - [How to find Zone ID](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/)

2. **Cloudflare API Token** - Create a token with **Zone → DNS → Edit** permissions
   - [How to create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
   - **Important**: Use minimum required permissions for security

3. **Cloudflare Email** (Optional) - Only needed for legacy Global API Key authentication (not recommended)

4. Click **"Save Configuration"**

Your credentials are encrypted with AES-256-GCM before storage. You can update them anytime by revisiting the setup page.

> **Security Note**: This service stores your Cloudflare credentials encrypted on our servers. By proceeding, you agree to our [Terms of Service](https://github.com/shakerg/pages-proxy/blob/main/TERMS_OF_SERVICE.md) and [Privacy Policy](https://github.com/shakerg/pages-proxy/blob/main/PRIVACY_POLICY.md). The service is provided AS-IS with no warranty or SLA.

#### Step 3: Use GitHub Pages as Usual

Once configured:

1. Go to your repository → Settings → Pages
2. Set a custom domain (e.g., `docs.example.com`)
3. The app automatically creates/updates the CNAME record in Cloudflare
4. Wait 1-5 minutes for DNS propagation
5. Your Pages site is live at your custom domain!

**To update your Cloudflare credentials later**: Reinstall the app or contact support for the setup URL.

**To remove DNS records**: Simply remove the custom domain in GitHub Pages settings, and the app automatically deletes the Cloudflare record.

---

### Option 2: Self-Host from Source

If you prefer to run your own instance (for example, to customize behavior or run in a private environment), follow these instructions.

#### Prerequisites

- Node.js 20+
- Docker (optional, for containerized deployment)
- Kubernetes/OpenShift cluster (optional, for production deployment)
- GitHub App credentials (App ID, Installation ID, Private Key, Webhook Secret)
- Cloudflare API credentials

#### Quick Start (Local Development)

1. Clone the repository:

```bash
git clone https://github.com/shakerg/pages-proxy.git
cd pages-proxy
```

2. Create `.env` file with your credentials (see [Environment Variables](#environment-variables) below)

3. Install dependencies and start:

```bash
npm install
npm start
```

The server listens on `PORT` (default 3000).

---

## Self-Hosting Configuration

### Environment Variables

If self-hosting, create a `.env` file in the project root:

```ini
PORT=3000
DB_PATH=pages.db

# Encryption key for storing Cloudflare credentials (generate with: openssl rand -base64 48)
ENCRYPTION_KEY=<your_secure_64_character_encryption_key>

# GitHub App (get these from your GitHub App settings)
GITHUB_APP_ID=<your_app_id>
GITHUB_INSTALLATION_ID=<installation_id>
GITHUB_WEBHOOK_SECRET=<webhook_secret>
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"

# Cloudflare (for self-hosted global config, or leave blank if using per-installation setup)
# Recommended: use `CLOUDFLARE_API_TOKEN` with minimal DNS edit permissions
CLOUDFLARE_ZONE_ID=<zone_id>
CLOUDFLARE_API_TOKEN=<api_token_with_dns_edit_permissions>
CLOUDFLARE_EMAIL=<account_email>
```

**Notes**:
- `ENCRYPTION_KEY` is **required** for encrypting stored Cloudflare credentials (min 32 characters)
- For containers/Kubernetes, mount the private key as a file and use `PRIVATE_KEY_PATH` instead of `GITHUB_APP_PRIVATE_KEY`
- The app dynamically generates installation tokens—do not hardcode `GITHUB_APP_TOKEN`
- Keep secrets secure and never commit them to version control
- If using per-installation setup UI (like marketplace), Cloudflare vars can be omitted

### Create Your Own GitHub App

To self-host, you need to create your own GitHub App (not use the Marketplace app):

1. Go to GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
2. Configure:
   - **App name**: `Pages Proxy (Self-Hosted)` or similar
   - **Homepage URL**: Your deployment URL (e.g., `https://pages-proxy.yourdomain.com`)
   - **Setup URL**: `https://your-host.com/setup?installation_id={installation_id}` (for per-user configuration)
   - **Webhook URL**: `https://your-host.com/webhook` (must be HTTPS and publicly accessible)
   - **Webhook Secret**: Generate with `openssl rand -base64 32`
3. Set **Permissions**:
   - Pages: **Read & Write**
   - Contents: **Read**
   - Metadata: **Read**
4. Subscribe to **Events**:
   - Repository
   - Page build
   - Pages
5. Create the app, then:
   - Download the **Private Key** (PEM file)
   - Note the **App ID**
   - Install the app to your org/account and note the **Installation ID** from the URL

### Deployment Options

### Deployment Options

#### Docker

Build and run with Docker:

```bash
# Build for linux/amd64 (recommended for most cloud platforms)
docker build --platform=linux/amd64 -t pages-proxy:latest .

# Run with environment variables
docker run --rm -p 3000:3000 \
  -e GITHUB_APP_ID="$GITHUB_APP_ID" \
  -e GITHUB_INSTALLATION_ID="$GITHUB_INSTALLATION_ID" \
  -e GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
  -e GITHUB_APP_PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY" \
  -e CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
  -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  pages-proxy:latest
```

**Mounting private key as file** (recommended for production):

```bash
docker run --rm -p 3000:3000 \
  -v /path/to/private-key.pem:/app/private-key.pem:ro \
  -e PRIVATE_KEY_PATH="/app/private-key.pem" \
  -e GITHUB_APP_ID="$GITHUB_APP_ID" \
  -e GITHUB_INSTALLATION_ID="$GITHUB_INSTALLATION_ID" \
  -e GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
  -e CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
  -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  pages-proxy:latest
```

#### Kubernetes / OpenShift

Example manifests are in `manifests/`:

1. **Create secrets** with your credentials:

```bash
kubectl create secret generic pages-proxy-secrets \
  --from-literal=GITHUB_APP_ID="<app-id>" \
  --from-literal=GITHUB_INSTALLATION_ID="<installation-id>" \
  --from-literal=GITHUB_WEBHOOK_SECRET="<webhook-secret>" \
  --from-literal=ENCRYPTION_KEY="<64-char-encryption-key>" \
  --from-file=GITHUB_APP_PRIVATE_KEY=./private-key.pem \
  --from-literal=CLOUDFLARE_ZONE_ID="<zone-id>" \
  --from-literal=CLOUDFLARE_API_TOKEN="<api-token>"
```

2. **Deploy**:

```bash
kubectl apply -f manifests/pages-deployment.yml
```

3. **Expose with Ingress/Route** to make the webhook endpoint publicly accessible at `https://your-domain.com/webhook`

4. **Update GitHub App webhook URL** to point to your public endpoint

---

## Testing & Verification

### Test Webhook Locally

Generate a valid webhook signature and test:

```bash
PAYLOAD='{"zen":"testing","hook_id":123}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print "sha256="$2}')

curl -X POST https://your-domain.com/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -d "$PAYLOAD" -i
```

Expected responses:
- **200 OK**: Signature valid, webhook processed
- **401 Unauthorized**: Invalid signature (anti-spoofing working correctly)

### Test Database Operations

Test endpoints for database operations without Cloudflare API calls:

```bash
# Store a custom domain
curl -X POST http://localhost:3000/test-store \
  -H 'Content-Type: application/json' \
  -d '{"repoName":"org/repo","pagesUrl":"https://org.github.io/repo","customDomain":"example.com"}'

# Remove a custom domain
curl -X POST http://localhost:3000/test-remove \
  -H 'Content-Type: application/json' \
  -d '{"repoName":"org/repo"}'
```

---

## API Endpoints

### Webhook Handler
- **POST** `/webhook` - Receives GitHub webhook events (requires valid signature)

### Test Endpoints (DB-only, no Cloudflare calls)
- **POST** `/test-store` - Store Pages URL and custom domain in database
- **POST** `/test-remove` - Remove Pages URL from database

### Manual Operations
- **POST** `/update-cname` - Manually create/update Cloudflare CNAME record
- **POST** `/refresh-token` - Manually refresh GitHub App installation token

---

## Architecture & Security

### Components
- **Webhook Handler**: Express server with signature verification (anti-spoofing)
- **GitHub App Auth**: JWT-based authentication with automatic token refresh
- **Cloudflare Integration**: REST API calls for DNS record management
- **SQLite Database**: Persistent storage for Pages URLs and custom domains
- **Token Manager**: Caches installation tokens and refreshes before expiry

### Security Features
- **Webhook signature verification** (HMAC-SHA256) prevents spoofed requests
- **Automatic token rotation** (installation tokens refreshed every 50 minutes)
- **Private key isolation** (mounted as file, never logged)
- **HTTPS required** for webhook endpoint
- **Minimal permissions** (Pages: Write, Contents: Read, Metadata: Read)

---

## 🐛 Troubleshooting

## 🐛 Troubleshooting

### Common Issues

#### "secretOrPrivateKey must have a value"
- **Cause**: GitHub App private key not loaded correctly
- **Fix**: 
  - Verify `GITHUB_APP_PRIVATE_KEY` contains the full PEM (including BEGIN/END lines)
  - Or mount the PEM file and set `PRIVATE_KEY_PATH`
  - Check for extra quotes or escaped newlines (`\n` should be actual newlines)

#### Cloudflare API Failures
- **Cause**: Invalid API token or zone ID
- **Fix**:
  - Verify `CLOUDFLARE_API_TOKEN` has **DNS Edit** permissions
  - Confirm `CLOUDFLARE_ZONE_ID` matches your domain's zone in Cloudflare dashboard
  - Check token hasn't expired or been revoked

#### Webhook Signature Verification Failures (401)
- **Cause**: Signature mismatch between GitHub and your app
- **Fix**:
  - Ensure `GITHUB_WEBHOOK_SECRET` in app settings matches your environment variable
  - Check reverse proxy/load balancer isn't modifying request body
  - Verify webhook is configured to send `application/json` (not `application/x-www-form-urlencoded`)

#### "A JSON web token could not be decoded" (GitHub API)
- **Cause**: Wrong App ID or private key mismatch
- **Fix**:
  - Verify `GITHUB_APP_ID` matches the app ID in GitHub App settings
  - Ensure private key corresponds to the app (regenerate if needed)
  - Check JWT expiry (app generates 10-minute JWTs)

#### Installation Token Errors
- **Cause**: Installation not found or app not installed
- **Fix**:
  - Confirm app is installed on the org/account
  - Verify `GITHUB_INSTALLATION_ID` from the installation URL (e.g., `https://github.com/settings/installations/12345678`)
  - Reinstall the app if necessary

#### Webhook Not Receiving Events
- **Cause**: Webhook URL unreachable or incorrectly configured
- **Fix**:
  - Ensure webhook URL is **publicly accessible via HTTPS**
  - Check GitHub App settings → Recent Deliveries for error messages
  - Test endpoint with `curl` to verify it responds
  - Verify firewall/network allows inbound traffic

### Debug Mode

Enable verbose logging by checking pod/container logs:

```bash
# Kubernetes/OpenShift
kubectl logs -l app=pages-proxy -c app --tail=100

# Docker
docker logs <container-id>
```

Look for:
- Token generation messages
- Webhook signature verification logs
- Cloudflare API responses
- Database operations

---

## Database Schema

The app uses SQLite with the following tables:

### `pages_urls`
- `repo_name` (TEXT, PRIMARY KEY) - Full repository name (org/repo)
- `pages_url` (TEXT) - GitHub Pages URL
- `custom_domain` (TEXT, nullable) - Custom domain configured

### `cloudflare_records`
- `domain` (TEXT, PRIMARY KEY) - Custom domain
- `record_id` (TEXT) - Cloudflare DNS record ID
- `repo_name` (TEXT) - Associated repository

### `tokens`
- `id` (INTEGER, PRIMARY KEY) - Row ID
- `token` (TEXT) - GitHub App installation token
- `expires_at` (TEXT) - ISO timestamp when token expires

### `installations`
- `installation_id` (INTEGER, PRIMARY KEY) - GitHub App installation ID
- `cloudflare_zone_id` (TEXT) - Per-installation Cloudflare zone ID
- `cloudflare_api_token` (TEXT) - Encrypted API token (AES-256-GCM)
- `cloudflare_email` (TEXT, nullable) - Cloudflare email for legacy auth
- `created_at` (TEXT) - ISO timestamp of creation
- `updated_at` (TEXT) - ISO timestamp of last update

---

## Contributing

Contributions are welcome! To contribute:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes and test locally
4. Commit with clear messages (`git commit -m 'Add amazing feature'`)
5. Push to your fork (`git push origin feature/amazing-feature`)
6. Open a Pull Request

### Development Setup

```bash
git clone https://github.com/shakerg/pages-proxy.git
cd pages-proxy
npm install
# Create .env with your test credentials
npm start
```

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Links

- [GitHub Marketplace](https://github.com/marketplace/pages-proxy)
- [Source Repository](https://github.com/shakerg/pages-proxy)
- [Report Issues](https://github.com/shakerg/pages-proxy/issues)
- [Privacy Policy](PRIVACY_POLICY.md)
- [Terms of Service](TERMS_OF_SERVICE.md)
- [Support](SUPPORT.md)
