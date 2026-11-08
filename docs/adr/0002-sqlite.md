---
status: accepted
date: 2026-11-08
---

# 0002. SQLite-only v1 with one backend instance

## Context and problem statement

A homelab owner needs a service deployable without a separate database. The queue, SSH pool and secret cache are in-process. FEATURES.md D-20 and D-21 supersede the original PostgreSQL proposal.

## Considered options

- Embedded SQLite.
- SQLite and PostgreSQL together.
- A distributed backend with an external queue and database.

## Decision outcome

Use Drizzle and better-sqlite3 in WAL mode, with migrations and a repository layer. v1 supports a single backend instance only. Keep database access behind repositories so a future PostgreSQL dialect remains possible without committing to dual-dialect behavior now. The database belongs in HACM_STATE_DIR, never the data dir or Git.

## Consequences

Deployment, backup and local development stay small. Horizontal replicas are unsupported: two backend instances would violate in-memory coordination and secret-cache assumptions. Database migrations and operational backup procedures remain necessary. Do not assume WAL replaces queue locking or transaction boundaries.

## Validation

Repository integration tests use temporary SQLite databases, verify WAL and migrations, and prove restart behavior. Deployment docs require one backend process and persistent state storage.
