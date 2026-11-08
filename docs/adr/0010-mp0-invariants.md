---
status: accepted
date: 2026-11-08
---

# 0010. Check mp0 using mount namespaces across storage types

## Context and problem statement

LXC bind mounts may shadow installed files, fail to mount or leave daemons in stale namespaces. Raw ext4 debugfs inspection assumes LVM-thin and excludes ZFS, btrfs and directory storage. FEATURES.md D-42 through D-47 replace that historical approach.

## Considered options

- Inspect raw ext4 blocks with debugfs.
- Trust pct config alone.
- Inspect the rootfs and effective mounts through mount namespaces.

## Decision outcome

Enter the CT mount namespace with nsenter and create a non-recursive bind mount of / to inspect the underlying rootfs /opt without recursively copying mp0. Check findmnt in the guest and daemon /proc/<pid>/mountinfo. Fail or pause on shadowed files, split-brain, incorrect mounts or pending config.

Never hot-apply mp0: stop, attach, start and verify no [PENDING] section. Prepare ownership from idmap with minimal permissions; world-writable permissions are explicit opt-in. Migration is journaled, backed up and non-destructive: rsync, UID/GID shifting, rename the old /opt to a timestamped displaced path, attach and verify. Later deletion is a separate explicit operation.

## Consequences

Checks work across storage backends and catch stale daemon namespaces. They require SSH and careful cleanup of temporary mounts. Split-brain needs a persisted user decision and backup of the displaced side. vzdump does not protect bind-mount data.

## Validation

Recorded fixtures cover LVM, ZFS, btrfs and directory storage, missing mounts, pending config and divergent rootfs/host files. Dry-run must issue no mutating calls.
