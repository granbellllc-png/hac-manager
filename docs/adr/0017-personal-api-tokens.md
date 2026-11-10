---
status: accepted
date: 2026-11-10
---

# 0017. Store only hashes of scoped personal API tokens

## Context and problem statement

CLI and unattended automation need authentication without a browser cookie.
Persisting reusable plaintext credentials would create another secret store
and make database disclosure immediately compromise every token.

## Considered options

- Reuse username and password on every CLI request.
- Store encrypted bearer tokens so the server can recover them.
- Generate high-entropy bearer tokens, return plaintext once and store only a
  verification hash plus a public lookup identifier.

## Decision outcome

Personal tokens use `hacm_pat_<lookup>_<secret>`. The lookup component selects
one database row; SHA-256 of the complete high-entropy token is compared with a
timing-safe equality check. Plaintext is returned only at creation and is
registered with the global redactor.

Each token has a role scope (`viewer`, `operator`, `admin`) that cannot exceed
the creator's current role. Authentication also caps the scope to the user's
current role and retains the user's host grants. Revoked, expired, malformed
and orphaned tokens fail authentication. Last-use writes are throttled.

Creation requires an authenticated browser session, CSRF validation and the
user's password. Token-authenticated requests are exempt from CSRF because
they do not use ambient cookies, but they cannot manage tokens. Creation and
revocation are audited without token material. The CLI reads the bearer value
from `HACM_API_TOKEN` or another named environment variable.

## Consequences

- Database theft does not reveal usable token plaintext.
- User deletion, role downgrade, host-grant changes, expiry and revocation
  affect subsequent requests immediately.
- Users must securely capture the one-time token response.
- Tokens remain root-equivalent when granted admin scope and need short expiry
  and least privilege.

## Validation

Tests cover hash-only persistence, timing-safe matching, scope capping,
revocation, expiry, CSRF behavior, audit redaction and CLI authentication.

## Links

- GitHub issue #73
- FEATURES.md D-64, D-65, D-67 and D-74
- ADR 0008
