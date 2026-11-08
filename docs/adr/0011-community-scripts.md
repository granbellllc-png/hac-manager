---
status: accepted
date: 2026-11-08
---

# 0011. Pin and supervise community installation scripts

## Context and problem statement

Community scripts are useful onboarding tools but execute privileged remote code and can change upstream or introduce unexpected prompts. FEATURES.md D-41 defines approval and execution constraints.

## Considered options

- Download and execute a moving main URL.
- Reject all community scripts.
- Cache pinned scripts with review and prompt supervision.

## Decision outcome

Pin scripts to a commit SHA and/or content hash and cache verified content. Upstream changes require an admin to review a diff and approve. Reject unpinned URLs unless an admin explicitly opts in. Editing installation.url is admin-only.

Run scripts under a pseudo-terminal with explicit environment and configured prompt-answer matches. Unexpected prompts pause the durable job instead of guessing. After creation, stop the CT, run safe mp0 migration, apply management stamping and identity checks, then start with verification. Never pipe a moving remote URL directly into an uncontrolled shell.

## Consequences

Pinned inputs improve repeatability and reviewability but do not make arbitrary scripts safe. Cache integrity, size limits, cancellation and durable prompt handling are required. Script-based provisioning depends on the journaled runner and storage guard.

## Validation

Test changed hashes, unpinned URLs, approved updates, expected/unexpected prompts, cancellation and post-script adoption using fake transports. Real scripts never execute on a real host in CI.
