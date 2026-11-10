# HAC Manager: Features and Business Decisions

This is the authoritative record of **what the product does and why**. It captures the original specification plus the decisions made in the design review. Technical choices with trade-offs go in `docs/adr/`.

Rules for changing this file:

- A change in behaviour or scope updates this file in the same PR.
- Each decision has a stable ID (`D-xx`). Never reuse an ID. Mark superseded decisions instead of deleting them.
- "Milestone" refers to the GitHub milestones M0 to M13.

---

## 1. Vision and positioning

HAC Manager (Homelab as Code) is a self-hosted web app and backend that manages **multiple Proxmox VE hosts** from **local, Git-versioned YAML files**. It replaces an Ansible-based setup.

**Why build it instead of using Terraform, Ansible or Semaphore:** the owner wants full control over their own homelab workflows, in particular safe `mp0` bind-mount handling, drift detection in both directions with comment-preserving YAML edits, file sync with conflict handling, community-script provisioning, and a mobile-friendly UI with durable jobs.

**Primary user:** a single homelab owner (admin), with a schema ready for several users.

## 2. Scope

| In v1                                                | Later (M13 or beyond)                            | Non-goals                             |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| Standalone Proxmox hosts                             | Proxmox clusters                                 | Managing Git (commit, push, branches) |
| LXC and VM lifecycle                                 | Web console (xterm.js)                           | Historical metrics and charts         |
| YAML config with inheritance, tags, safe expressions | Personal API tokens                              | PostgreSQL support                    |
| Secrets from env, `secrets.yaml`, external CLIs      |                                                  | OIDC / SSO                            |
| Headless vault unlock with memory-only tokens        |                                                  |                                       |
| Drift detection and reconciliation                   | Docker Compose stacks module (design spike only) | Replacing Proxmox's own UI            |
| File sync, `.env` rendering, conflict handling       | Optional auto-commit of UI changes (undecided)   | Bundling `op` / `bw` CLIs             |
| Tasks cascade, guest baseline, SSH bootstrap         |                                                  |                                       |
| Community scripts (pinned) and OS templates          |                                                  |                                       |
| Pre-update backups, restore                          |                                                  |                                       |
| Auth, roles, optional TOTP, audit log                |                                                  |                                       |
| Scheduled drift checks                               | Scheduled updates (undecided)                    |                                       |

## 3. Terminology

| Term      | Meaning                                            |
| --------- | -------------------------------------------------- |
| host      | A Proxmox server (later also a Docker host)        |
| guest     | An LXC container or QEMU VM                        |
| resource  | A host or a guest                                  |
| data dir  | The user's infrastructure repo, configured by path |
| state dir | Runtime state (SQLite DB), never tracked           |
| drift     | Evaluated YAML differs from live state             |
| orphan    | A guest with no YAML                               |

**D-01.** "Node" is not used for guests (Proxmox uses it for hypervisors). The original spec's `node.name` becomes `guest.name`.

---

## 4. Decision log

### 4.1 Configuration

**D-02. YAML with custom tags and comment preservation.** Config is Home Assistant style YAML with tags `!env`, `!secret`, `!cmd`, `!expr`, `!include`. Edits (UI or pull) mutate only the target scalar in the syntax tree, keeping comments, blank lines, key order and tags byte-identical elsewhere. Parser: `eemeli/yaml`. _Milestone M1._

**D-03. Schemas are the single source of truth.** Defined once in zod, used for validation, types, JSON Schema (editor autocomplete) and reference docs. Files carry a `schema_version`. Unmodelled Proxmox keys are preserved under `extra`. _M1._

**D-04. Data dir is separate from the app repo.** Configured by `HACM_DATA_DIR`, typically the owner's private infra repo. The app repo ships only `examples/data` for docs and tests. _M0, M1._

**D-05. Layout.**

```text
<data dir>/
  secrets.yaml                         # gitignored, created from secrets.yaml.example
  global-tasks/                        # Tier 1
  hosts/<host>/
    host.yaml                          # connection, host.index, ignored guests
    default-deployment.yaml
    default-filemappings.yaml
    tasks/                             # Tier 2
    <vmid>-<name>/
      deployment.yaml
      filemappings.yaml
      .env.yaml                        # tags rendered into the guest `.env` (D-18)
      appdata/                         # files synced into the guest
      tasks/                           # Tier 3
```

