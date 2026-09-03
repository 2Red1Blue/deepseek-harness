# Minimal required external Session event support

## Adoption matrix

| Concern | Reference evidence | Adopted semantic | DSH-native owner | Rejected mechanism | Verification |
|---|---|---|---|---|---|
| Durable facts | `packages/core/session/src/known-event-types.ts:9-20`; `packages/session/session-persistence/src/storage-contract.ts:52-95` | Unknown required records refuse restore rather than disappear | Session event envelope and storage admission | Plugin-only event-name list or `ignorable: true` for Roundtable state | Matching reader loads; absent reader throws `SessionFormatUnsupportedError` |
| Writer ownership | `packages/core/session/src/index.ts:668-714` seals events before post-commit observers | An effect-owned registration stamps and validates before the append commits | `SessionStore` plus a module-private stamped append path | Post-commit mutation or arbitrary per-call marker | Unregistered event types cannot emit required external events |
| Reader identity | `packages/session/session-persistence-jsonl/src/index.ts:425-436` owns JSONL cold-read admission | Persist namespace, version, and exact event type; take one registry snapshot per read | `validateStoredEvents` and JSONL backend | Composition-dependent acceptance without a persisted classification | Version/type/payload mismatch is unsupported/corrupt, never ignored |
| Roundtable truth | `.agents/notes/implemented/architecture/2026-08-30-roundtable-director-plugin.md` | One top-level Session remains the only Run ledger | External Roundtable plugin consumes the generic seam later | Sidecar database, second scheduler, or peer chat | Existing two-process Roundtable cold-load probe |
| Recovery prior art | Catalog: OpenOPC is local but dirty and lacks a resolved license; Crossfire/FREE-MAD are upstream-only | Retain single writer and fail-closed recovery semantics only | DSH Session + Roundtable Director | Copying OpenOPC/Crossfire code or treating them as local source evidence | Core focused tests; no external code copied |

## Design

1. Add an immutable `requiredExternal` envelope reference containing a namespace and positive schema version. It is mutually exclusive with `ignorable`.
2. Add a `SessionStore` registration whose return value is an idempotent disposer. A registration declares one namespace/version and exact external event types with payload validators. Only a current registration can append one of its required external events; the store validates the detached payload and applies the immutable envelope reference before the event is frozen.
3. Preserve ordinary `Session.append()` behavior for first-party and existing live-only extension events. It cannot manufacture a required-external marker.
4. Snapshot active registrations at a persistence read. `validateStoredEvents()` accepts a matching unknown record only when the snapshot has the exact namespace/version/type definition and its payload validator succeeds. Missing registration is `SessionFormatUnsupportedError`; an invalid recorded marker or payload is `SessionPersistenceCorruptionError`.
5. Keep first-party vocabulary, ordinary JSONL layout, and the existing `ignorable` path unchanged. The new marker only appears on external required events; earlier official builds already refuse their unknown event types, so this pre-release patch does not claim compatibility with older local experimental builds.

## Files expected to change

- `packages/core/session/src/types.ts`
- `packages/core/session/src/index.ts`
- `packages/core/session/tests/required-external.spec.ts` (new)
- `packages/session/session-persistence/src/storage-contract.ts`
- `packages/session/session-persistence/tests/storage-contract.spec.ts`
- `packages/session/session-persistence-jsonl/src/index.ts`
- `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts`
- one Agent Note and the focused task record

## Focused verification

1. Core effect-owned registration/disposer, automatic stamp, rejected unregistered/disposed append, and validator failure.
2. Storage admission for matching registration, absent registration, version/type mismatch, invalid marker, invalid payload, and `ignorable` regression.
3. JSONL two-context cold read for matching versus missing registration.
4. After core support is green, update the standalone Roundtable writer to use the registration effect and rerun its existing two-process cold-load probe.

## Review limitation

The 2026-09-03 bounded Codex reviewer could not reach its backend (HTTP 404). Claude reached only internal reasoning and hit the configured two-minute limit without a terminal report. This plan therefore records a direct architecture pass and requires one bounded post-change dual review attempt; no absent report is treated as approval.
