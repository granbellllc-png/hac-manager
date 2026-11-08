# Security policy

HAC Manager has root-equivalent SSH and API access to managed hosts. It is under development; there are no production-supported releases yet. Security fixes will target the latest maintained release once releases exist.

## Reporting a vulnerability

Do not disclose credentials or exploitable details in a public issue. Use GitHub's private vulnerability reporting at [Report a vulnerability](https://github.com/alexandre-leites/hac-manager/security/advisories/new) when enabled. If unavailable, contact the repository owner privately through their GitHub profile to arrange a confidential report. Include affected versions, a minimal fake-data reproduction and impact; never include real keys, tokens or host addresses.

## Deployment requirements

Keep the service behind a trusted network or authenticated reverse proxy with HTTPS. Protect the data and state directories, backups and external secret CLI credentials. Use a single backend instance. Review pinned SSH host keys and API trust; never disable TLS verification globally. Do not expose the service publicly during development.

Local auth, permissions, redaction, command allowlists, plan/apply and destructive confirmations must be implemented before management endpoints are deployed. The app must not manage the guest hosting itself. Bind mounts require protection separate from `vzdump` backups.

## Contributor requirements

Read the [safety invariants](docs/FEATURES.md#5-safety-invariants-must-always-hold). New output paths need secret leak tests. Use argv without a shell, bounded execution, admin-only execution surfaces and confined includes. Tests use fake hosts and transports exclusively unless a human explicitly authorizes real-host testing.