The folder is `hosts/` (not `servers/`) so Docker hosts fit later. _M1._

**D-06. Inheritance.** `default-deployment.yaml` and `default-filemappings.yaml` merge with the guest's own files so common settings are never duplicated. Defaults: lists replace, `network` entries merge by index or name, explicit `null` removes an inherited key, append is opt-in. Every merged value tracks **provenance** (which file and layer it came from) so Pull Live to YAML writes to the right file. Tags resolve after merging, per guest. Final details go in the M1 ADR. _M1._

**D-07. `!expr` uses a sandboxed evaluator, not Python-style f-strings.** No access to process, file system or network, with execution limits. Context variables include `host.id`, `host.index`, `host.name`, `vmid`, `guest.name`, `net.index`, `net.bridge`. Built-in helpers include `mac(prefix, hostIndex, netIndex, vmid)`, `pad`, `hex`, IP and CIDR helpers. Evaluator choice (CEL-style, JSONata-style or custom) is decided in an ADR. _M1._

**D-08. Deterministic MAC scheme is kept.** Format `A2:B1:C1:<host.index>:E<net.index>:<vmid-100>`, where decimal digits are written into hex bytes for human readability (`112` becomes `12`). The `mac()` helper **fails loudly** instead of producing invalid bytes when `vmid >= 200`, host index above 99, or net index of 10 or more. Example result: `A2:B1:C1:01:E0:12`. _M1._

**D-09. `!include` is confined to the data dir.** No path traversal or symlink escape, cycles detected. _M1._

**D-10. Validation tooling.** `hacm validate` (schema, merge, unresolved tags, VMID uniqueness; does not resolve secrets unless asked) and `hacm schema export` for CI, pre-commit and editors. _M1._

**D-11. External edits are expected.** The owner edits files in an IDE while the UI may write them. A file watcher keeps an index, and every write is guarded by a hash check. A changed file produces a conflict, never a silent overwrite. Git remains the owner's responsibility. _M1._

### 4.2 Secrets

**D-12. Tag semantics.**

- `!env VAR`: backend environment or `.env` files.
- `!secret key`: gitignored `secrets.yaml`.
- `!cmd "..."`: configured secret CLI (`op`, `bw`, `vault`, anything).

Resolved plaintext is never written to Git-tracked files. _M2._

**D-13. `!cmd` safety.** Executed with argv (no shell) by default, with timeout, output size limit and an **admin-managed allowlist** of binaries. _M2._

**D-14. In-memory TTL cache.** Resolved secrets are cached in memory only (never on disk) with configurable TTL so background drift checks do not respawn CLIs. _M2._

**D-15. Redaction everywhere.** Resolved secrets are a `Secret` type that serialises as `***`. Logs, job output, diffs, audit payloads and SSE are scrubbed. Secret fields compare by hash in drift. Leak tests are required. _M2._

**D-16. Secret CLIs are not bundled.** The app may run on bare metal, in an LXC or in Docker. Users install `op`/`bw` themselves (or extend the image). _M0 (docs)._

**D-17. Interactive vault unlock is headless and memory-only.** `!cmd` providers expose status and unlock operations. When a required provider is locked, a dependent job pauses in `waiting_input` and emits its existing durable prompt over SSE. An administrator submits a session or service-account token through a dedicated endpoint before resolving the prompt; the token is validated immediately, registered for redaction, held in process memory only and never written to jobs, prompts, audit records or SQLite. Scheduled/background work fails or backs off cleanly when a CLI is unavailable. Desktop-integrated unlock (for example 1Password desktop) is unsupported on servers; use service accounts or externally generated session tokens. _M13._

