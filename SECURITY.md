# Security Policy

## Supported Versions

The latest `main` branch is supported.

## Reporting a Vulnerability

Please do **not** open a public issue for security vulnerabilities.

Report privately by contacting the maintainer through GitHub security advisories or direct email, and include:

1. A clear description of the issue.
2. Steps to reproduce.
3. Potential impact.
4. Suggested remediation (if available).

You can expect an initial response within 5 business days.

## Sensitive Data Guidance

This project handles email metadata/content locally. Never commit:

- Proton Bridge credentials (`IMAP_USER`, `IMAP_PASS`)
- `.env` files
- MCP server config files containing secrets

Rotate credentials immediately if exposure is suspected.
