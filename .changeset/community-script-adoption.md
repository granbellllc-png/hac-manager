---
'@hacm/core': minor
---

Add journaled post-script adoption for community-script LXC containers: verify the script-created guest, stop it, migrate `/opt` (or the declared mp0 path) to host-backed storage without deleting the rootfs copy, refuse to attach mp0 over a non-empty rootfs, stamp the managed tag/UUID, start the guest, run identity checks and verify `[PENDING]` is empty and mp0 owns the planned directory. A failure leaves a resumable step journal.
