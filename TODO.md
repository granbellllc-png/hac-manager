# HAC Manager — Implementation Status & Roadmap

## Overview

This document tracks progress on the autonomous implementation of HAC Manager (Homelab as Code) according to the specifications in `AGENTS.md` and `docs/FEATURES.md`.

---

## Batch Status: Issues #24 – #34 (Complete)

### Completed Issues

| Issue   | Title                                         | Commit    | Summary                                                                                                                                                                                                                                                                    |
| ------- | --------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#24** | Host registry synced from `host.yaml`         | `cc8bbef` | Built `HostRegistry` with `DataDirWatcher`, SQLite `hosts` table cache, credential sanitization (`***`), and REST endpoints (`GET /api/hosts`, `GET /api/hosts/:id`, `POST /api/hosts/sync`).                                                                              |
| **#25** | Persistent SSH connection pool (`ssh2`)       | `ee34a98` | Implemented `SshConnection` conforming to `Transport`, `MaxSessions` channel semaphore (default 10), TOFU / pinned fingerprint check, and `SshPool`.                                                                                                                       |
| **#26** | Proxmox API client (token + ticket auth)      | `2c3be5f` | Built `ProxmoxClient` supporting token header auth, ticket/CSRF auth with auto-refresh on 401, pinned TLS fingerprint verification, and task UPID polling.                                                                                                                 |
| **#27** | Smart connection router                       | `463b05a` | Built `HostConnectionRouter` and `ConnectionManager`, routing status/metrics/power to API and exec/files to SSH with automatic fallback.                                                                                                                                   |
| **#28** | Host capability probe                         | `e866e93` | Built `HostProber` detecting PVE version, cluster membership (with warning generation per D-25/D-26), storage pools, and hypervisor tools (`setfacl`, `rsync`, `restic`, `nsenter`).                                                                                       |
| **#29** | Proxmox config <-> canonical schema codec     | `ddd5845` | Built raw Proxmox parser/serializer (`[PENDING]`, snapshots), options parser, LXC and VM canonical codecs with bidirectional round-trip test coverage for all 4 fixtures in `packages/core/fixtures/proxmox/`.                                                             |
| **#30** | Live inventory service                        | `f271f6f` | Built `LiveInventoryService` with TTL cache, change events (`InventoryChangeEvent`), multi-host failure isolation, and REST endpoints (`GET /api/inventory/hosts`, `GET /api/inventory/guests`, `GET /api/inventory/guests/:hostId/:vmid`, `POST /api/inventory/refresh`). |
| **#31** | Import live guests into YAML deployment files | `33ac77a` | Implemented `generateDeploymentYaml`, `planGuestImport`, `applyGuestImport` with default value omission, write-guard conflict detection, CLI command `hacm import`, and REST endpoints (`POST /api/inventory/guests/:hostId/:vmid/import`, `POST /api/inventory/import`).  |
| **#32** | UI: Hosts overview and host detail            | `26dc92c` | Built `HostsPage` (`/`) and `HostDetailPage` (`/hosts/:id`) with health badges, per-channel status breakdown (SSH/API), latency metrics, cluster membership warnings, storage pool tables, installed tools grids, and YAML add-host guidance.                              |
| **#33** | UI: Resources list and guest detail           | `86cd335` | Added responsive host/type/status/configuration filtering, paginated 100+ guest browsing, orphan indicators, live-versus-YAML detail, and byte-preserving read-only CodeMirror views.                                                                                      |
| **#34** | UI: Safe YAML editor                          | —         | Added JSON Schema autocomplete, live validation, diff review, dry-run preflight, CST/write-guard saves, conflict reporting, hash-only audit entries, and admin-only enforcement for execution surfaces.                                                                    |

---

---

## How to Run & Manually Test the UI

### 1. Prerequisites

- Node 26 (or Node 22+)
- pnpm

### 2. Start the Development Servers

```bash
# In repo root:
pnpm dev
```

This runs Fastify API (`http://localhost:3000`) and Vite React SPA (`http://localhost:5173`) concurrently.

### 3. Initial Setup & Login

1. Open `http://localhost:5173` in your browser.
2. If this is a fresh state directory, you will be redirected to `/setup` to create the initial admin account.
3. Choose an admin username and password.
4. Once authenticated, explore:
   - **Hosts Overview (`/`):** View registered hosts, connection health (SSH / API), latency, and the expandable "How to Add a Host" guide.
   - **Host Detail (`/hosts/:id`):** View detailed connection settings, run live connection tests, view storage pools, and check cluster warnings.
   - **Audit Log (`/audit`):** View real-time security events and diffs with sensitive values redacted (`***`).

---

## Verification & Quality Gates

All checks pass locally before push:

```bash
pnpm format:check   # Prettier verification
pnpm lint           # ESLint with 0 warnings
pnpm typecheck      # TypeScript strict type checking across all workspaces
pnpm test           # Vitest across all packages (698 tests passing)
pnpm test:coverage  # Per-file 90% thresholds
pnpm audit          # Dependency vulnerability check
pnpm build          # tsc -b and Vite production bundle build
pnpm --filter web e2e # Playwright at 360px and 1440px
```
