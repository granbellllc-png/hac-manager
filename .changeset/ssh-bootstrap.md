---
'@hacm/core': minor
---

Add idempotent guest SSH bootstrap steps (D-53). The steps probe the guest's SSH port, install and start `openssh-server` through the caller's LXC `pct exec` or VM guest-agent transport, synchronise the root password by comparing the `/etc/shadow` SHA-512 hash (reusing its salt and deriving a stable fallback salt from the host ID and VMID) and write `/root/.ssh/authorized_keys` exactly as declared. Running the bootstrap twice makes no changes.
