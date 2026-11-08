---
status: accepted
date: 2026-11-08
---

# 0001. Node 22 and a TypeScript workspace

## Context and problem statement

HAC Manager shares configuration types between an API, web UI and CLI, needs native SQLite and SSH libraries, and must preserve YAML syntax. FEATURES.md D-02, D-03 and D-72 fix these requirements; issue #1 creates the foundation.

## Considered options

- Node with strict TypeScript and pnpm workspaces.
- Bun, separate language stacks, or independently versioned repositories.

## Decision outcome

Use Node 22 LTS, Corepack-pinned pnpm, strict TypeScript ESM and project references. Core owns pure schemas and logic; server, web and CLI depend on core. Choose Fastify with fastify-type-provider-zod, zod boundary validation, Drizzle with better-sqlite3, eemeli/yaml, ssh2 and native fetch. The SPA uses React, Vite, Tailwind, shadcn/ui and CodeMirror 6. Vitest, ESLint flat config and Prettier provide common checks. Dependencies are pinned and audited.

## Consequences

Shared schemas reduce drift across boundaries and native Node modules have a predictable runtime. Four packages need coordinated builds. Core must remain free of dependencies on the other packages and expose I/O only through injected interfaces. Runtime upgrades require compatibility testing, especially SQLite native bindings.

## Validation

A fresh clone must install and pass formatting, lint, strict type checks, package tests with coverage, security audit and production builds on Node 22. CI verifies the same runtime and commands.
