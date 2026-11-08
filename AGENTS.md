# AGENTS.md

Orientation for AI coding agents (and humans) working in this repository. Read this first, then `docs/FEATURES.md` before changing any behaviour.

## What this project is

**HAC Manager** (HAC = _Homelab as Code_) is a self-hosted web app and backend that manages one or more **Proxmox VE** hosts (Docker hosts later) from local, Git-versioned **YAML files**. It replaces an Ansible-based setup and gives the owner full control over their own homelab: provisioning LXCs and VMs, syncing app files, running tasks, taking backups, and detecting and resolving drift between the YAML and the live state.

The app holds **root-equivalent access to every host it manages** (SSH + Proxmox API). Treat every change as security-sensitive.

## Status

The repository started with no code. The plan lives in GitHub issues and milestones **M0 to M13**, plus a "Roadmap: HAC Manager v1" tracking issue. Do not trust this paragraph about progress: check the repo, open issues and merged PRs. Work in milestone order and respect each issue's "Depends on" section.

## Where things are documented

| Need                                              | Read                                  |
| ------------------------------------------------- | ------------------------------------- |
| Business rules, scope, safety invariants          | `docs/FEATURES.md`                    |
| Why a technical choice was made                   | `docs/adr/`                           |
| What to build next                                | GitHub issues and milestones          |
| Original raw spec (historical, partly superseded) | `docs/` or the first issue discussion |

If code and `docs/FEATURES.md` disagree, the document wins until a deliberate change updates both. A change to a business decision needs an update to `docs/FEATURES.md` and, for technical choices, a new ADR.

## Vocabulary (use it exactly)

- **host**: a Proxmox server (later also a Docker host). Defined by `hosts/<name>/host.yaml`.
- **guest**: an LXC container or a QEMU VM on a host.
- **resource**: host or guest, when either applies.
- **data dir**: the user's infrastructure repo (`HACM_DATA_DIR`). It is **not** this repo.
- **state dir**: runtime state such as the SQLite DB (`HACM_STATE_DIR`). Never tracked.
- **drift**: difference between evaluated YAML and live state.
- **orphan**: a guest on a host with no YAML.
- **plan / apply**: a viewable change set, then its execution as a job.
- Do not use "node" for a guest. In Proxmox, a node is a hypervisor.

## Architecture in one screen

```
Web UI (React SPA)  <--REST + SSE-->  Fastify API
                                        |-- auth / RBAC / audit
                                        |-- config-engine  (YAML CST, tags, merge, safe expr)  <-> data dir (files)
                                        |-- secret-manager (!env/!secret/!cmd, TTL cache, redaction)
                                        |-- job queue (SQLite, per-guest locks, host lane, journaled steps)
                                        |-- reconciler (live state, codec, drift, plan/apply)
                                        |-- storage-guard (mp0, file sync)
                                        `-- connection-manager (smart router)
                                              |-- Proxmox REST API  (status, metrics, power, tasks)
                                              `-- SSH pool (ssh2)    (pct, qm, filesystem, vzdump, scripts)
SQLite: users, sessions, jobs, job_log_lines, prompts, audit, settings, host cache
```

Source of truth rules (important):

- **Declarative state lives in files** (data dir): hosts, guests, mappings, tasks, orphan ignore list.
- **The database holds operational state only**: users, sessions, jobs, logs, prompts, audit, caches. Losing the DB must never lose configuration.

## Planned repository layout

```
packages/core     pure logic: schemas (zod), YAML CST, merge, tag resolution, expr, codec, planner, Transport interface
packages/server   Fastify API, DB (Drizzle + better-sqlite3), jobs, connectivity, auth
packages/web      React + Vite + Tailwind + shadcn/ui, CodeMirror 6
packages/cli      `hacm` CLI (validate, schema export, init, import, plan, apply)
examples/data     sample data dir, also the test fixture
docs/             FEATURES.md, adr/
deploy/           systemd unit, compose example
```

Dependency direction: `web` and `cli` and `server` depend on `core`. `core` depends on nothing from the others and does no I/O except through the `Transport` interface and an injected file system.

## Tech stack (decided)

Node 22 LTS (not Bun), pnpm workspaces, TypeScript strict (ESM), zod at every boundary, Fastify + `fastify-type-provider-zod`, Drizzle + better-sqlite3 (SQLite only in v1), `eemeli/yaml` for the CST, `ssh2`, native `fetch` for the Proxmox API, React + Vite + Tailwind + shadcn/ui, CodeMirror 6, Server-Sent Events for streaming (WebSocket only for the future web console), Vitest, ESLint (flat config), Prettier.

## Commands

