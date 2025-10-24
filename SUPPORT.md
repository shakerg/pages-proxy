# Support

Thank you for using GitHub Pages Proxy! If you need help, here are the best ways to get support.

## Getting Help

### 1. Documentation & Troubleshooting
Start with our main documentation:
- **[README.md](README.md)** — Overview, features, and quick start guide
- **[Troubleshooting Section](README.md#troubleshooting)** — Common issues and solutions
- **[Environment Variables](README.md#environment-variables)** — Configuration reference
- **[API Endpoints](README.md#api-endpoints)** — Webhook and test endpoint documentation

### 2. GitHub Discussions
Have a question or want to share feedback? [Open a discussion](../../discussions) in this repository. This is the best place for:
- General questions about setup and configuration
- Feature requests or ideas
- Best practices and tips
- Community support from other users

### 3. GitHub Issues
Found a bug or something isn't working as expected? [Create an issue](../../issues) and include:
- What you were trying to do
- The error message or unexpected behavior
- Your environment (OS, Node.js version, deployment method)
- Relevant configuration (environment variables, without sensitive values)
- Steps to reproduce

## Troubleshooting Tips

### `secretOrPrivateKey must have a value`
- Ensure `GITHUB_APP_PRIVATE_KEY` is set correctly with proper newlines
- Verify the PEM file is valid if mounting from disk
- Check that `jwt.js` is reading the key from the correct location

### Cloudflare API Failures
- Verify `CLOUDFLARE_API_TOKEN` has DNS edit permissions
- Confirm `CLOUDFLARE_ZONE_ID` matches your Cloudflare domain
- Check that your API token hasn't expired

### Webhook Signature Verification Failures
- Ensure `GITHUB_WEBHOOK_SECRET` matches between GitHub and your `.env` file
- If behind a reverse proxy, verify it preserves the request body

### No CNAME Records Being Created
- Check Recent Deliveries in your GitHub App settings
- Verify the webhook is subscribed to `repository` and `page_build` events
- Ensure your installation is on the correct repository or organization
- Review application logs for error messages

## Development & Contributions

If you'd like to contribute:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request with your changes
4. Include a description of what you're fixing or adding

See the [README.md](README.md) for development setup instructions.

## Security Concerns

If you discover a security vulnerability, please **do not** open a public issue. Instead:
- Email security concerns directly to me at shakerg@github.com
- Include details about the vulnerability without publicly disclosing it
- Allow time for a fix before public disclosure

## Additional Resources

- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [Cloudflare DNS Documentation](https://developers.cloudflare.com/dns/)
- [GitHub App Documentation](https://docs.github.com/en/developers/apps)
- [Express.js Documentation](https://expressjs.com/)

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

*Last updated: October 24, 2025*
