# Changelog

All notable changes to this monorepo.

## v1.0.1 — 2026-05-17

- **No code changes.** Adds this CHANGELOG. Used as the first Dependabot smoke-test target — pushing v1.0.1 verifies that `claude-tmux-dashboard`'s Dependabot config opens a PR bumping the git-tag pin in its `requirements.txt`.

## v1.0.0 — 2026-05-17

Initial release.

**Packages:**
- `packages/widget` — self-injecting JS widget + vendored html2canvas. 17 unit tests.
- `packages/spec` — OpenAPI 3.1 + TS + Python types. The contract.
- `packages/backend-python` (`bug-report-py`) — Flask blueprint, `Store` Protocol, `InMemoryStore`, `FilesystemStore`. 42 tests parametrized across both reference stores.
- `packages/backend-node` (`bug-report-node`) — Express router, `Store` interface, `InMemoryStore`, `FilesystemStore`. 31 tests.
- `packages/backend-node/azure-tables` (`bug-report-node/azure-tables`) — `AzureTablesStore`, ported from leap-timesheet. Optional peer deps on `@azure/data-tables` + `@azure/storage-blob`. 12 unit tests.
- `packages/cli` (`bug-report-cli`) — Python CLI. 7 tests.
- `e2e/` — cross-stack contract suite. 32 tests running the same scenarios against both backends.

**Consumers:**
- `claude-tmux-dashboard` consumes `bug-report-py` + `bug-report-cli` via the git-tag pin documented in [README.md](README.md).

**Design pattern:** see [bug-report-pattern.md](https://github.com/kmoy007/design-patterns/blob/main/bug-report-pattern.md) for the full rationale and the variation observed across the four implementations in Ken's stack.
