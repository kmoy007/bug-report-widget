# `bug-report-node` — Node backend

Express router implementing the [bug-report API spec](../spec/openapi.yaml). Pluggable storage; same shape as the Python backend so contract tests pin the wire format on both sides.

## Install

```bash
npm install github:kmoy007/bug-report-widget#main
# (uses the package at packages/backend-node via its package.json entry)
```

## Use — plain Express

```js
import express from "express";
import { createBugsRouter, FilesystemStore } from "bug-report-node";

const app = express();
app.use("/api/bugs", createBugsRouter({
  store: new FilesystemStore("/var/lib/bugs"),
  isAdmin: (req) => req.header("x-admin") === "yes",   // your auth
  defaultActorEmail: "ops@example.com",
  buildSha: () => process.env.BUILD_SHA || "",
}));
```

## Use — Azure Functions (leap-style)

The Functions runtime doesn't take an Express app directly, but you can adapt:

```js
// api/bugs/index.js
import { createBugsRouter, FilesystemStore } from "bug-report-node";
import { createServer } from "node:http";

const router = createBugsRouter({ store: yourAzureTablesStore, isAdmin });
const handler = createServer((req, res) => router(req, res, () => res.status(404).end()));

export default async function (context, req) {
  // ...delegate to handler, translate context.res, etc.
}
```

In practice the leap-timesheet migration plan is to lift `createBugsRouter` and wire it through a small Azure Functions shim that maps `context.req` / `context.res`. The existing `api/bugs/store.js` (Azure Tables + Blob) becomes an `AzureTablesStore` implementation of the `Store` protocol and lands here in a follow-up commit.

## Routes

| Method | Path                  | Auth-gated  |
|--------|-----------------------|-------------|
| POST   | /                     | open        |
| GET    | /                     | `isAdmin`   |
| GET    | /:id                  | open        |
| PATCH  | /:id                  | `isAdmin`   |
| GET    | /:id/screenshot       | open        |

## Stores

| Class | Purpose |
|---|---|
| `InMemoryStore` | Tests, dev. Map-backed; lost on process exit. |
| `FilesystemStore(root)` | Single-host production. One JSON per bug + audit JSONL + PNG. |

Implement the `Store` shape (`putBug`, `getBug`, `listBugs`, `updateStatus`, `appendAudit`, `listAudit`, `getScreenshot`) for any other backend. See [`src/store.js`](src/store.js).

## Tests

```bash
cd packages/backend-node
npm install
npm test
```

31 tests: 15 contract tests run twice (once per built-in store) + a sanity check. Adding a `Store` impl means appending to the `STORES` array and you get the contract coverage for free.

## Invariants enforced

Identical to the Python side — see the same list at [`../backend-python/README.md`](../backend-python/README.md#invariants-enforced). If a behavior differs between the two backends, that's a spec bug or a contract-test gap; the cross-stack suite in [`../../e2e`](../../e2e) hunts these.