**D-18. `.env` rendering uses `.env.yaml`.** A YAML map with tags renders to a dotenv file in the guest (mode 0600, escaping for dotenv and Compose `$`). A `template` filemapping whose source is `.env.yaml` names the destination; that destination must be called `.env`, must lie outside the data dir, and always receives mode 0600. Rendering happens once per sync and the plan carries only the rendered hash, size, mode and variable names. `compose.yaml` and app configs stay clean using `${VAR}`. The rendered file is never written to Git-tracked paths, and change detection uses a hash of the rendered output. _M9._

**D-19. `hacm init` scaffolds the data dir.** Creates layout and `.gitignore`, copies `*.example` to untracked counterparts if missing, never overwrites. _M2._

### 4.3 State and source of truth

**D-20. Files are the source of truth for declarative state; the database holds operational state only.** DB: users, sessions, jobs, log lines, prompts, audit, settings, host cache, drift snapshots. Losing the DB loses history, never configuration. _M3._

**D-21. SQLite only in v1.** WAL mode. Single backend instance (the SSH pool, queue and secret cache are in-process). A repository layer keeps a future Postgres dialect possible. _M3._

### 4.4 Connectivity

**D-22. API for reads, SSH for management.** Proxmox API: fast status, metrics, power, task (UPID) tracking. SSH is **mandatory for full management** (`pct`, `qm`, host filesystem, `vzdump`, scripts, file staging). A smart router picks the channel per operation and falls back when possible, failing fast when a required channel is missing. _M4._

**D-23. Persistent SSH pool with exec channels.** One long-lived `ssh2` connection per host, multiplexed exec channels per command (no parsing of an interactive shell), keepalive, reconnect with backoff, respect for `MaxSessions`, scripts passed on stdin. _M4._

**D-24. Host key pinning.** Trust on first use with stored fingerprint and an explicit re-trust flow. TLS for the API uses a pinned fingerprint or custom CA. A configured pin is verified after the TLS handshake and before HTTP sends credentials, including self-signed certificates. If both a CA and a pin are configured, both must match; a trust failure rejects the request without crashing the process. _M4._

**D-25. Capability probe per host.** PVE version, cluster membership, storage types, tools (`acl`, `rsync`, `restic`, `nsenter`), guest-agent availability. Clustered hosts show a warning. _M4._

**D-26. v1 supports standalone hosts.** Cluster-aware behaviour (cluster-wide VMIDs, node-local `/etc/pve/local`) is deferred. _Later._

### 4.5 Jobs, queue and plans

**D-27. All mutations are asynchronous durable jobs.** Closing the browser or switching devices never loses progress. Logs persist line by line and streaming resumes with `Last-Event-ID`. _M6._

**D-28. Queue discipline (replaces "one FIFO per server").** Mutations on the **same guest** are serial. Host-level work has its **own lane**. Concurrency per host is configurable. **Power actions have priority.** Jobs can depend on other jobs. A long backup must not block stopping a container. _M6._

**D-29. Job states.** `queued`, `running`, `waiting_input`, `completed`, `failed`, `cancelled`, `interrupted`. After a backend restart, running jobs become `interrupted` and keep their logs. Cancel and timeout are supported. _M6._

**D-30. Interactive prompts.** Jobs pause in `waiting_input` for decisions (file conflict, split-brain, destructive confirmation, unexpected script prompt). Prompts persist across restarts and can be answered from any device. _M6._

**D-31. Plan then apply.** Every mutating action first produces a viewable plan (redacted before/after, warnings, destructive flags) fingerprinted against live state. Stale plans are refused. Dry-run uses the same code path. Available in UI and CLI (`hacm plan`, `hacm apply`). _M6._

**D-32. Journaled, resumable steps.** Multi-step flows are built from steps with `check`, `apply`, `verify` and a rollback hint, persisted so they can resume. _M6._

**D-33. Real-time transport is SSE.** WebSocket only for the future console. _M6._

**D-34. Scheduler runs drift checks only in v1.** Scheduled jobs are recorded with reason `schedule` and back off when a host or vault is unavailable. _M6._

### 4.6 Guest lifecycle

**D-35. LXC and VM are both first-class.** Create, update, delete, power for both. VMs: clone template, cloud-init, cloud-image import, UEFI/EFI disk, TPM, guest agent. _M7._

