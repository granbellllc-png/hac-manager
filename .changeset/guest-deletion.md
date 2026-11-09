---
'@hacm/core': minor
'server': minor
---

Add safe guest deletion plans: typed confirmation (`DELETE <host>/<vmid>`), protection that blocks deletion until an explicit unprotect step, an optional `vzdump` backup first (warns that bind mounts are not backed up), purge options for LXC and VMs, journaled stop/destroy/verify steps, and audit metadata carrying the user-supplied reason. Deletion also removes the guest from the inline `host.yaml` orphan ignore list through the CST layer.
