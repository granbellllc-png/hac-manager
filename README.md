# HAC Manager

**HAC means Homelab as Code.** HAC Manager is a self-hosted web app and backend for managing standalone Proxmox VE hosts and their LXC containers and QEMU VMs from local, Git-versioned YAML files.

Built for an owner who wants full control of their homelab, it brings together safe bind-mount handling, bidirectional drift reconciliation, comment-preserving YAML editing, file sync, provisioning, backups and durable jobs in a mobile-friendly UI. Docker hosts are a future extension.

> HAC Manager holds root-equivalent access to every managed host. Keep it on a trusted network, protect its credentials, and read [SECURITY.md](SECURITY.md) and the [safety invariants](docs/FEATURES.md#5-safety-invariants-must-always-hold) before deploying it. Never test development code on real hosts without explicit authorization.

## Status and roadmap

The project is under development. The initial workspace provides tooling and package boundaries; the runnable API and responsive UI arrive in issues [#4](https://github.com/alexandre-leites/hac-manager/issues/4) and [#5](https://github.com/alexandre-leites/hac-manager/issues/5). It is not ready to manage infrastructure.

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

`pnpm dev` currently watches the server and web package entry points; it will start the API and Vite UI when their skeletons land. No connection to Proxmox is made by the bootstrap workspace. Package commands use `pnpm --filter server <script>`, `web`, `cli` or `@hacm/core`.

Copy `examples/data` to a directory **outside this app checkout** to start your own infrastructure repo. Adjust fake connection details and supply secrets in untracked files. `hacm init` and `hacm validate` are planned in the configuration and secrets milestones. `.env.example` documents runtime configuration; environment loading will be implemented with the API skeleton.

## Architecture

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

v1 targets standalone Proxmox hosts, LXC and VM workflows, local authentication, SQLite and SSE. Git management, clusters, historical metrics, PostgreSQL and OIDC are outside v1. Interactive vault unlock and the web console are later work. External secret CLIs such as `op` and `bw` are not bundled; users install them themselves. Server deployments should use service accounts instead of desktop integration.

## License

[MIT](LICENSE).
