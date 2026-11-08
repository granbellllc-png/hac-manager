---
status: accepted
date: 2026-11-08
---

# 0009. Review plans before journaled execution

## Context and problem statement

Mutations can stop workloads or affect data, and long operations must survive browser disconnects and backend restarts. FEATURES.md D-27 through D-32 and D-36 through D-39 establish safety requirements.

## Considered options

- Synchronous HTTP mutations.
- Durable jobs without a preflight plan.
- Fingerprinted plans and journaled job execution.

## Decision outcome

Every mutation first produces a viewable, redacted plan with before/after changes, warnings and destructive flags. Fingerprint it against current state and reject stale plans. Dry-run follows the same executor path and cannot mutate. Typed confirmation and protection flags gate destructive changes.

Jobs persist state and steps (check, apply, verify, rollbackHint). Per-guest locks serialize guest mutations; host work has its own lane; host concurrency is bounded and power actions have priority. Running jobs become interrupted on restart. Persist prompts and line logs so work can resume deliberately.

## Consequences

Extra preflight and state checks are required, but changes are inspectable and recovery is explicit. A plan is not blanket authority to ignore identity checks or data-safety invariants at execution time. Rollback hints document safe recovery; they do not promise arbitrary rollback.

## Validation

Test stale plans, dry-run call assertions, destructive confirmation, same-guest concurrency, priority, cancellation, interruption and step replay. Fail identity checks before update, sync or backup.
