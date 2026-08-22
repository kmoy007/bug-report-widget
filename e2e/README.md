# `e2e/` — cross-stack contract tests

The spec lives in [`packages/spec/openapi.yaml`](../packages/spec/openapi.yaml). The Python backend and Node backend both claim to implement it. These tests prove it — by running the **same scenarios** against **both backends** and asserting identical behavior.

If the two backends ever drift (one returns a different status code, one orders results differently, one writes audit rows the other doesn't), the test fails loudly with which scenario diverged.

## What runs

Each test runs twice — once against the Python backend, once against the Node backend. The fixture boots both as subprocesses on random ports and yields their base URLs.

```bash
cd e2e
pip install -r requirements.txt
pytest -v
```

## What's covered

- POST minimal → 201, returns valid id
- POST without details → 400
- POST oversized details → 413
- POST oversized screenshot → 413
- agent-self-report tag auto-added when `addedBy=agent`
- POST writes initial audit row (`fromStatus: null, toStatus: open, note: filed`)
- GET list newest-first
- GET filtered by status
- GET single returns audit array
- GET invalid id → 400; unknown valid id → 404
- PATCH transitions write audit; same-status PATCH is a no-op
- PATCH invalid status → 400
- POST with screenshot → can retrieve PNG bytes intact
- a JPEG screenshot comes back labelled `image/jpeg`, not `image/png`
- the served media type is sniffed from the stored bytes, not taken from the data: URL
- Screenshot 404 when missing

If a test passes against Python but fails against Node (or vice versa), that's exactly the kind of drift these tests exist to catch. Fix the loser, don't loosen the test.

## Why not Playwright

The widget is browser-agnostic and exercised in each consumer app's own Playwright suite (claude-tmux-dashboard, leap-timesheet). Here, the question is "do both backends honor the wire format?" — that's an HTTP-level question, not a browser one. Plain `requests` is faster and clearer.

When the widget needs cross-browser regression coverage, that lives in `packages/widget/tests/widget.spec.ts` (TODO).
