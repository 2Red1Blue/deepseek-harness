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

## Second independent review

The guarded dual review `78670824-71db-4d9f-a605-99a8fa5f962c` compared `9573fd4257` with `origin/master`. Claude approved with one malformed-envelope hardening warning; Codex requested three lifecycle fixes.

| Finding | Disposition |
| --- | --- |
| A validator could dispose or replace its writer registration, then the append could still commit. | Fixed: `resolve()` confirms the same registration still owns the type after synchronous validation; a self-releasing-validator test proves no event commits. |
| A validator could mutate the detached payload after accepting it. | Fixed: the writer freezes the detached payload before validation and commits that same object; hostile-mutation coverage added. |
| A reader registration could change during JSONL I/O or validation. | Fixed: JSONL captures the vocabulary after I/O, validates through that snapshot, and refuses if it changes during validation before caching; deferred-I/O and self-releasing-reader coverage added. |
| A required external marker could carry `ignorable: false` or another malformed companion. | Fixed: any present `ignorable` companion is persistence corruption, matching seed restoration; focused coverage added. |
| Seed marker parse errors lost their cause. | Fixed: the seed error retains its underlying marker-validation cause. |
| The vocabulary could be mistaken for an access-control capability. | Documented: it is a durable vocabulary guard; code holding `ctx.sessions` can write an active registered type. |

## Third independent review

The guarded dual review `42089958-a924-4430-b1d9-725802b7935a` found one restoration race and two persistence hardening gaps. The fixes are in `7e386ec4ea` and `0d3a8dd6bd`.

| Finding | Disposition |
| --- | --- |
| A reader registration could change after its validator returned but before store-owned restoration completed. | Fixed: `SessionStore.prepare()` confirms the captured reader snapshot after restoration before exposing the session. |
| A read or seed validator could mutate an externally supplied payload. | Fixed: storage and restoration paths freeze the detached payload before validation. |
| Required-external classification did not enforce the fixed stored-event envelope before type handling. | Fixed: storage validates the fixed envelope for every record before known, ignorable, or required-external classification. |
| A validator-triggered nested append could bypass ordering expectations. | Fixed: the active session entry holds an append guard through cloning, validation, ownership confirmation, and commit. |

## Final scoped dual review

The guarded delta review `99b25a5d-8881-48c0-99e9-181dff52103e` compared `0d3a8dd6bd` with `e045261b18`. Codex approved without findings and Claude approved with observations only.

| Observation | Disposition |
| --- | --- |
| The append guard might be absent for a live session without session attachments. | Refuted: `SessionStore.enter()` always attaches a live session, and `appendRequiredExternalEvent()` requires that exact live entry before writing. |
| An ignorable record with an unknown envelope field no longer loads. | Deliberate: `ignorable` applies only to an unknown event type. Envelope fields define the session format and remain fail-closed; the session subsystem guide and Agent Note now state this explicitly. |
| Guard recovery, restored payload immutability, and generic fixed-envelope failures needed more direct evidence. | Added focused cases for validator rejection recovery, frozen restored payloads, and malformed known/ignorable event envelopes. |

No production implementation changed after this approving review; the remaining changes are the focused coverage and documentation clarification above.

## Final focused evidence

- `pnpm exec tsc -b packages/core/session/tsconfig.json packages/session/session-persistence/tsconfig.json packages/session/session-persistence-jsonl/tsconfig.json --pretty false` — passed.
- `pnpm exec vitest run packages/core/session/tests/required-external.spec.ts packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts -t 'required external|validateStoredEvents'` — 3 files, 26 passed, 147 skipped.
- `pnpm run verify-translation-pairing --write docs/subsystems/session.md packages/core/session/README.md .agents/notes/implemented/architecture/2026-09-03-required-external-session-events.md` — no records changed.
- `pnpm run verify-translation-pairing docs/subsystems/session.md packages/core/session/README.md .agents/notes/implemented/architecture/2026-09-03-required-external-session-events.md` — 3 named pairs consistent.
- `pnpm run verify-agent-note-format` — 686 Agent Notes conform.
- `git diff --check` — passed.

Repository-wide test, type, and documentation gates remain intentionally deferred to merge or release. The next implementation step is Roundtable integration and a real cold-load probe, not another core-only test pass.
