---
status: accepted
date: 2026-11-08
---

# 0012. Use SSH exec channels and send scripts on stdin

## Context and problem statement

Persistent connections should avoid SSH setup overhead without parsing prompts, terminal echoes or nested shell quoting. FEATURES.md D-22 and D-23 and the Transport contract distinguish command execution from interactive consoles.

## Considered options

- Open a new SSH session per operation.
- Reuse and parse an interactive shell.
- Multiplex bounded exec channels on a persistent ssh2 connection.

## Decision outcome

Maintain one long-lived SSH connection per host with keepalive, reconnect/backoff and bounded channel concurrency respecting MaxSessions. Run commands through exec channels with explicit arguments, streams, timeout and cancellation. Send scripts on stdin; never construct nested bash -c strings or parse an interactive shell.

Core depends on a Transport interface, not ssh2. FakeTransport supplies deterministic results; RecordingTransport can capture explicitly authorized, sanitized output for fixtures. Proxmox REST handles reads, metrics, power and tasks when suitable; the router chooses capabilities and fails clearly when SSH is required but missing.

## Consequences

Execution has reliable exit status and stream separation. Lost channels and reconnects require explicit retry semantics; mutations must not be blindly retried. The later interactive web console and supervised pseudo-terminal script runner are distinct capabilities, not permission to use shell parsing for ordinary management.

## Validation

Test channel limits, cancellation, timeout, output streaming, connection loss and script stdin with fakes. Fixture recording must remove secrets and real host identities before files are committed.
