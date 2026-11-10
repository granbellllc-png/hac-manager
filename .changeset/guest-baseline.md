---
'@hacm/core': minor
---

Add guest baseline steps (D-52): detect Debian, Ubuntu or Alpine from `os-release` through the guest transport, apply the IPv6 sysctl policy derived from the network declarations, upgrade OS packages with apt or apk, and run the deployment's `update_commands` in order. Steps are journaled and refuse to build unless a backup completed and identity checks passed.
