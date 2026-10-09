# `bug-report-widget` — the frontend

Self-injecting vanilla-JS module. One `<script>` tag, you're done.

## Install

### Copy-paste (any stack)

```bash
curl -O https://raw.githubusercontent.com/kmoy007/bug-report-widget/main/packages/widget/src/bug-report.js
curl -O https://raw.githubusercontent.com/kmoy007/bug-report-widget/main/packages/widget/src/html2canvas.min.js
```

Drop both into your `static/` (or `public/`) directory and reference them:

```html
<script src="/static/html2canvas.min.js" defer></script>
<script src="/static/bug-report.js" defer></script>
```

### npm (Node consumers)

```bash
npm install github:kmoy007/bug-report-widget#main
```

Then either bundle `bug-report-widget/src/bug-report.js` with your usual tool, or copy the two files to your public dir at build time.

## Configure

Set `window.BugReportConfig` **before** the script loads if you want to override defaults:

```html
<script>
  window.BugReportConfig = {
    endpoint: "/api/bugs",
    idPrefix: "bug-report",
    buildSha: window.MY_APP_BUILD_SHA || "",  // or () => string
    position: { bottom: 20, right: 20 },  // before the user drags it; { top: 80, left: 12 } works too
    buttonSize: 52,                         // px diameter
    title: "Report a bug",                  // modal heading
    theme: {
      accent: "#007AFF",
      buttonBg: "#ffffff",
      // … see DEFAULTS in src/bug-report.js for the full list
    },
  };
</script>
<script src="/static/html2canvas.min.js" defer></script>
<script src="/static/bug-report.js" defer></script>
```

The button is draggable; where the user leaves it is remembered in `localStorage`
(`storageKey`, per origin and per browser) and clamped back inside the viewport on
load and on every resize, so it can never be restored off-screen.

### Options added in 1.6.0 (all optional)

| Option | Default | What it does |
|---|---|---|
| `submitTimeoutMs` | `30000` | The POST is aborted and the dialog gives the Submit button back after this long. |
| `slowNoticeMs` | `8000` | After this long the status line says "Still sending…". |
| `idempotentSubmit` | `false` | Send `clientKey` (a UUID per open dialog, the same on every retry). **Only turn this on if your server dedupes on it** (the reference backends ignore it) — it decides whether the timeout message may say "it won't be filed twice". |
| `onClientEvent` | `null` | `(kind, detail) => void`, for apps that log client-side trouble. `"screenshot-failure"` (`detail.reason`, `.message`, `.ms`, `.lateMs`, `.width/.height`, `.path`, `.version`) and `"submit-timeout"` (`.elapsedMs`, `.payloadBytes`, `.idempotent`, `.message`, `.path`, `.version`). Exceptions and rejected promises from it are swallowed. leap-timesheet POSTs these to `/api/client-events`. |
| `html2canvasUrl` | `""` | If `window.html2canvas` is absent when a screenshot is needed, inject this script on the first click and wait for it (inside `captureTimeoutMs`). Keeps ~200 KB off pages where nobody reports. Empty = never inject. |
| `captureLateWatchMs` | `30000` | After a capture times out, how long to keep watching for it to finish, so the event can say how long it really took. |
| `reachOverDialogs` | `true` | See below. `false` opts out. |

**Submit never freezes.** While the POST is in flight a `role="status"` line says what is
happening ("Sending… uploading a 1.2 MB screenshot", then "Still sending…"). If nothing
answers within `submitTimeoutMs` the request is aborted, the button comes back, the text is
kept, and the dialog says the report may already be filed. With `idempotentSubmit` it adds
that submitting again will not file it twice; without, it says submitting again could.
(Why: leap-timesheet `bug-20260911-222709` — the server stored the report and answered 201 in
296 ms, the browser never acted on it, and the reporter stared at "Submitting…" for a report
that had been filed.) Escape closes the dialog (not while the screenshot viewer is open — that
Escape closes the viewer), and the dialog has `role="dialog"`, `aria-modal`.

**Why there is no screenshot.** `captureScreenshotDetailed(deps, cfg)` resolves
`{dataUrl, reason, detail, ms, width, height, late}`; `reason` is `null` on success, else one
of `no-library`, `timeout`, `render-error`, `blank`, `encode-error`, `too-large`, `tainted`
(the page holds cross-origin content the browser will not let us read). The dialog says
"Screenshot unavailable (why) — you can still submit text.", the POST carries `screenshotError`,
and `onClientEvent` is told. `captureScreenshot` still returns `dataUrl | null`.

**Reachable over a modal `<dialog>`.** `dialog.showModal()` puts the dialog in the top layer
and makes the rest of the page inert, so a 🐛 button on `<body>` cannot be clicked however
high its z-index. The widget watches for an open modal dialog and moves its button, report
form, viewer and toast into the topmost one (and back to `<body>` when it closes; a dialog
removed from the page with them inside gives them back first). They are `position: fixed`, so
they stay where they are. Non-modal dialogs are ignored. If your app already does this itself it
is harmless, and `reachOverDialogs: false` turns the built-in off.

