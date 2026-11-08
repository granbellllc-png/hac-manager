# Proxmox fixtures

Fake, hand-written outputs shaped like real Proxmox commands. They contain
only fake data: documentation IPs (192.0.2.0/24), made-up MACs and keys.

| File                                | Source command                          |
| ----------------------------------- | --------------------------------------- |
| `lxc-112-unprivileged.conf`         | `pct config 112`                        |
| `lxc-113-privileged-multi-nic.conf` | `pct config 113`                        |
| `lxc-114-mp0.conf`                  | `pct config 114` (with `[PENDING]`)     |
| `vm-212-cloudinit-efi.conf`         | `qm config 212`                         |
| `pvesh-nodes.json`                  | `pvesh get /nodes --output-format json` |
| `etc-pve-storage.cfg`               | `cat /etc/pve/storage.cfg`              |

## Adding a fixture

1. Capture the output with `RecordingTransport`, passing a `Sanitizer`
   that removes secrets, real hostnames, IPs, MACs and keys. Review the
   result by hand; never commit unsanitised output (AGENTS.md rule 7).
2. Save it here, named after the command and guest (`<kind>-<id>-<trait>.<ext>`).
3. Add a row to the table above.
4. Load it in a test with `readFileSync` and script it on a `FakeTransport`:

   ```ts
   const transport = new FakeTransport().onExec('pct config 112', {
     stdout: readFixture('lxc-112-unprivileged.conf'),
   });
   ```
