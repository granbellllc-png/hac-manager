---
'@hacm/core': minor
---

Add Tier-2 host backup management (D-57). `host.yaml` accepts an optional `backup` section. `renderHostBackupFiles` renders a sorted `/etc/vzdump.conf`, a restic backup script and a `/etc/cron.d` fragment; resolved secrets are refused and credentials are referenced through root-only file paths. `planHostBackup` reports content and mode drift, and `createHostBackupSteps` applies each managed file atomically (temporary sibling, `chmod`, `mv`) and idempotently. `readHostBackupStatus` reports last run and last success from the restic status file and the five most recent `vzdump` tasks.
