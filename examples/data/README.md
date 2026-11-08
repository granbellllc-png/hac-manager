# Fake infrastructure example

This is a sample **data dir**, not application state. All hosts, credentials and addresses are fake; `192.0.2.0/24` is the documentation-only TEST-NET-1 range. Do not connect to these examples.

Copy this folder outside the app checkout to start an infra repo. `host.yaml` describes one standalone Proxmox host. `112-example-lxc` and `212-example-vm` show both guest types, inheritance, tags, file mappings and the three task tiers. Every file here is validated against the zod schemas in `packages/core` by the test suite (see `docs/reference/config.md`); the CLI validator arrives later in M1.

Copy `secrets.yaml.example` to the ignored `secrets.yaml` only in your own data dir. Replace placeholder references with your untracked credentials. Example public keys are deliberately invalid. Do not commit plaintext secrets. Install external secret CLIs separately if using `!cmd`.
