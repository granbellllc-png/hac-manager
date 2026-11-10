# HAC Manager

[![CI](https://github.com/alexandre-leites/hac-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/alexandre-leites/hac-manager/actions/workflows/ci.yml)

**HAC means Homelab as Code.** HAC Manager is a self-hosted web app and backend for managing standalone Proxmox VE hosts and their LXC containers and QEMU VMs from local, Git-versioned YAML files.

Built for an owner who wants full control of their homelab, it brings together safe bind-mount handling, bidirectional drift reconciliation, comment-preserving YAML editing, file sync, provisioning, backups and durable jobs in a mobile-friendly UI. Docker hosts are a future extension.

> HAC Manager holds root-equivalent access to every managed host. Keep it on a trusted network, protect its credentials, and read [SECURITY.md](SECURITY.md) and the [safety invariants](docs/FEATURES.md#5-safety-invariants-must-always-hold) before deploying it. Never test development code on real hosts without explicit authorization.

## Status and roadmap

The project is under development. The workspace and API skeleton are available; the responsive UI arrives in issue [#5](https://github.com/alexandre-leites/hac-manager/issues/5). It is not ready to manage infrastructure.

Follow the [v1 roadmap](https://github.com/alexandre-leites/hac-manager/issues/75) and [milestones](https://github.com/alexandre-leites/hac-manager/milestones). [FEATURES.md](docs/FEATURES.md) is authoritative. [FIRST_SPECIFICATION.md](docs/FIRST_SPECIFICATION.md) records the historical proposal; its superseded choices do not override FEATURES.md. Contributor guidance is in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Quickstart for development

Install the Node 22 version in `.nvmrc` and Corepack (some Node distributions require `npm install --global corepack`). Then:

```sh
corepack enable
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm audit
pnpm build
cp .env.example .env
pnpm dev
```

`pnpm dev` starts the API and the Vite dev server (port 5173, proxying `/api` to the API). Regenerate the typed web API client from the OpenAPI document with `pnpm api:generate`. `pnpm --filter web e2e` runs the Playwright smoke test at 360px and 1440px (run `pnpm --filter web exec playwright install chromium` once). The API defaults to `127.0.0.1:3000`; check `GET /api/health` and inspect `GET /api/openapi.json`. No connection to Proxmox is made by the skeleton. Package commands use `pnpm --filter server <script>`, `web`, `cli` or `@hacm/core`.

To bootstrap a new infrastructure repo outside this app checkout, run:

```bash
# Scaffold a new infrastructure data directory
pnpm --filter cli exec hacm init --data-dir ../my-homelab --host pve-01

# Validate syntax, schemas, VMID uniqueness, and tags
pnpm --filter cli exec hacm validate --data-dir ../my-homelab

# Review and save an import plan, then apply the exact fingerprinted state
pnpm --filter cli exec hacm plan --data-dir ../my-homelab --host pve-01 --file ./pct-112.conf --vmid 112 --out ./import-112.plan.json
pnpm --filter cli exec hacm apply --data-dir ../my-homelab --plan ./import-112.plan.json
```

Adjust connection details in `hosts/<host>/host.yaml` and configure credentials in untracked `secrets.yaml` (automatically ignored by git). `.env.example` documents runtime configuration; development and production start scripts load the root `.env` when present. Required data and state paths are parsed at startup; the state dir must be outside the data dir. Invalid configuration aborts with field diagnostics without printing environment values.

After `pnpm build`, run `pnpm --filter server start`. Set `HACM_WEB_DIR` to an absolute built SPA directory to serve it from the API; leaving it empty disables static serving. Deep UI links fall back to the SPA, while unknown API routes and missing assets return 404. SIGINT and SIGTERM close the listener gracefully. Regenerate the config reference (docs/reference/config.md) with pnpm docs:schema and export editor JSON Schemas to packages/core/dist/schemas with pnpm schema:export. Regenerate the checked-in OpenAPI document with `pnpm --filter server openapi:generate`.

## Architecture

The [architecture decision index](docs/adr/README.md) explains the stack, state ownership, security boundaries and execution model.

```text
React SPA / CLI ── REST + SSE ── Fastify API
                                   ├─ auth, RBAC, audit
                                   ├─ config engine / secrets ── data dir (YAML)
                                   ├─ jobs, journal, plans ── state dir (SQLite)
                                   ├─ drift, storage guard, file sync
                                   └─ connection manager ── Proxmox API + SSH
```

`core` owns pure logic, schemas and transport contracts. `server`, `web` and `cli` depend on `core`; the reverse dependency is forbidden. Config files are the source of truth. SQLite holds operational state only. The backend runs as one instance.

## Repository layout

```text
packages/core/      schemas, YAML CST, merge, expressions, codec, planner
packages/server/    Fastify API, SQLite, auth, jobs, connectivity
packages/web/       React SPA, Vite, Tailwind, shadcn/ui, CodeMirror
packages/cli/       hacm command line
examples/data/     fake infrastructure, shared by docs and tests
docs/              features, historical specification, architecture decisions
deploy/            deployment assets (planned)
```

The user's data dir (`HACM_DATA_DIR`) is separate from this repository:

```text
<data dir>/
  secrets.yaml.example
  secrets.yaml                      # untracked
  global-tasks/
  hosts/<host>/
    host.yaml
    default-deployment.yaml
    default-filemappings.yaml
    tasks/
    <vmid>-<guest>/
      deployment.yaml
      filemappings.yaml
      appdata/
      tasks/
```

Runtime state (`HACM_STATE_DIR`) must also stay untracked. Losing it must never lose declarative configuration.

## Glossary

| Term         | Meaning                                       |
| ------------ | --------------------------------------------- |
| host         | Proxmox hypervisor; Docker host later         |
| guest        | LXC container or QEMU VM                      |
| resource     | A host or guest                               |
| data dir     | Owner's YAML infrastructure repo              |
| state dir    | Runtime SQLite, logs and caches               |
| drift        | Evaluated YAML differs from live state        |
| orphan       | Live guest with no YAML definition            |
| plan / apply | Review a change set, then execute it as a job |

Proxmox uses **node** for a hypervisor; HAC Manager never uses that word for a guest.

## Supported direction

v1 targets standalone Proxmox hosts, LXC and VM workflows, local authentication, scoped personal API tokens, SQLite, SSE and audited interactive host/LXC consoles. Git management, clusters, historical metrics, PostgreSQL and OIDC are outside v1. External secret CLIs such as `op` and `bw` are not bundled; users install them themselves. Locked providers pause dependent jobs and accept an administrator-supplied session or service-account token that is held in memory only. Server deployments should use service accounts instead of desktop integration.

## License

[MIT](LICENSE).
