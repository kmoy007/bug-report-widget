# Changelog

All notable changes to this monorepo.

## backend-python v2.0.0 · triage-ui v1.0.0 · spec — 2026-09-16

**Breaking for `backend-python`, deliberately.** `PATCH /bugs/{id}` used to
validate only that the new status was a member of the enum, so
`open → resolved` went through. It is now gated on the lifecycle contract
and answers **409** for a move the contract does not allow, and **400** for
a decline with no reason. A same-status PATCH is still the documented
no-op. Upgrading will turn some previously-accepted requests into refusals
— which is the point, but it is a behaviour change and gets a major.

- **`packages/spec/report-contract.json` — the lifecycle.** `openapi.yaml`
  pins the wire *format* and was always quiet about the lifecycle. That
  silence cost something: every consuming app decided for itself what
  `PATCH` may do, so the same request was a 409 in one app and a 200 in the
  next, neither wrong by its own lights, and a queue merged across both was
  incoherent. The contract settles the transitions a server must accept
  *exactly*, which of those a UI should offer, where a reason is required,
  the `kind` vocabulary, and which fields a list row carries versus a
  detail read. Same rule as the wire format: change it here first.
- **`packages/triage-ui` — the admin queue, packaged.** Four apps had
  hand-written this screen, three by porting the first one's HTML. They had
  drifted: one collapsed two kinds into one, one rendered a field the others
  didn't, one had no screen at all. Dependency-free, framework-free, themed
  entirely by CSS custom properties. `kind` is consumed from the server,
  never re-derived from tags — that re-derivation is the drift it exists to
  end.
- **`kind` on every payload the blueprint returns**, derived once from tags.

## v1.4.0 — 2026-09-15

- **A dragged button is restored inside the viewport.** The drag handler clamped the
  button to the window, but the position restored from `localStorage` at mount was
  applied exactly as stored. A button dragged towards the bottom-right of a large
  window therefore came back off-screen in a smaller one — another browser window, a
  laptop unplugged from its monitor, a phone — and the widget looked permanently
  missing. The only cure was deleting `bug-report-button-position-v2` by hand, in
  every browser separately (storage is per-origin *and* per-browser). That is how
  the fleet dashboard lost its button for its main reporter.

  The stored position is now clamped to the current viewport (4px margin, the same
  rule the drag handler always used, now one helper: `clampPos`) at mount **and on
  every `resize`**. Clamping is for display only and never rewrites storage, so a
  spot chosen on a big window comes back when the window does.
- **`title` config** — the modal heading, default `"Report a bug"`. Upstreamed from
  leap-daily-report, which had patched its vendored copy to say "Report a problem";
  a re-copy of v1.3.0 would have silently reverted it.
- `npm test` ran `node --test tests/`, which Node 22 treats as a module path and
  fails with `Cannot find module`; it now globs `tests/*.test.js`.
- 44 unit tests (+7: restore into a smaller window, restore unchanged when it fits,
  negative positions, shrink-then-grow on resize with no storage write, no stored
  position, unknown geometry, the title). Mutation-checked: restoring the unclamped
  position fails 3 of them.

## backends v1.1.0 — 2026-08-21

- **Screenshots are served with the media type they actually are.** Both reference
  backends hard-coded `image/png` on `GET /bugs/{id}/screenshot`. That was already
  a lie for anything that fell down the widget's v1.3.0 fallback ladder — and on an
  image-heavy page that ladder is the ordinary path, not the exotic one: a real
  deployment (a placement-image viewer, 39 photographic tiles) produces a
  viewport-cropped capture whose PNG still exceeds the 5 MB cap, so what it stores
  is a 1.4 MB JPEG, served as `image/png`. Consumers that send
  `X-Content-Type-Options: nosniff` — the right header for a service that serves
  user-uploaded bytes back — were relying on browsers being lenient about image
  types to render their own triage queue.

  The type is now sniffed from the stored bytes (`screenshot_content_type` /
  `screenshotContentType`, new in the model layer of each backend): PNG, JPEG, GIF
  and WebP are recognised. **Sniffed, not stored** — deliberately, because the bytes
  are the only thing every `Store` implementation is guaranteed to have kept, so
  existing screenshots in existing stores are labelled correctly too, with no
  migration and no schema change. Bytes in no recognised format keep `image/png`,
  which is what every server returned before this, so nothing that rendered stops
  rendering.

  The data: URL's declared type is *not* trusted: it is the client's claim about
  bytes the server is about to store, and a mislabelled upload must not become a
  mislabelled download.

- Spec: the `200` on `GET /bugs/{id}/screenshot` now enumerates the image types a
  server may return instead of promising PNG, and `types.ts` no longer describes the
  `screenshot` field as PNG.
- +14 backend unit tests (7 per stack: every recognised format, the RIFF-but-not-WebP
  case, truncated magic, empty, junk) and +2 cross-stack contract scenarios, so the
  two implementations are held to the same sniffing behaviour.

## v1.3.0 — 2026-08-17

- **Screenshot capture is cropped to the viewport.** `captureScreenshot` rendered the
  whole `doc.body`, so the canvas scaled with scroll height: a long list page produced
  a viewport-wide × full-scroll-height PNG that (a) blew past the reference backend's
  5 MB decoded cap — the POST 413'd and the report dead-ended with no way forward —
  and (b) previewed in the modal as an unreadable vertical sliver. Capture now crops
  to the visible viewport at the current scroll offset (what the user was looking at
  when they hit the button, which is the bug context anyway). Falls back to the old
  uncropped capture when viewport geometry is unavailable. Iframe compositing
  positions were re-based accordingly (frame rects are viewport-relative, so under
  the crop they map to the canvas directly instead of via `bodyRect`).
- **Size-capped serialisation with a fallback ladder.** New `maxScreenshotBytes`
  config (default 5 MB decoded, mirroring the reference backend cap — the server
  stays authoritative). Serialisation walks PNG → JPEG 0.85 → JPEG 0.6 →
  half-resolution JPEG 0.6 and returns the first rung under the cap; if none fit,
  the report is submitted without a screenshot instead of dead-ending in a 413.
  JPEG rungs flatten onto white first (browsers composite alpha onto black).
  New exported helpers: `dataUrlBytes`, `encodeCanvasUnderCap`.
- 37 unit tests (+12: byte accounting, every ladder rung, white-flatten, viewport
  crop options, scroll-offset crop, iframe paste position under crop, oversized
  capture degrading to JPEG).

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
