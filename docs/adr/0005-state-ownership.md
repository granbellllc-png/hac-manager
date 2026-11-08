---
status: accepted
date: 2026-11-08
---

# 0005. Files own declarative state; the database owns operations

## Context and problem statement

Recovery must preserve infrastructure intent even if SQLite is lost. FEATURES.md D-20 and D-62 settle where configuration belongs.

## Considered options

- Persist both configuration and history in SQLite.
- Use files for everything.
- Declarative files plus an operational database.

## Decision outcome

Host and guest definitions, mappings, tasks and orphan ignore lists are declarative YAML in the data dir. In particular, ignored guests live in host.yaml with fingerprints beyond their VMID so reuse is detectable. SQLite stores users, sessions, jobs, line logs, prompts, audit, application settings and rebuildable host/drift caches.

Cache rows must never become the sole source of a configuration field. A read index can be rebuilt from files. Operational settings must not smuggle declarative host/guest definitions into the database.

## Consequences

Configuration remains inspectable and versionable. Losing the DB loses history and credentials/sessions, but not infrastructure intent. The backend must reconcile cached state with files and distinguish user configuration from derived observations.

## Validation

Test rebuilding discovery and host caches with a fresh DB while preserving definitions and ignored guests. Reviews check new tables for accidental declarative state ownership.