**D-36. Safety rules for every lifecycle change.**

- Existence is checked via config files / API before acting.
- **Disks are additive only**: grow when YAML grows, never shrink automatically (refuse and warn).
- **Multi-NIC lifecycle**: `net0`, `net1`, ... with bridge, IP/CIDR, gateway, VLAN, MTU, IPv6 mode. Interfaces removed from YAML are removed from the guest **after confirmation**.
- Restart-required changes are detected and a controlled restart is scheduled.
- `[PENDING]` config sections are detected and surfaced.
- `protection: true` blocks deletion and destructive changes until explicitly lifted. _M7._

**D-37. Safe deletion.** Typed confirmation, `protection` respected, optional backup first, purge options, audit entry. Shared by manual delete and orphan delete. _M7._

**D-38. Identity verification (anti-collision).**

- Per-guest `identity_checks` run inside the guest (for example `test -d /opt/AdGuardHome`).
- They run before any update, file sync or backup. **A VMID that exists but fails its check halts the job**, protecting a different workload in the same VMID.
- Additionally, managed guests are **stamped** with a tag and a UUID in the Proxmox `description`, so reuse of a VMID is detected even before a check can run.
- Behaviour for stopped or not-yet-installed guests is explicit. _M7._

**D-39. Protected-guest rule.** The guest hosting this app cannot be updated, stopped or deleted by its own jobs. _M7._

### 4.7 Provisioning

**D-40. OS templates.** `pct create` with the data dir's definition, including `mp0` attached at creation. _M7._

**D-41. Community scripts are supported in v1 (M10).**

- Scripts are **pinned to a commit SHA and/or content hash** and cached; when upstream changes, an admin sees a diff and must approve. Unpinned `main` URLs are rejected unless an admin opts in.
- Run under a pseudo-terminal with injected env (`TERM=xterm`, `var_ctid`, `var_unprivileged`, `var_cpu`, `var_ram`, `var_disk`, `var_brg`, `var_net`, `var_ssh`, ...).
- Configured `answers` are matched against prompts. **An unexpected prompt pauses the job** and asks the user instead of guessing.
- `installation.url` is **admin-only**.
- After the script: stop CT, run the `mp0` migration, stamp, run identity checks, start. _M10._

### 4.8 `mp0` storage guard

Goal: persistent app data lives on the host at `/opt/server-data/<host>/<guest>/opt`, mounted at `/opt` in the LXC via `mp0`, without shadowing, split-brain or permission failures.

**D-42. Three Proxmox pitfalls the design must avoid.**

1. Unprivileged UID/GID shifting (container root is host `100000:100000`).
2. Pre-mount rootfs shadowing and split-brain: attaching `mp0` after an app installed into the rootfs hides its files; if `mp0` later fails to mount, the CT silently writes to the rootfs.
3. Hot-plug `[PENDING]` and stale mount namespaces in long-running daemons (`dockerd`, `containerd`, `postgres`).

**D-43. Host directory preparation.** Created before provisioning with ownership computed from the guest's idmap (`mounts[].owner`, shifted by `idmap`; unprivileged default base `100000`). Defaults are **minimal permissions** (`0750`); world-writable `2777` with default ACLs is an **explicit opt-in** only and requires the host `acl` tooling (Tier-2 helper). _M9._

**D-44. Zero-shadowing attachment.** For template-based LXCs `mp0` is attached at `pct create` before first boot. `mp0` is **never hot-applied**: stop, attach, start, and verify `[PENDING]` is empty. _M9._

**D-45. Rootfs-to-host migration is non-destructive and resumable.** For script-created CTs: take a `vzdump` snapshot first, stop, `pct mount`, `rsync -aAXH --numeric-ids` to the host directory, shift UIDs by the guest idmap, **rename** the old `/opt` to `/opt.migrated-<timestamp>` (not wiped), unmount, attach `mp0` while stopped, start, verify that `[PENDING]` is empty and the host directory has the planned ownership. Deleting the displaced copy is a separate, explicit, later action. UID/GID shifting is idempotent, refuses an idmap whose base overlaps its size, and refuses a host destination that overlaps the mounted rootfs or a host system path. _M9._

