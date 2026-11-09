---
'@hacm/core': patch
'server': patch
---

Add an idempotent journaled step runner with check/apply/verify phases, rollback guidance, dry-run and cancellation support, safe resume behavior, an in-memory journal, and a sanitized SQLite job-step adapter.
