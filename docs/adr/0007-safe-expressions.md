---
status: accepted
date: 2026-11-08
---

# 0007. Evaluate a bounded expression language

## Context and problem statement

YAML values need deterministic host/guest-specific expressions, but configuration must never become unrestricted code execution. FEATURES.md D-07 and D-08 supersede Python-style f-strings.

## Considered options

- Execute Python or JavaScript templates.
- Use eval, Function or a Node vm context.
- Interpret a restricted expression language with explicit helpers.

## Decision outcome

Use a sandboxed evaluator with no process, filesystem or network access. Context is passed explicitly (host, guest, vmid and network fields). Only registered built-ins are callable. Enforce execution, nesting and output-size limits and detect dependency cycles. No eval, Function, vm shortcut or subprocess language evaluator is permitted.

The exact evaluator (CEL-style, JSONata-style or custom) remains an M1 decision in issue #12 and needs a follow-up ADR. Helpers include mac, pad, hex and IP/CIDR operations. The human-readable MAC scheme must reject overflow (VMID at least 200, host index above 99, or network index at least 10) rather than emitting malformed bytes.

## Consequences

Expressions are portable, deterministic and testable but less powerful than scripts. User-facing errors must explain unsupported syntax and range failures. Raw tagged CST is kept for writeback; evaluated results never replace computed fields automatically.

## Validation

Test hostile property access and globals, oversized expressions, cycles, helper ranges and the expected A2:B1:C1:01:E0:12 MAC. Expression evaluation must not perform I/O.
