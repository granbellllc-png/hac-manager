---
status: accepted
date: 2026-11-08
---

# 0004. Keep the data dir separate from the application

## Context and problem statement

The owner's infrastructure files are independently Git-versioned and may be edited in an IDE. Application upgrades must not overwrite them. FEATURES.md D-04, D-05, D-09 and D-11 replace the original embedded data/ layout.

## Considered options

- Data inside the application checkout.
- Database-only configuration.
- A separate user-owned data directory.

## Decision outcome

HACM_DATA_DIR points to a separate infra repo with hosts/<host>/host.yaml, defaults, guest folders, mappings and three-tier tasks. Ship fake examples/data solely for documentation and tests. Runtime state uses HACM_STATE_DIR. Secret files stay untracked. The app does not manage Git.

All config writes go through the YAML CST and a hash-based external-edit guard, using atomic file replacement. Includes remain inside the data dir, rejecting traversal, symlink escapes and cycles. Initialization is idempotent and never overwrites user files.

## Consequences

The owner retains control over Git and external editing. Discovery, watchers, provenance and conflict handling are needed. Path validation must handle both Windows and Linux without weakening confinement. Packaging exposes separate /data and /state mounts.

## Validation

Use temporary directories to test discovery, concurrent edits, safe initialization, atomic writes and include escape attempts. Check that application builds and runtime state never enter the user's configuration history.