**D-46. Invariant check is storage-agnostic (replaces `debugfs`).** The raw rootfs `/opt` is inspected by entering the CT's mount namespace (`nsenter -t <pid> -m`) and making a non-recursive bind mount of `/`, which works on LVM, ZFS, btrfs and directory storage. Also verified: `findmnt` inside the CT and `/proc/<pid>/mountinfo` for long-running daemons. Runs before file sync and stack starts. _M9._

**D-47. Split-brain resolution.** The job pauses with a UI modal showing file counts and newest timestamps on both sides. Options: **Keep Host Data** or **Migrate Rootfs to Host**. The displaced side is **backed up first**. _M9._

### 4.9 File sync (`filemappings`)

**D-48. Mapping types.** Single file (with `mode` and owner), archive (`.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, extracted in the guest), directory sync (tar streaming or rsync, optional `delete`), rendered templates. _M9._

**D-49. Transfer methods.** LXC: `pct push/pull`, tar streaming through `pct exec`, rsync via `pct mount`. VM: guest agent file-write/exec, or SFTP/tar over SSH when available. Neither available: clear error. Files destined for `mp0`-backed paths are written **directly to the host path** with correct UID shift. _M9._

**D-50. Conflict resolution.** SHA256 compared before overwrite. A remote file that differs from both the source and the hash recorded at the last sync is a conflict. Per-mapping policy: `overwrite`, `skip`, `fetch` (pull remote file back into the data dir through the write guard) or `prompt` (UI diff, job pauses). Rendered `.env` files may never be fetched back into the data dir. Audit reason `conflict_resolution`. _M9._

### 4.10 Tasks and guest baseline

**D-51. Three-tier cascade.**

- **Tier 1 global:** across hosts (selected by groups or tags declared in `host.yaml`).
- **Tier 2 host:** hypervisor tasks (`acl`, `e2fsprogs`, `rsync`, `/etc/vzdump.conf` templates, host restic cron).
- **Tier 3 guest:** inside the guest after file sync (`docker compose up -d --remove-orphans`, `systemctl enable --now`).

Tier 3 is skipped unless file sync, identity checks and invariant checks have all completed. Tiers run in ascending order, can resume from a chosen tier, and report skipped tiers with a reason. A configurable failure policy — `abort` (default), `abort-tier` or `continue` — decides whether a failure stops the remaining tasks and later tiers. Task fields: `name`, `run`, `when`, `creates` (idempotency), `timeout`, `retries`, `ignore_errors`, `onchange`, `env`, `shell`. Ordering by filename prefix; `!include` supported. Scripts go on stdin. **Only admins may edit tasks.** _M11._

**D-52. Guest baseline.** OS detection via `/etc/os-release` (Debian, Ubuntu, Alpine), IPv6 enable/disable through `/etc/sysctl.d/99-disable-ipv6.conf`, OS package upgrades (`apt-get upgrade`, `apk upgrade`) and app `update_commands`, always after backup and identity check. _M11._

**D-53. SSH bootstrap.** Test guest port 22; if unreachable, install and enable `openssh-server` through `pct exec` / guest agent. Idempotently sync the root password (compare `/etc/shadow` hash with the same salt) and `authorized_keys`. _M11._

### 4.11 Backups

**D-54. Pre-update `vzdump`.** Snapshot mode, zstd, label `VMID_YYYY-MM-DD_HH-MM-SS_AppName`, configurable `backup_skip` and `backup_storage`. **A failed backup aborts the update.** _M12._

**D-55. Bind-mount data needs its own protection.** `vzdump` does **not** back up bind mounts, so `mp0` host data gets a separate pre-update step. The plan selects a storage snapshot when the mount declares a ZFS dataset or a BTRFS file system, otherwise restic when a repository is configured, otherwise an rsync copy into a timestamped backup root; callers may force a method. The plan states exactly what is and is not covered, and a failing host-data step aborts the update. _M12._

**D-56. One-click restore.** `pct restore` / `qmrestore` with typed confirmation `RESTORE <vmid>`, a warning that the archive contains the rootfs only and that `mp0` host data must be restored separately, and an offer to restore matching host data. Before any host data is replaced, the current copy is moved to a timestamped path and kept. The restored guest is started, identity-checked against its YAML stamp and name, and LXC guests with host data get a storage invariant check. _M12._

**D-57. Host backup management.** Declarative Tier-2 management of `/etc/vzdump.conf` and a restic script plus `/etc/cron.d` fragment, configured under `backup` in `host.yaml`. Rendering is deterministic and sorted. Resolved `Secret` values are refused in managed files: credentials stay in root-only files referenced by absolute path (`password_file`, `repository_file`). Apply is idempotent and atomic (temporary sibling, `chmod`, `mv`), and content or mode drift on a managed file is visible in the plan. Status reports last run and last success from the restic status file the script writes and from the most recent `vzdump` tasks. _M12._

### 4.12 Drift

**D-58. Bidirectional drift.** Evaluated YAML versus live state for CPU, RAM, disks, NICs, features, tags, protection and synced files, on demand and on schedule. Diffs are structured, redacted and include provenance. _M8._

**D-59. Resolution per item or in bulk.**

- **Enforce YAML to Live**: builds a plan and applies it as a job.
- **Pull Live to YAML**: patches YAML through the CST, preserving comments and tags, writing to the correct layer.
- **Fields that are tag-valued (`!expr`, `!env`, `!secret`, `!cmd`) are computed and are not auto-pulled**; the UI explains why. _M8._

**D-60. A Proxmox config codec is a prerequisite.** Parsing and serialising `pct config` / `qm config` to a canonical schema, with round-trip tests, is the foundation for drift, import and updates. _M5._

### 4.13 Orphans

**D-61. Orphan handling.** A guest on a host with no YAML triggers three choices: **Import to YAML** (generated from live config, omitting values equal to defaults, no resolved secrets), **Delete** (typed confirmation), **Ignore**. _M8._

**D-62. The ignore list is declarative and lives in `host.yaml`, not the DB.** Entries carry a fingerprint beyond the bare VMID (for example name and creation info), so a reused VMID is not silently ignored. _M8._

**D-63. Import is the onboarding path.** The owner authors YAML from live state, so **Import live to YAML** (CLI and UI) is the first vertical slice. _M5._

### 4.14 Users, roles, audit, security

**D-64. Local auth.** First-run admin setup, argon2id, secure cookie sessions, CSRF protection, rate limiting and lockout, security headers. Sessions have a two-hour idle expiry that is refreshed in SQLite and a 24-hour absolute lifetime. Optional TOTP with single-use recovery codes; the browser submits the appropriate second factor and derives authenticated state only from a valid server session response. API tokens later. No OIDC in v1. _M3, M13._

**D-65. Roles.** `admin`, `operator`, `viewer`, plus per-host access and the `auto_grant_new_hosts` flag. Single-admin UX first; the schema supports several users.

- Viewer: read only.
- Operator: run jobs on granted hosts.
- Admin: everything, and **only admins** edit tasks, `!cmd`, `!include`, `installation.url`, users and the `!cmd` allowlist. _M3._

**D-66. Audit log.** Every change records **who**, **what** (redacted diff), **when**, and **why** (`manual`, `drift_push`, `drift_pull`, `schedule`, `conflict_resolution`, `orphan_action`), linked to the job. Append-only, filterable by user, host, VMID, reason and time. _M3._

**D-67. Threat model.** The app owns root on every host. Hardening is required, not optional: auth, redaction, host key pinning, allowlists, admin-only execution surfaces.

### 4.15 UI

**D-68. Responsive, modern dashboard (desktop and mobile).** Modules:

- **Hosts overview:** health, SSH/API status, probe warnings, queue status, vault status.
- **Resources:** live state, YAML view and editor, quick actions, backups, orphan alerts.
- **Drift and Sync Center:** side-by-side diffs, conflicts, one-click push/pull.
- **Jobs and Queue:** live logs, per-host queue, prompts, cancel.
- **Audit log and Users.**
- **Docker Compose Stacks:** future module.

Host detail supports SSH-only connections. Connection tests, capability probes, registry resyncs and clipboard failures display an error and keep the page available for retry. Last known SSH/API channel status is persisted in the state database, so it survives restarts without re-testing. Capability probes are cached per server process and load in the background, so host detail is usable immediately. Resources show a labelled search field and default to VMID order. Orphans can be imported to deployment YAML from their detail page. Guest state refreshes automatically when a queued power or import job finishes.

_M5, M6, M8._

**D-69. YAML editor.** CodeMirror 6 with JSON Schema validation and autocomplete, server-side validate and save via the CST layer, diff preview, conflict message on external edits. Admin-only for files containing execution surfaces. _M5._

**D-70. Metrics are live only.** No historical charts in v1. _Scope._

### 4.16 Packaging and deployment

**D-71. Runs on bare metal, in an LXC or in Docker.** Non-root Docker image with `/data` and `/state` volumes, a compose example, a systemd unit, GHCR releases (semver via changesets). License MIT. _M0._

**D-72. Stack.** Node 22 LTS, pnpm workspaces, TypeScript strict, Fastify, Drizzle + better-sqlite3, React + Vite + Tailwind + shadcn/ui, CodeMirror 6. Bun is not used (native module compatibility). _M0._

---

## 5. Safety invariants (must always hold)

1. No resolved secret ever appears in logs, diffs, audit, plans, SSE or Git-tracked files.
2. No arbitrary code evaluation in expressions.
3. Disks never shrink automatically.
4. `mp0` is never hot-applied.
5. User data is never destroyed in a single step.
6. Identity check passes before update, file sync or backup.
7. Every mutation has a plan and a dry-run path.
8. Destructive actions need typed confirmation and respect `protection`.
9. The app never manages the guest it runs in.
10. Externally edited files are never silently overwritten.
11. Execution surfaces (tasks, `!cmd`, `!include`, `installation.url`) are admin-only and enforced server-side.
12. Losing the database never loses configuration.

## 6. Original spec items and their fate

| Original item                                                 | Outcome                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Python-style `!expr`                                          | Replaced by sandboxed evaluator and helpers (D-07)       |
| `node` for guests                                             | Renamed to guest (D-01)                                  |
| `servers/proxmox01/server.yaml`, `data/` inside app repo      | `hosts/<name>/host.yaml`, data dir separate (D-04, D-05) |
| Example `112-adguard.yaml` vs `112-adguard/deployment.yaml`   | Folder layout is canonical (D-05)                        |
| SQLite or PostgreSQL                                          | SQLite only (D-21)                                       |
| Orphan ignore list in DB                                      | In `host.yaml` (D-62)                                    |
| One FIFO per server                                           | Per-guest locks plus host lane plus priority (D-28)      |
| `jobs.logs` column                                            | `job_log_lines` table (D-27)                             |
| WebSockets for logs                                           | SSE (D-33)                                               |
| `debugfs` rootfs check                                        | Mount-namespace check (D-46)                             |
| `chmod 2777` and ACLs by default                              | Minimal by default, opt-in (D-43)                        |
| Wipe rootfs `/opt` after migration                            | Rename and keep (D-45)                                   |
| Community scripts via `main` URL                              | Pinned, approved on change (D-41)                        |
| `.env.template`                                               | `.env.yaml` (D-18)                                       |
| `users.auto_grant_new_servers` only                           | Roles plus per-host access (D-65)                        |
| Monaco or CodeMirror                                          | CodeMirror 6 (D-72)                                      |
| Node or Bun, Fastify or Hono, Drizzle or Prisma, React or Vue | Decided in D-72                                          |

## 7. Open decisions

- **Expression evaluator:** CEL-style, JSONata-style or custom (ADR in M1).
- **Cluster support:** design after v1.
- **Optional auto-commit** of UI-made changes to the data dir's Git repo.
- **Scheduled updates** beyond scheduled drift checks.
- **Docker Compose module:** build a thin UI over tasks and file sync, or integrate with an existing tool (design spike, M13).
- **Exact list-merge semantics** (finalised in the M1 ADR).
