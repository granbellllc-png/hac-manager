---
status: accepted
date: 2026-11-08
---

# 0008. Enforce the root-equivalent trust model on the server

## Context and problem statement

SSH, host filesystem access and Proxmox API credentials give the service root-equivalent power. A hidden UI button is not a security boundary. FEATURES.md D-13, D-15, D-24 and D-64 through D-67 define the trust model.

## Considered options

- Trust local-network access and enforce permissions only in the UI.
- Server-side local auth, host grants and command-surface restrictions.

## Decision outcome

Use local authentication, argon2id passwords, secure cookie sessions, CSRF protection, rate limiting/lockout and security headers. Roles are admin, operator and viewer with per-host grants. Only admins can edit tasks, !cmd, !include, installation URLs, allowlists or users. Operators run authorized jobs; viewers only read.

Pin SSH host fingerprints with explicit trust/re-trust. Use pinned API trust or custom CAs without globally disabling TLS. Secret values use a redacting wrapper, in-memory TTL caching and hash comparisons. Command providers use an admin allowlist, argv without a shell by default, timeouts and output limits. The guest hosting the app is protected from its own management jobs.

## Consequences

Every server entry point requires authorization and output redaction. Vault service accounts suit unattended servers; desktop-integrated CLIs do not. Authentication, secrets and connection trust need deliberate recovery procedures.

## Validation

Exercise permission matrices against API endpoints, CSRF and session behavior, host-key changes, command rejection and leak paths. No fixture contains a real credential or host identity.
