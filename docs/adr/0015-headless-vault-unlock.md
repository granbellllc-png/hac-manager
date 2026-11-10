---
status: accepted
date: 2026-11-10
---

# 0015. Unlock headless vault providers with memory-only tokens

## Context and problem statement

External secret CLIs can become locked while durable jobs are running on a
headless server. Persisting a master password or session token in a prompt,
job payload or database would violate the secret-redaction and operational
state boundaries in FEATURES.md D-15 and D-17.

## Considered options

- Persist unlock credentials with the durable prompt.
- Depend on desktop-integrated CLI unlock flows.
- Pause the durable job, submit a token through a separate endpoint, and keep
  the validated token in process memory only.

## Decision outcome

Secret CLI integrations implement a provider interface with metadata,
`status`, `unlock`, `clear` and ephemeral environment methods. Before a job
handler starts, the queue checks the providers required by the host connection.
A locked provider creates the normal durable confirmation prompt and pauses the
job. The prompt contains provider metadata only.

An administrator submits a session or service-account token to a dedicated
endpoint. The provider validates it with the installed CLI, registers it with
the redactor and exposes it only through the child process environment. The UI
then resolves the non-secret confirmation prompt so the job can resume. Tokens
are lost on restart. Operators can observe the waiting job, but only admins may
unlock or resolve a vault prompt.

Built-in adapters cover `op` through `OP_SERVICE_ACCOUNT_TOKEN`, `bw` through
`BW_SESSION`, and `vault` through `VAULT_TOKEN`. Additional providers implement
the same interface. Desktop-app unlock is not supported on servers.

## Consequences

- No unlock credential is written to SQLite, job logs, prompts, SSE or audit.
- Jobs do not begin mutation before required connection providers are unlocked.
- A restart deliberately discards interactive sessions and may prompt again.
- Long-lived service-account tokens still need least-privilege configuration.

## Validation

Tests verify pause/unlock/resume, admin-only APIs, unavailable-provider failure,
redaction registration, and absence of submitted tokens from persisted rows and
responses.

## Links

- GitHub issue #71
- FEATURES.md D-15 and D-17
- ADR 0008
- ADR 0009
