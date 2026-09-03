# Required external Session events

## Goal

Allow an installed external plugin to durably write and cold-reload Session events that are required for its own projection, without making those events globally known to every Harness build or allowing an absent plugin to skip them.

## Required behavior

- An external writer must register an exact namespace, schema version, event types, and payload validator before it can append a required external event.
- The written event must carry immutable reader identity selected by the registration, not an arbitrary call-site marker.
- A cold reader with the exact registration must validate and replay the event.
- A cold reader without the registration must fail closed with `SessionFormatUnsupportedError` and retain the raw artifact.
- A mismatched version, type, namespace, or payload must fail closed or as durable corruption; it must never be silently ignored.
- Existing first-party events and logs remain unchanged.
- No second Roundtable store, scheduler, free-chat protocol, or mutable artifact path is introduced.

## Verification scope

Run only focused core Session/persistence tests plus the existing external Roundtable two-process published-runtime probe after the plugin registers its event vocabulary. Do not run the repository-wide suite unless a focused failure requires diagnosis.
