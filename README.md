# GitHub Pages Proxy

A service that connects GitHub Pages with Cloudflare DNS to enable custom domains for GitHub Pages sites.

## Overview

This application acts as middleware between GitHub Pages and Cloudflare DNS, automatically creating, updating, and removing CNAME records in Cloudflare when repositories change GitHub Pages custom domains.

## Features

- Listens for GitHub repository, `pages` and `page_build` webhooks to detect custom domain changes
- Automatically creates and updates CNAME records in Cloudflare DNS
- Removes CNAME records when custom domains are removed from GitHub Pages
- Maintains a local SQLite database of GitHub Pages URLs and their custom domains
- Provides test endpoints that exercise database logic without calling Cloudflare

## Architecture

- Webhook handler (Express)
- Cloudflare integration layer (REST calls)
- SQLite persistence (`pages.db`)
- GitHub App authentication (JWT -> installation token)

---

## Quick start

1. Copy `.env.example` (or create `.env`) and set required variables (see Environment Variables)
2. Install dependencies:

```bash
npm install
```

3. Start locally:

```bash
npm start
```

The server listens on `PORT` (default 3000).

---

## Environment Variables

Create a `.env` file in the project root and set the following (sensitive values must not be committed):

```ini
PORT=3000
DB_PATH=pages.db

# GitHub App
GITHUB_APP_ID=<your_app_id>
GITHUB_INSTALLATION_ID=<installation_id>
GITHUB_WEBHOOK_SECRET=<webhook_secret>
# Either set the PEM text here (multiline) or mount the PEM file and let jwt.js read it
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Cloudflare
CLOUDFLARE_ZONE_ID=<zone_id>
CLOUDFLARE_API_TOKEN=<api_token_with_dns_permissions>
CLOUDFLARE_EMAIL=<account_email>
CLOUDFLARE_GLOBAL_API_KEY=<global_api_key>
```

Notes:
- The app supports providing the private key as either an environment variable (`GITHUB_APP_PRIVATE_KEY`) or by placing the PEM on disk and updating `jwt.js` to read it from a path. For containers and Kubernetes, prefer Secrets.
- Keep webhook secret and API tokens private.

---

## Build, configure and deploy

Below are step-by-step instructions to create the GitHub App, configure the environment, and deploy the `pages-proxy` service locally, with Docker, or to Kubernetes.

### 1) Create and configure the GitHub App

1. In GitHub, go to Settings → Developer settings → GitHub Apps → New GitHub App.
2. Configure app details:
   - App name: e.g. `Pages Proxy`
   - Homepage URL: `https://pages-proxy.example.com` (or your host)
   - Webhook URL: `https://<HOST>/webhook`
   - Webhook secret: generate a strong secret and save it
3. Set permissions (minimum required):
   - Pages: Read & Write
   - Contents: Read
   - Metadata: Read
4. Subscribe to events: Repository and Page build (page_build) events.
5. Create the app, then generate and download the private key (PEM). Note the App ID and Installation ID after installing the app to an org or repo.

### 2) Local development

1. Create `.env` with values from Environment Variables.
2. Install and start:

```bash
npm install
npm start
```

3. Use the test endpoints to verify DB behavior without Cloudflare:

```bash
curl -X POST http://localhost:3000/test-store -H 'Content-Type: application/json' -d '{"repoName":"org/repo","pagesUrl":"https://org.github.io/repo","customDomain":"example.com"}'

curl -X POST http://localhost:3000/test-remove -H 'Content-Type: application/json' -d '{"repoName":"org/repo"}'
```

### 3) Docker

Build and run the included Docker image:

```bash
docker build -t pages-proxy:local .

docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e GITHUB_APP_ID="$GITHUB_APP_ID" \
  -e GITHUB_INSTALLATION_ID="$GITHUB_INSTALLATION_ID" \
  -e GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
  -e GITHUB_APP_PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY" \
  -e CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
  -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  -e CLOUDFLARE_EMAIL="$CLOUDFLARE_EMAIL" \
  -e CLOUDFLARE_GLOBAL_API_KEY="$CLOUDFLARE_GLOBAL_API_KEY" \
  pages-proxy:local
```

For multiline PEMs prefer mounting the key file:

```bash
docker run --rm -p 3000:3000 \
  -v /local/path/private-key.pem:/app/private-key.pem:ro \
  -e GITHUB_APP_ID="$GITHUB_APP_ID" \
  -e GITHUB_INSTALLATION_ID="$GITHUB_INSTALLATION_ID" \
  -e GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
  -e PRIVATE_KEY_PATH="/app/private-key.pem" \
  pages-proxy:local
```

Modify `jwt.js` to read `PRIVATE_KEY_PATH` if you use this mounting approach.

### 4) Kubernetes

An example manifest `manifests/pages-deployment.yml` is included. Steps:

1. Create a Kubernetes Secret with the sensitive values (example):

```bash
kubectl create secret generic pages-proxy-secrets \
  --from-literal=GITHUB_APP_ID="<app-id>" \
  --from-literal=GITHUB_INSTALLATION_ID="<installation-id>" \
  --from-literal=GITHUB_WEBHOOK_SECRET="<webhook-secret>" \
  --from-file=GITHUB_APP_PRIVATE_KEY=./private-key.pem \
  --from-literal=CLOUDFLARE_ZONE_ID="<zone-id>" \
  --from-literal=CLOUDFLARE_API_TOKEN="<api-token>" \
  --from-literal=CLOUDFLARE_EMAIL="<email>" \
  --from-literal=CLOUDFLARE_GLOBAL_API_KEY="<global-api-key>"
```

2. Update `manifests/pages-deployment.yml` to mount the secret values as env vars or a file (for the private key).
3. Deploy:

```bash
kubectl apply -f manifests/pages-deployment.yml
```

Ensure your service is reachable from GitHub (Ingress/LoadBalancer) and that the webhook URL is set to the public endpoint.

### 5) CI/CD and container registry

Build and push in CI to a registry (example GitHub Container Registry):

```bash
docker build -t ghcr.io/<org>/pages-proxy:<tag> .
docker push ghcr.io/<org>/pages-proxy:<tag>
```

Update your Kubernetes manifests to reference the pushed image.

---

## Webhook configuration on GitHub

1. In the GitHub App settings, ensure the Webhook URL points to `https://<HOST>/webhook` and the secret matches `GITHUB_WEBHOOK_SECRET`.
2. Verify delivery in the GitHub UI (Recent Deliveries).

---

## Troubleshooting

- `secretOrPrivateKey must have a value` — the PEM was not provided or is malformed. Ensure `GITHUB_APP_PRIVATE_KEY` contains the PEM with correct newlines or mount the PEM file and update `jwt.js` to use it.
- Cloudflare API failures — verify `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` and that the token has DNS edit permissions.
- Webhook signature verification failures — ensure `GITHUB_WEBHOOK_SECRET` matches and that any reverse proxy preserves the request body.

---

## API Endpoints

### Webhook

POST /webhook

### Test endpoints (DB-only)

POST /test-store
POST /test-remove

### Manual CNAME

POST /update-cname

---

## Database schema

Tables: `pages_urls`, `cloudflare_records`, `tokens` (see original README for fields).

---

## License

MIT — see the `LICENSE` file for details.