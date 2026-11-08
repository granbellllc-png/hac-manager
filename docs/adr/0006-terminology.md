---
status: accepted
date: 2026-11-08
---

# 0006. Use host, guest and resource consistently

## Context and problem statement

Proxmox already calls a hypervisor a node. The original specification used node for a guest, creating ambiguity. FEATURES.md D-01 defines canonical vocabulary.

## Considered options

- Retain node/server terminology from the historical spec.
- Adopt the Proxmox distinction with generic future-host support.

## Decision outcome

A host is a Proxmox server and later may be a Docker host. A guest is an LXC container or QEMU VM. A resource is either. Use hosts/ and host.yaml, guest.name in expression context, and host/guest terminology in code, schemas, APIs, UI and docs. Use VMID for Proxmox guest identifiers.

Data dir means the user's infra repository; state dir means runtime storage. Drift is a difference between evaluated YAML and live state. An orphan is a live guest without YAML.

## Consequences

Terminology scales to Docker and avoids hypervisor/guest confusion. Historical text remains historical and must be interpreted through FEATURES.md. Upstream Proxmox fields named node are preserved at transport boundaries, then translated into canonical terms.

## Validation

Review public APIs and UI copy for vocabulary consistency. Schemas distinguish LXC and VM guests without calling either a node.
