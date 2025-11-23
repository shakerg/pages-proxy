# Privacy Policy for GitHub Pages Proxy

**Effective Date:** August 22, 2025

## Introduction

GitHub Pages Proxy ("we," "our," or "us") is a GitHub App that connects GitHub Pages with Cloudflare DNS to enable custom domains for GitHub Pages sites. This Privacy Policy explains how we collect, use, and protect information when you use our service.

## Information We Collect

### Cloudflare API Credentials
- **Cloudflare Zone ID** - Required to identify the DNS zone for record management
- **Cloudflare API Token** - Stored encrypted using AES-256-GCM encryption with a master encryption key
- **Cloudflare Email** (optional) - Only used if legacy Global API Key authentication is required

### GitHub Repository Data
- Repository names and metadata
- GitHub Pages configuration and custom domain settings
- Webhook events related to repository changes and page builds
- Installation and authentication tokens for GitHub App functionality

### DNS and Domain Information
- Custom domain names configured for GitHub Pages
- DNS record information managed through Cloudflare integration
- GitHub Pages URLs and their associated custom domains

### Technical Data
- Server logs for debugging and monitoring purposes
- Database records linking repositories to their custom domains
- API interaction logs with GitHub and Cloudflare services

## How We Use Your Information

We use the collected information to:

- Automatically create, update, and remove CNAME records in Cloudflare DNS
- Maintain synchronization between GitHub Pages custom domains and DNS records
- Provide webhook handling for repository and page build events
- Store mapping between GitHub Pages URLs and custom domains in our local database
- Authenticate with GitHub and Cloudflare APIs to perform DNS management

## Data Storage and Security

- **Cloudflare API Tokens** are encrypted using AES-256-GCM encryption before storage in the database
- Repository and domain mapping data is stored in a local SQLite database (`pages.db`)
- Per-installation Cloudflare credentials are stored separately for each GitHub App installation
- All API communications with GitHub and Cloudflare use secure HTTPS connections
- Authentication tokens and private keys are handled securely and not logged
- We implement industry-standard security practices to protect your data

**Security Disclaimer**: While we use industry-standard encryption and security practices, no method of electronic storage is 100% secure. You use the Service at your own risk and should use API tokens with minimum required permissions (DNS Edit only).

## Data Sharing and Third Parties

We interact with the following third-party services:

- **GitHub**: To receive webhook events and access repository metadata
- **Cloudflare**: To manage DNS records for your custom domains

We do not sell, trade, or otherwise transfer your information to third parties except as necessary to provide our service functionality.

## Data Retention

- Repository and domain mapping data is retained as long as the GitHub App is installed
- Cloudflare API credentials are stored per-installation and deleted when the app is uninstalled
- When the app is uninstalled or a repository is disconnected, associated DNS records are removed
- Log data is retained for operational purposes and may be periodically purged
- You can update or remove your Cloudflare credentials at any time by visiting the setup page again

## Your Rights and Choices

You can:

- Uninstall the GitHub App at any time through your GitHub settings
- Remove custom domains from your GitHub Pages, which will automatically remove associated DNS records
- Contact us regarding any questions about your data

## GitHub Marketplace Requirements

This application complies with GitHub Marketplace requirements including:

- Transparent data collection and usage practices
- Secure handling of user data and authentication
- Proper webhook signature verification
- Limited data collection to what is necessary for functionality

## Changes to This Privacy Policy

We may update this Privacy Policy from time to time. We will notify users of any material changes by updating the effective date and, where appropriate, providing notice through the GitHub App.

## Contact Information

If you have any questions about this Privacy Policy, please contact us by creating an issue in our repository at: https://github.com/shakerg/pages-proxy

## Compliance

This service operates as a GitHub App and complies with:
- GitHub's Terms of Service and Privacy Policy
- Cloudflare's Terms of Service and Privacy Policy
- Applicable data protection regulations

---

*This privacy policy is specifically designed for the GitHub Pages Proxy application and covers the data processing activities described in the application's functionality.*
