# Deployment

HAC Manager runs as a single instance on bare metal, in an LXC, or in Docker. It holds root-equivalent access to every host it manages, so treat the machine it runs on accordingly: bind to loopback, terminate TLS in a trusted reverse proxy, and keep `HACM_COOKIE_SECURE=true`.

Two directories are mounted or configured, and they must stay separate (the state dir must be outside the data dir):

| Variable         | Image path | Purpose                                                      |
| ---------------- | ---------- | ------------------------------------------------------------ |
| `HACM_DATA_DIR`  | `/data`    | Your infrastructure repo: declarative YAML. Managed with Git |
| `HACM_STATE_DIR` | `/state`   | Runtime state (SQLite, caches). Never tracked                |

See [`.env.example`](../.env.example) for every setting.

## Docker

```bash
docker run -d --name hacm -p 127.0.0.1:3000:3000 \
  -e HACM_SESSION_SECRET="$(openssl rand -hex 32)" \
  -v "$PWD/data:/data" -v "$PWD/state:/state" \
  ghcr.io/alexandre-leites/hac-manager:latest
```

The image runs as the non-root `node` user (UID 1000), so the mounted directories must be writable by it. It ships a healthcheck against `GET /api/health`. [`docker-compose.example.yml`](../docker-compose.example.yml) is a ready-made compose file.

Build locally with `docker build -t hacm .`.

### Secret CLIs (`op`, `bw`)

External secret CLIs are **not bundled**. Either run HAC Manager on a host where you installed them, or extend the image:

```dockerfile
FROM ghcr.io/alexandre-leites/hac-manager:latest
USER root
# Install your secret CLI here, then drop privileges again.
USER node
```

Use service accounts or tokens rather than desktop integrations on servers.

When an `!cmd` provider is locked, a dependent job pauses and the Jobs page
asks an administrator for the provider's session or service-account token.
The server validates that token with the installed CLI and keeps it in process
memory only. It is lost on restart and is never stored in SQLite, job payloads,
prompts or audit records. The built-in headless adapters use:

| CLI     | In-memory environment variable | Recommended input               |
| ------- | ------------------------------ | ------------------------------- |
| `op`    | `OP_SERVICE_ACCOUNT_TOKEN`     | 1Password service-account token |
| `bw`    | `BW_SESSION`                   | Output from `bw unlock --raw`   |
| `vault` | `VAULT_TOKEN`                  | Scoped HashiCorp Vault token    |

The 1Password desktop-app integration cannot unlock a headless server. Prefer
a service account with access limited to the vaults and items HAC Manager
needs.

## systemd (bare metal or LXC)

1. Install Node 22 LTS and pnpm, clone the repository to `/opt/hac-manager`, then `pnpm install --frozen-lockfile && pnpm build`.
2. Create a `hacm` user, `/var/lib/hacm` (state) and your data dir (for example `/srv/hacm-data`).
3. Copy [`deploy/hacm.service`](../deploy/hacm.service) to `/etc/systemd/system/`, adjust `ReadWritePaths`, and create `/etc/hacm/hacm.env` (mode `0600`, owned by root) based on `.env.example`. Set `HACM_WEB_DIR=/opt/hac-manager/packages/web/dist`.
4. `systemctl enable --now hacm`.

### Running inside an LXC

Use an **unprivileged** Debian or Ubuntu LXC with Node 22 and follow the systemd steps. Give it network access to the Proxmox hosts (API and SSH) and nothing else. Do not enable `nesting` or privileged mode unless you need them for your own reasons.

## Do not manage the guest HAC Manager runs in

An instance must not apply changes to the guest or host it runs on: a stop, restart or update would kill the job halfway. Set `HACM_PROTECTED_HOST_ID` and `HACM_PROTECTED_GUEST_ID` to the host and guest hosting the app so the protected-guest rule (FEATURES.md) refuses jobs against it. Manage that guest by hand or from a second instance.

## Releases

Versions follow semver and are managed with [Changesets](https://github.com/changesets/changesets): run `pnpm changeset` in a PR that changes behaviour. Pushing a tag `vX.Y.Z` triggers [`release.yml`](../.github/workflows/release.yml), which publishes `ghcr.io/alexandre-leites/hac-manager` with version tags, `latest` and build provenance.
