# Changelog

All notable changes to this monorepo.

## v1.2.0 — 2026-07-27

- **Double-submit guard on the Submit button.** The click handler called `onSubmit`
  with no guard: the POST is async and nothing on screen changed on the first tap, so
  on a phone — small target, slow network — people tapped again. Real reports arrived
  2–3 times seconds apart (2026-07-01 ×3, 2026-07-23 ×2, 2026-07-27 ×2), roughly
  doubling the queue for mobile reporters and burying real signal under duplicates.
  The button now disables and reads "Submitting…" on the first tap.

  It re-enables on a *real* failure — validation, HTTP error, network error — so a
  failed report is still filable. Note the asymmetry that made this subtle:
  `onSubmit` calls `showError(null)` on the SUCCESS path to clear stale messages,
  immediately before the fetch, so only a truthy message may restore the button.
  Re-enabling on every `showError` call would undo the guard exactly when it matters.

## v1.1.0 — 2026-07-24

- **Screenshot: same-origin iframe content is now captured.** html2canvas renders an
  `<iframe>` as a blank rectangle, so any page whose main content is framed screenshotted
  as an empty white box — reported in the field as "the screenshot misses the content".
  `captureScreenshot` now re-renders each same-origin frame and composites it into the
  parent capture at the frame's position. Cross-origin frames are unreachable by design
  and still come out blank; a frame that fails to render no longer loses the whole
  screenshot, and `data-bug-report-exclude` is honoured on frames.
- **`buttonSize` config (default 52).** Diameter of the floating button in px, clamped to
  24–96; the glyph scales with it. Lets an app embedded inside another shell use a smaller
  button so it reads as chrome rather than page content. Existing consumers are unaffected.
- 21 unit tests (+4: compositing, cross-origin skip, failing-frame resilience, config).

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