**DOM ids.** `idPrefix` names the button (`<prefix>-button`), the report form
(`<prefix>-modal` and its parts) and the toast. The screenshot viewer's id is **always**
`bug-report-viewer` (its buttons `bug-report-viewer-done` etc.), whatever the prefix: apps'
own tests select it, so it is not derived from `idPrefix`.

## What ships

| Symbol | Type | Purpose |
|---|---|---|
| `window.BugReportWidget.init()` | function | Mounts the widget. Called automatically unless `window.__bugReportSkipAutoInit` is set. |
| `window.BugReportWidget.createController(opts)` | factory | Headless controller; pass `{document, window, fetch, html2canvas, config}`. Useful for tests. |
| `window.BugReportWidget.buildPostBody(opts)` | pure fn | Returns the request body sent to `/api/bugs`. Wire-format-stable. |
| `window.BugReportWidget.isBlankCanvas(canvas)` | pure fn | Safari fallback signal — true if the canvas has no real pixels. |
| `window.BugReportWidget.captureScreenshot(deps, cfg)` | async | Returns a data URL or `null` (fail/timeout/blank). |
| `window.BugReportWidget.captureScreenshotDetailed(deps, cfg)` | async | `{dataUrl, reason, …}` — says why there is no image. |
| `window.BugReportWidget.describeCaptureFailure(result)` | pure fn | The one-line, human-readable reason. |
| `window.BugReportWidget.openViewer(src, {annotate, onDone})` | fn | The zoom/markup viewer, standalone. `annotate: false` is view-only. |

## Zoom and mark up

Clicking the screenshot preview in the modal opens a viewer: zoom (wheel, `+`/`−`, Fit,
100%), pan (✋ Move), and ✏️ pen / ▭ box marks in red, with undo and clear. **Done** replaces
the capture with the marked-up image, which is what gets POSTed. Set
`BugReportConfig.markup = false` to turn it off.

`BugReportWidget.openViewer(src, {annotate: false})` opens the same viewer view-only, for a
triage screen that wants to zoom a filed screenshot.

On a touch screen, with ✋ Move one finger pans and two fingers pinch-zoom; with ✏️ Pen or
▭ Box a second finger is ignored, so a resting palm cannot spoil a mark. Marks are drawn on
a transparent canvas above the image (the image is never repainted as you draw) and are
composited into the file once, on Done. The toolbar keeps clear of a notch.

## A more faithful capture (optional)

html2canvas re-implements CSS layout, and on some pages that comes out wrong. Two extra files
put the browser's own renderer ([html-to-image](https://github.com/bubkoo/html-to-image), MIT)
in front of it, with html2canvas as the fallback:

```html
<script src="/static/html2canvas.min.js" defer></script>
<script src="/static/html-to-image.js" defer></script>
<script src="/static/capture-engine.js" defer></script>
<script src="/static/bug-report.js" defer></script>
```

Its cost is per DOM node, so a very large page wants `captureTimeoutMs: 20000` in
`BugReportConfig`. It does not draw `<video>` frames or iframe content (nor does html2canvas).

## Opting elements out of capture

Mark any DOM element with `data-bug-report-exclude` and html2canvas will skip it:

```html
<input type="password" data-bug-report-exclude="">
<div class="sensitive-widget" data-bug-report-exclude=""> … </div>
```

The widget's own button and modal are already excluded internally — you don't need to mark those.

## What gets POSTed

`POST /api/bugs` with `Content-Type: application/json`:

```json
{
  "title": "first line of details, ≤100 chars",
  "details": "...",
  "screenshot": "data:image/png;base64,...",
  "metaUrl": "...",
  "metaUserAgent": "...",
  "metaBuildSha": "abc1234",
  "tags": ["bug"],
  "addedBy": "web"
}
```

Two further fields are optional and only present when they apply: `screenshotError` (a string,
only when there is no screenshot) and `clientKey` (only with `idempotentSubmit`). A server
that does not know them ignores them.

The full request/response contract lives in [`../spec/openapi.yaml`](../spec/openapi.yaml). The Python and Node backend libs implement it; the cross-stack e2e suite in `../../e2e` exercises every reference impl with the same scenarios.

## Tests

```bash
cd packages/widget
npm test
```

Pure helpers (`buildPostBody`, `isBlankCanvas`, `pinchView`, …) and the controller and viewer, driven through a small fake DOM (`tests/fake-dom.js`, no jsdom), are tested in Node with the built-in test runner. Nothing here runs in a real browser: real touch, top-layer inertness and rendering are proved by each consuming app's own Playwright suite.