The contract after the bootstrap issue lands (verify in `package.json`):

```bash
corepack enable && pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # must all pass before any PR
pnpm dev                                                # server + web
pnpm --filter <package> <script>                        # single package
```

## Non-negotiable rules

Security

1. **Never log, persist, diff or audit a resolved secret.** Secrets are wrapped in a `Secret` type that serialises as `***`. Compare secret fields by hash. Add a leak test when you add a new output path.
2. **No arbitrary code evaluation.** `!expr` uses the sandboxed evaluator and built-in helpers only. No `eval`, `Function`, `vm` shortcuts, or shelling out to Python.
3. `!cmd` runs with argv (no shell) unless explicitly configured, with timeout, size limit and an admin allowlist.
4. `!include` is confined to the data dir (no `..`, no symlink escape).
5. Anything that can run commands (tasks, `!cmd`, `!include`, `installation.url`) is **admin-only** to create or edit. Enforce on the server, not just in the UI.
6. Verify SSH host keys (pinned fingerprint). Never disable TLS verification globally.
7. Fixtures and tests must contain only fake data. Never commit real hostnames, keys, tokens or IPs.

Data safety 8. **Disks only grow.** Never shrink automatically. 9. **Never hot-apply `mp0`.** Stop, attach, start, then verify `[PENDING]` is empty. 10. **Never wipe user data in one step.** Displace to a timestamped path, verify, delete later as an explicit action. 11. **Every mutating operation has a plan and a dry-run path.** Executors receive `dryRun` and must not mutate when it is set. 12. **Run the identity check before any update, file sync or backup.** On mismatch, halt. 13. **Destructive actions require typed confirmation** and respect the guest's `protection` flag. 14. A guest hosting the app itself is protected from its own jobs. 15. Do not overwrite a file the user changed externally: use the write guard (hash check) and surface a conflict.

Engineering 16. All YAML edits go through the CST layer so comments, ordering and tags survive. Never `JSON.stringify` a config back to disk. 17. Remote execution goes through the `Transport` interface using exec channels. Send scripts on stdin, never nested `bash -c '...'` quoting. Do not parse an interactive shell. 18. Code that touches Proxmox must be testable with `FakeTransport` and recorded fixtures. **Never run against a real host unless the user explicitly asks.** 19. Multi-step operations use the journaled step runner (`check`, `apply`, `verify`, `rollbackHint`) so they can resume. 20. Streaming and logs persist line by line (`job_log_lines`); clients resume with `Last-Event-ID`.

## Conventions

- TypeScript: no `any` without a comment, no default exports in libraries, prefer discriminated unions, typed error results for expected failures (locked vault, stale plan, conflict).
- Config shapes are defined once in zod in `core`; derive types, JSON Schema and docs from them.
- Use the structured logger, not `console.log`. Logger output passes through redaction.
- Tests live beside code as `*.test.ts`. Prefer golden files for plans, diffs and YAML edits. Add a fixture rather than mocking ad hoc.
- Commits follow Conventional Commits. One issue per PR where possible; reference it (`Closes #N`).
- Every PR: tests, docs updated if behaviour changed, `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- New dependencies need a reason in the PR. Pin versions; prefer small, maintained packages.

## Working on an issue

1. Read the issue, its dependencies and the matching section of `docs/FEATURES.md`.
2. Check that dependencies are merged. If not, stop and say so.
3. If the issue conflicts with a documented decision, do not improvise: raise it in the PR or issue and propose an ADR.
4. Implement with tests and fixtures. Keep scope to the issue. Note follow-ups as new issues.
5. Update `docs/FEATURES.md` or `docs/adr/` when decisions change, and this file when conventions change.

## Things agents commonly get wrong here

- Treating `data/` as part of this repo. It is user content, configured by path.
- Calling a guest a "node".
- Writing resolved values back to YAML after a pull. Fields that are `!expr`, `!env`, `!secret` or `!cmd` are computed and are not auto-pulled.
- Assuming LVM-thin ext4 storage. Storage-agnostic checks only (see the `mp0` invariant in FEATURES.md).
- Assuming a cluster. v1 supports standalone hosts; clustered hosts get a warning.
- Assuming `vzdump` backs up bind mounts. It does not.
- Using `pct`-only logic for VMs. Guests are LXC **and** VM; file transfer and exec differ (guest agent or SSH for VMs).
- Putting declarative state (for example the orphan ignore list) in the database.

## Out of scope for v1

Git management (the user handles Git), clusters, historical metrics, OIDC, PostgreSQL, the Docker Compose module (design spike only), web console and interactive vault-unlock UI (milestone M13).
