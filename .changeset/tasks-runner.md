---
'@hacm/core': minor
---

Add ordered task files and a task runner. Task files are discovered by filename prefix, expand `!include` inside the data dir, and are validated by the strict task schema. `runTasks` resolves `when`/`env`/`timeout`/`retries`, delivers scripts on stdin (never nested `bash -c`), skips satisfied `creates` paths, retries failures, honours `ignore_errors`, triggers `onchange` tasks, redacts secret output and returns a per-task result model. Tier 1 files can target hosts by group or tag.
