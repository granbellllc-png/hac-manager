---
'@hacm/core': minor
---

Add one-click guest restore (D-56). `listGuestBackups` lists `vzdump` archives per guest from `pvesm list`, and `planGuestRestore` builds `pct restore` / `qmrestore` commands with typed `RESTORE <vmid>` confirmation. Restoring over an existing guest stops and destroys it only when overwrite and unprotect are explicit. Plans warn that the archive contains the rootfs only and that `mp0` host data must be restored separately; matching host data can be restored with `rsync`, a ZFS/BTRFS snapshot or restic, displacing the current copy to a timestamped path first. After the restore the guest is started, its managed identity is verified and LXC host data gets a storage invariant check.
