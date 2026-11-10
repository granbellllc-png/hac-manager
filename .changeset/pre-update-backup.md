---
'@hacm/core': minor
---

Add the pre-update backup plan and journaled steps (D-54, D-55). `planPreUpdateBackup` builds a `vzdump --mode snapshot --compress zstd` command with a `VMID_YYYY-MM-DD_HH-MM-SS_AppName` note, honours `backup_skip` and `backup_storage`, and protects bind-mounted host data with a ZFS/BTRFS snapshot, restic or rsync copy. The plan lists covered and uncovered paths, verifies the archive with `pvesm` when a storage is configured, and any failing backup step aborts the update before later steps run.
