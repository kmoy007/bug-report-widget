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
    position: { bottom: 20, right: 20 },
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

## What ships

| Symbol | Type | Purpose |
|---|---|---|
| `window.BugReportWidget.init()` | function | Mounts the widget. Called automatically unless `window.__bugReportSkipAutoInit` is set. |
| `window.BugReportWidget.createController(opts)` | factory | Headless controller; pass `{document, window, fetch, html2canvas, config}`. Useful for tests. |
| `window.BugReportWidget.buildPostBody(opts)` | pure fn | Returns the request body sent to `/api/bugs`. Wire-format-stable. |
| `window.BugReportWidget.isBlankCanvas(canvas)` | pure fn | Safari fallback signal — true if the canvas has no real pixels. |
| `window.BugReportWidget.captureScreenshot(deps, cfg)` | async | Returns a data URL or `null` (fail/timeout/blank). |

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

The full request/response contract lives in [`../spec/openapi.yaml`](../spec/openapi.yaml). The Python and Node backend libs implement it; the cross-stack e2e suite in `../../e2e` exercises every reference impl with the same scenarios.

## Tests

```bash
cd packages/widget
npm test
```

Pure helpers (`buildPostBody`, `isBlankCanvas`) are tested in Node with the built-in test runner (no jsdom). The widget end-to-end is exercised against a live page in `../../e2e/contract.spec.ts`.
