# Contributing

Read [AGENTS.md](AGENTS.md), [FEATURES.md](docs/FEATURES.md), the issue and its dependencies before changing behavior. Work in milestone order. Use fake transports and fixtures; do not connect to real Proxmox hosts unless the owner explicitly authorizes it.

## Development

Use Node 22 from `.nvmrc` and the Corepack-pinned pnpm version. Install with `corepack enable && pnpm install`. Each package has Vitest tests beside its source (`*.test.ts`). Core has no dependency on another workspace package and does no direct I/O.

Before committing:

```sh
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm audit
pnpm build
```

Coverage requires at least 90% of statements, branches, functions and lines **per source file**. Do not lower thresholds to obtain a pass. Unit and integration tests run together; verify UI changes at mobile and desktop widths in a browser. The pre-commit hook runs ESLint and Prettier on staged files; it supplements the full checks above.

## CI and branch protection

Every pull request and push to main runs the Node 22 quality pipeline: locked install, formatting, lint, type checks, full unit/integration coverage, dependency audit and production build. Every command must pass. Actions are pinned by SHA with read-only permissions; coverage artifacts are retained for seven days. Dependabot proposes weekly package and action updates.

When the repository plan supports branch protection, protect main with required pull-request review, the `Quality` status check, resolved conversations, no force pushes and no deletion. Include administrators if appropriate. GitHub currently reports that this private repository must upgrade its plan or become public to use protection rules; this project does not change visibility or billing automatically.

The CodeQL workflow is configured for JavaScript/TypeScript with security-extended queries. Public repositories run it automatically. For private repositories, first enable GitHub Code Security/code scanning in repository settings, then set the repository Actions variable `HACM_CODEQL_ENABLED` to `true`. The current repository does not have code scanning enabled (GitHub API returns 403); until enabled, the workflow emits an explicit notice and summary and skips analysis. A successful eligibility job does **not** mean CodeQL analysis passed. Require the `CodeQL analysis` check only after scanning is enabled. Do not set the variable to bypass licensing or availability requirements.

GitHub billing, plan changes and repository visibility remain owner decisions. Dependency audits still run for all repositories.

## Changes and review

Tooling dependencies are pinned for repeatable installs. The `minimatch` overrides keep ESLint and typescript-eslint on 11.0.5 to fix GHSA-g3hv-75wg-m249 while upstream dependency ranges still select vulnerable versions. Remove these overrides when upstream versions select a patched release; run lint and the full audit after any dependency update.

Use `codex/` branches for agent-created branches, Conventional Commits, and one issue per commit/PR where practical. Reference the issue (`Closes #N`). Preserve unrelated changes. Explain new dependencies and pin their versions. Update FEATURES.md for business changes and add an ADR for technical decisions. YAML writes must preserve CST, tags and comments and use the external-edit write guard.

Every mutation requires a reviewable plan, dry-run support and the documented identity/data-safety checks. Never log or commit secrets. Auth and admin-only command editing are server-side requirements.

Report security problems privately as described in [SECURITY.md](SECURITY.md). By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
