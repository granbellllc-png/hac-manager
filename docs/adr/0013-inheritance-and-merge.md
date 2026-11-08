---
status: accepted
date: 2026-11-08
---

# 0013. Inheritance, merge semantics and provenance tracking

## Context and problem statement

Homelab configurations share common hypervisor-level defaults (`default-deployment.yaml`, `default-filemappings.yaml`) such as standard network gateways, bridges, SSH keys, or baseline resource allocations. Repeating these across every guest leads to duplication and configuration drift.

At the same time, bidirectional drift reconciliation, live state writeback, and the UI editor require knowing exactly where each evaluated configuration value originated: whether it was inherited from a host default or overridden by a guest file, which source file it came from, and which CST node represents it.

## Considered options

- Simple deep object merge for all structures (causes duplicate items in lists and invalid network configurations).
- Full list replacement everywhere (forces guests to duplicate default network interfaces just to set an IP or MAC).
- Predictable hybrid merge with identity-based network merging, default list replacement, opt-in list appending, explicit null deletion, and full provenance tracking.

## Decision outcome

We adopt a predictable, tag-aware merge engine with explicit provenance tracking:

1. **Object Mappings:**
   - Object maps are recursively deep-merged.
   - Guest override fields take precedence over default fields.

2. **Explicit Null Deletion:**
   - Setting a key to `null` in an override explicitly removes that key from the merged result. This allows guests to opt out of inherited default settings.

3. **List Merging Semantics:**
   - **Default: Replace.** All list fields (`disks`, `tags`, `identity_checks`, `update_commands`, `ssh.authorized_keys`, `mounts`, `mappings`) replace the inherited list in its entirety when specified in the guest override.
   - **Network Identity Merging:** The `network` array merges by item identity. Items are matched by `index` (e.g. `0`) or `name` (e.g. `eth0`). Matched items deep-merge their properties (with explicit `null` deleting inherited item properties). Unmatched default items are retained, unmatched guest items are appended, and an item with `_remove: true` excludes that interface. Passing an explicit empty list `network: []` or using `{ $replace: [...] }` replaces the network list completely.
   - **Opt-in List Modifiers:** Guests can opt into appending or prepending items to an inherited list using `{ $append: [...] }` or `{ $prepend: [...] }`.

4. **CST & Tag Awareness:**
   - Merge operates directly on CST documents and tag-aware structures without resolving custom tags (`!env`, `!secret`, `!cmd`, `!expr`, `!include`).
   - Tags are preserved as leaf values and resolved downstream in the guest context.

5. **Provenance Tracking:**
   - Every merged leaf path is registered in a `ProvenanceMap` tracking:
     - `layer`: `'default' | 'override'`
     - `file`: relative or absolute path to the source file
     - `sourcePath`: path of the node in the source document
     - `node`: underlying YAML CST Node (if CST was provided)
     - `isTag`: boolean indicating whether the value is a tagged expression/secret
     - `tag`: tag name (e.g. `'expr'`, `'secret'`)
   - Explicitly removed keys are tracked in `removedKeys` for audit and drift inspection.

## Consequences

- The writeback API (`applyPatch` in #15) can pinpoint whether an updated value belongs in the host defaults or the guest override file.
- Changes targeting tagged values (`!expr`, `!secret`) can be identified and rejected or flagged before attempting writeback.
- Merge behavior is deterministic and verifiable with property-based tests.
