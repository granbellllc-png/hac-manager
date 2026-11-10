---
status: accepted
date: 2026-11-10
---

# 0016. Use dedicated SSH PTYs and WebSockets for interactive consoles

## Context and problem statement

Ordinary management commands use bounded SSH exec channels and durable SSE
logs. An interactive terminal instead requires bidirectional keystrokes,
resizing and an attached PTY. Persisting its transcript would risk capturing
credentials and other secret output.

## Considered options

- Parse and reuse an interactive shell for all management operations.
- Poll command output over REST.
- Keep management exec channels unchanged and add a distinct interactive PTY
  capability bridged through an authenticated WebSocket.

## Decision outcome

The SSH connection exposes a separately bounded PTY channel. A host console
opens a shell; an LXC console runs `pct enter <vmid>` after confirming the
guest exists. Management commands continue to use non-interactive exec
channels.

The browser uses xterm.js over `/api/console`. Fastify authenticates the
upgrade with the normal session cookie, rejects cross-origin upgrades, checks
the user's role and host grant, and denies viewers. The server audits session
start and stop with duration and byte counts, but never stores terminal input
or output. Idle sessions close after a configurable timeout. Optional
recording is bounded browser memory with an explicit local download.

## Consequences

- Console traffic is ephemeral and does not become a secret-bearing server
  log path.
- Reverse proxies must support WebSocket upgrades on the same origin.
- Operators receive root-equivalent interactive access only on granted hosts.
- VM consoles require a later guest-agent/serial-console design.

## Validation

Tests cover host and LXC PTYs, role and host authorization, origin validation,
idle timeout, start/stop audits, transcript non-persistence and responsive
desktop/mobile rendering.

## Links

- GitHub issue #72
- FEATURES.md D-23, D-33, D-67 and D-73
- ADR 0008
- ADR 0012
