# Architecture decision records

ADRs record technical choices and their consequences. [FEATURES.md](../FEATURES.md) remains authoritative for product behavior. Use the [MADR template](template.md) for new decisions, number them consecutively, and link superseding records instead of deleting history.

| ADR                                       | Decision                                              |
| ----------------------------------------- | ----------------------------------------------------- |
| [0001](0001-stack.md)                     | Node 22 and the TypeScript workspace stack            |
| [0002](0002-sqlite.md)                    | SQLite-only v1 and one backend instance               |
| [0003](0003-sse.md)                       | SSE for durable event streaming                       |
| [0004](0004-data-directory.md)            | Data dir separate from application checkout           |
| [0005](0005-state-ownership.md)           | Declarative files and operational database state      |
| [0006](0006-terminology.md)               | Host, guest and resource terminology                  |
| [0007](0007-safe-expressions.md)          | Sandboxed expressions instead of executable templates |
| [0008](0008-trust-and-roles.md)           | Root-equivalent trust model and server-enforced roles |
| [0009](0009-plan-apply.md)                | Plans, dry-runs and journaled execution               |
| [0010](0010-mp0-invariants.md)            | Storage-agnostic mount-namespace checks               |
| [0011](0011-community-scripts.md)         | Pinned and supervised community scripts               |
| [0012](0012-exec-channels.md)             | SSH exec channels and scripts on stdin                |
| [0013](0013-inheritance-and-merge.md)     | Inheritance, merge semantics and provenance tracking  |
| [0014](0014-safe-expression-evaluator.md) | Custom AST-based safe expression engine for `!expr`   |
| [0015](0015-headless-vault-unlock.md)     | Headless vault unlock with memory-only tokens         |
| [0016](0016-interactive-console.md)       | Dedicated SSH PTYs and WebSockets for web consoles    |

Git management, cluster support and historical metrics are outside v1. v1 manages standalone hosts; clusters require a later design. These constraints follow FEATURES.md and must not be bypassed in an implementation.
