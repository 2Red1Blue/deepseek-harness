# Agent Note: Retain ignorable session events for external plugins

Status: implemented

English | [中文](2026-08-30-retain-ignorable-external-session-events.zh.md)

## Problem

The session event envelope carries `ignorable?: true` so a reader can accept an unrecognized informational event without treating every vocabulary addition as a new session format. [PR #3087](https://github.com/deepseek-harness/deepseek-harness/pull/3087) removed the field after finding no first-party producer and made every unknown event required-on-read.

That producer inventory did not cover a third-party plugin that currently depends on the field. Without `ignorable`, a first-party reader rejects a stored session containing the plugin's informational event because the event is outside the repository-generated `KNOWN_SESSION_EVENT_TYPES`. A required external registration is not a substitute: it identifies a state-changing event that an exact active plugin version must reconstruct, while `ignorable` identifies an event a reader may omit safely.

## Decision

The canonical `SessionEvent` envelope retains `ignorable?: true`, and every representation preserves it: seed validation, JSONL, API transport, generated catalogs, and test fixtures. The persistence seam's stored-event validation (`validateStoredEvents`) continues to refuse an unknown event unless its stored envelope explicitly carries `ignorable: true`; absent remains required-on-read.

The [required external Session events](2026-09-03-required-external-session-events.md) mechanism handles state-changing external records through an exact plugin registration. It does not change the informational-event rule: an event is `ignorable` only when a reader can reconstruct correctly without it.

The field is removable only after a replacement supports the current third-party plugin across event production, persistence, reload, and transport, with an explicit cutover for sessions already containing the marker. The [session log versioning decision](2026-08-10-session-log-version-mechanism.md) continues to own the default-required safety rule and format-version policy.

## Alternatives considered

**Require every unknown event on read.** Rejected because the current third-party plugin emits an informational event outside the repository-generated vocabulary. A first-party reload would reject that session even though omitting the event is safe.

**Delete the field and design a replacement later.** Rejected because that ordering creates an immediate compatibility gap with no migration or cutover path for the plugin or its stored sessions.

**Treat every repository-external event as ignorable.** Rejected because a reader cannot infer that an unknown durable event is informational. An external event may change later reconstruction or plugin-owned state.

**Register mounted plugin event names as known.** Not adopted as the removal mechanism because event-name registration alone does not classify whether absence is safe, and acceptance would depend on the reader's current composition rather than the stored record.

## Consequences

Third-party informational events can remain reloadable when their stored records carry the explicit marker, while unknown required events still fail loudly. The marker remains part of the public event envelope, JSONL representation, transport types, generated references, and their tests; exact external registrations handle the distinct state-changing category.
