# Agent Note: Required external Session events

Status: implemented

English | [中文](2026-09-03-required-external-session-events.zh.md)

## Problem

An external plugin can append a durable event that changes the plugin's reconstructed state, but a fresh Harness process knows only the repository-generated Session event types. Treating such an event as `ignorable` drops required state; accepting it merely because its type name is mounted lets the current composition decide whether a stored record is safe. A plugin-owned sidecar log would create a second source of truth beside the Session log.

## Decision

`SessionEvent` carries an optional `requiredExternal` identity with a plugin namespace and positive schema version. The marker is mutually exclusive with `ignorable`, and Harness-owned event types cannot carry it.

`SessionStore.registerRequiredExternalEvents()` accepts one plugin vocabulary of namespaced event types and synchronous payload validators, and returns an idempotent disposer. A plugin owns that registration through `ctx.effect()`. One event type has one active writer registration, so replacing its schema version disposes the prior registration first. `SessionStore.appendRequiredExternalEvent()` freezes the detached payload before validating and stamps its exact identity before the immutable event commits; a validator that returns a Promise or releases its registration rejects instead of creating an unobserved asynchronous check. Ordinary `Session.append()` cannot write the marker.

`validateStoredEvents()` accepts a required external record only when its active reader snapshot contains the exact namespace, version, type, and a validator that accepts the payload. An absent registration produces `SessionFormatUnsupportedError`; a malformed marker, a marker on a Harness type, any `ignorable` companion, or a rejected payload produces `SessionPersistenceCorruptionError`. `SessionStore.prepare({ seedSource: 'persistence' })` repeats the active-registration check before constructing the immutable Session and confirms its snapshot stayed current afterward; direct seed and direct `Session.fromRestore()` calls refuse external markers. JSONL captures the reader snapshot after I/O and confirms it remains current after validation before caching, so disposing a registration cannot reuse a previously accepted cached log.

`SESSION_FORMAT_VERSION` remains `0` because the Harness is pre-release and makes no compatibility promise for old local experimental logs. The [ignorable external events decision](2026-08-30-retain-ignorable-external-session-events.md) remains in force for informational records whose omission is safe.

## Alternatives considered

**Mark Roundtable state events `ignorable`.** Rejected because every Roundtable event can change later reconstruction; a reader that skips one would assemble false state.

**Register mounted event names as first-party vocabulary.** Rejected because a type name does not persist its writer identity or say whether absence is safe. It also cannot distinguish a matching reader version from an incompatible one.

**Keep plugin state in a sidecar database or second event stream.** Rejected because persistence, recovery, branching, and human approval would then have two independently ordered durable histories.

**Let a plugin mutate a completed Session event or set an arbitrary marker.** Rejected because storage observers can already see the committed event; marker ownership and payload validation must occur before commit.

## Consequences

External state-changing plugins can remain single-log consumers without weakening required-on-read semantics. Plugins must own a namespace, a version, and payload validators, and they must register them for the lifetime in which cold reads run. A plugin reload or absent plugin correctly makes its required sessions unavailable rather than silently partial. Informational extensions retain the separate `ignorable` path.

## Verification

Focused tests cover registry ownership and disposal, stamped writes, storage classification, JSONL cross-context cold reads, and cache invalidation after disposal. The focused Session, persistence, and JSONL suites and their three package TypeScript builds pass before integration with Roundtable.
