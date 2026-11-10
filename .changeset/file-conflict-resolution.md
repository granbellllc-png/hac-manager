---
'@hacm/core': minor
---

Resolve file mapping conflicts with `overwrite`, `skip`, `fetch` and `prompt` policies, detect remote edits against the last synced hash, fetch remote files back into the data dir through the write guard with a journaled step, and refuse fetching rendered `.env` files.
