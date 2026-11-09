---
'@hacm/core': minor
'server': minor
---

Add safe LXC configuration update plans: diff CPU, memory, swap, tags, features, protection, NICs and rootfs size against the live `pct config`, refuse disk shrinks, surface `[PENDING]` keys, require typed confirmation for removed NICs and disabled protection, and schedule a controlled restart when the guest is running.
