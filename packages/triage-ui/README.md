# `bug-report-triage`

The admin queue for [`bug-report-widget`](../widget). The widget **files**
reports; this **reads** them — the screen someone works a queue through.

Backend-agnostic, like the widget: it speaks [`../spec`](../spec) and
nothing else. Dependency-free and framework-free, because the apps this
was extracted from are a stdlib-Python HTTP server, two Flask templates
and an Azure Functions app — a build step would exclude most of them.

## Why this exists

Four apps in one suite each hand-wrote this screen, three of them by
porting the first one's HTML with a comment saying *"so all three behave
identically."* They had already drifted in the ways copies do: one
collapsed two kinds into one, one rendered a field the others didn't, one
had no screen at all and its reports could only be read by listing a file
share. The store and the routes were shared from day one. The screen was
the half nobody packaged — which is the half a person actually looks at.

## Use

```html
<link rel="stylesheet" href="/static/triage.css">
<script src="/static/triage.js"></script>
<div id="triage"></div>
<script>
  BugReportTriage.mount({
    root: document.getElementById("triage"),
    endpoint: "/api/bugs",
  });
</script>
```

| Option | Default | What it does |
|---|---|---|
| `root` | — | Required. The element to render into. |
| `endpoint` | `/api/bugs` | Base path. Detail and screenshot hang off it. |
| `fetch` | global `fetch` | Inject one for tests or a base-path rewrite. |
| `onChange` | — | Called after a successful transition (refresh your badge). |
| `onError` | `alert` | Called with the error when a transition fails. |
| `forbiddenHint` | generic | What to show on 403. Say which allowlist and **which address** — every app here gates reading to one that fails closed, and the address to add is the one people *sign in as*. Three of them locked their queue to nobody by getting that wrong. |
| `prompt` | global `prompt` | Injected for tests. |

## Theming

Every colour is a CSS custom property with a neutral fallback, so a host
themes this by setting properties and never a selector — see
[`src/triage.css`](src/triage.css). Each status has a **soft surface** and
its own **text** colour, because tinting type with the same value as the
dot is how a palette ships unreadable labels.

## What it renders

Collapsed: title, status, kind, date, channel, 📷, and an `agent` chip for
a self-report. Expanded, fetched on first open (a list of thirty reports
should not pull thirty bodies): the description, the screenshot, the page,
the build SHA, the user agent, the transcript if the backend bundled one,
the transitions legal from here, and the full audit trail.

Two details that are load-bearing:

- **`kind` comes from the server.** It used to be re-derived from tags in
  each viewer — two derivations of one fact with nothing comparing them,
  and when a kind was retired the collapse had to be remembered in every
  copy. Renderer consumes; never derives.
- **Declining asks for a reason** before it sends, because the server
  refuses one without — so that refusal is never what the admin meets.
