# `bug-report-spec`

The wire-level contract every bug-report backend honors. Single source of truth.

- `openapi.yaml` — full API definition. The Python and Node backend libs implement this; the cross-stack e2e suite in `../../e2e` runs the same scenarios against both.
- `types.ts` — TypeScript types for the JSON DTOs (handy if your Node backend or frontend wants type-checked clients).
- `types.py` — Python `TypedDict`s for the same DTOs.

If you add a field to the wire format, change it here first. The lint rule in CI fails the build if the backends drift from the spec.

## Audit-flow invariant

The spec is intentionally quiet about *who* can call each route — that's the consuming app's call. But it pins down one behavior every backend MUST get right: **every successful `PATCH` MUST append an audit row**, and a no-op patch (same → same) MUST NOT. The contract test in `../../e2e/contract.spec.ts` enforces both.
