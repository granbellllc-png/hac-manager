---
status: accepted
date: 2026-11-08
---

# 0014. Custom AST-based safe expression engine for `!expr`

## Context and problem statement

Configuration files require deterministic, context-aware scalar expressions (such as computing deterministic MAC addresses, deriving IP addresses from base subnets, or interpolating guest and host indices).

However, HAC Manager holds root-equivalent credentials on every managed host. As established in ADR 0007 and AGENTS.md Rule 2, arbitrary code evaluation (`eval`, `Function`, `vm` modules, template f-strings, or sub-processes) is strictly prohibited. The evaluator must run within strict bounded resources and have zero access to system I/O, globals, or JavaScript prototypes.

## Considered options

- **CEL (Common Expression Language):** Standardized, but existing JavaScript CEL runtimes are heavy, have varying specification compliance, and pull in large transitive dependency graphs.
- **JSONata:** Powerful for querying and JSON transformation, but overly complex for scalar homelab expressions and introduces unnecessary syntax overhead.
- **Custom AST-based Safe Evaluator:** A zero-dependency, recursive-descent parser and interpreter tailored specifically for safe configuration expressions.

## Decision outcome

We implement a custom AST-based expression engine in `@hacm/core`:

1. **Security & Isolation:**
   - Pure recursive-descent tokenization and AST parsing with no external parser generators.
   - Evaluates exclusively against an explicit `EvaluationContext` object.
   - Strict prototype protection: access to `constructor`, `__proto__`, `prototype`, or global objects is blocked and throws a `SecurityError`.
   - Execution bounded by step limits (maximum 1,000 AST operations), expression size limits (maximum 1,024 characters), and nesting depth limits (maximum 30 levels).
   - No looping constructs, variable assignments, or side-effecting operations.

2. **Context Provided:**
   - `host`: `{ id, index, name, tags }`
   - `vmid`: number (e.g. `112`)
   - `guest`: `{ name, type }`
   - `net`: `{ index, bridge, name }`
   - Custom caller-provided context fields.

3. **Standard Built-in Helpers:**
   - `mac(prefix, hostIndex, netIndex, vmid)`: Human-readable deterministic MAC scheme `A2:B1:C1:<host.index>:E<net.index>:<vmid-100>`. Fails loudly if `vmid < 100` or `vmid >= 200`, `hostIndex > 99`, or `netIndex >= 10`.
   - `pad(val, length, char?)`: Left-pads a number or string.
   - `hex(val, digits?)`: Formats an integer as uppercase hex with padding.
   - IP / CIDR utilities: `ip_add(cidr, offset)`, `ip_calc(cidr, hostNumber)`, `cidr_gateway(cidr)`, `cidr_netmask(cidr)`, `cidr_prefix(cidr)`.

## Consequences

- Expressions are completely safe, deterministic, and sandboxed with zero risk of code injection.
- Evaluation runs synchronously with no I/O or network access.
- Errors are explicit, user-friendly, and pinpoint exact range violations or syntax issues.
