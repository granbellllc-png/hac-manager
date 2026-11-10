---
'@hacm/core': minor
---

Add the three-tier task cascade: Tier-1 tasks target hosts by `groups`/`tags` from `host.yaml`, Tier-2 tasks run on one host and Tier-3 tasks run inside the guest through a `pct exec` or QEMU guest-agent transport. Tier 3 is skipped until file sync, identity checks and invariants are verified, and tiers can resume from a chosen point. The configurable `abort`, `abort-tier` and `continue` failure policies stop whole cascades, only the failing tier, or nothing.
