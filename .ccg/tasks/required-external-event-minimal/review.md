# Design and implementation review

## Scope

The review covers the temporary Harness core seam for plugin-owned `requiredExternal` Session events. It does not approve Roundtable integration or an upstream submission.

## Independent review

The guarded dual review `c9cc08dd-e4f2-4272-80be-9208d04e606f` compared `3fc23f4a67` with `origin/master`. Both Codex and Claude completed and requested changes.

| Finding | Disposition |
| --- | --- |
| Registration accepted non-string namespaces. | Fixed: `assertNamespace()` checks `typeof namespace === 'string'`; focused runtime-input coverage added. |
| A validator could return a rejected Promise unnoticed. | Fixed: both write and reader paths reject thenables synchronously and consume an accidental rejection; focused coverage added. |
| Exact identity, duplicate ownership, idempotent disposal, and re-registration lacked coverage. | Fixed: core and JSONL focused cases now cover namespace/version/type mismatch, ownership release, and cache reactivation. |
| `Session.create()` and direct `Session.fromRestore()` could forge an external marker. | Fixed: both refuse the marker. Only `SessionStore.prepare({ seedSource: 'persistence' })` carries the active reader snapshot and revalidates namespace/version/type/payload before construction. |
| JSONL requires a SessionStore visible from its mounting context. | Documented: absence is intentionally fail-closed. |
| External-branch `continue` bypasses later `adoptSessionEvent()`. | Refuted: the canonical adoption loop is after the classification loop, so every record reaches it. `adoptSessionEvent()` only freezes known message payloads; full event freezing occurs when the store-owned restoration path constructs `Session`, as in the pre-existing design. |

## Focused evidence

- `pnpm exec tsc -b packages/core/session/tsconfig.json packages/session/session-persistence/tsconfig.json packages/session/session-persistence-jsonl/tsconfig.json --pretty false`
- `pnpm exec vitest run packages/core/session/tests/required-external.spec.ts packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts -t 'required external|validateStoredEvents'`
- `pnpm run gen-cordis-api`
- `pnpm run gen-persistence-catalog`
- `pnpm run verify-type-equiv`
- `pnpm run verify-cordis-api`
- `pnpm run verify-persistence-catalog`
- `pnpm run verify-agent-note-format`
- `pnpm run verify-translation-pairing --write docs/subsystems/session.md packages/core/session/README.md packages/session/session-persistence/README.md .agents/notes/implemented/architecture/2026-09-03-required-external-session-events.md`

The final scoped dual review remains pending after the fixes are committed. Repository-wide test, type, and documentation gates are deliberately deferred to merge or release because this change has narrow package ownership.
