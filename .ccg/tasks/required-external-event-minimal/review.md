# Design review

## Critical

None in the selected design. The external marker is persisted, mandatory for an externally required record, and fails closed when its reader is absent.

## Warnings

- The new envelope field must be structurally validated at every durable read boundary; type-level declarations alone are insufficient because JSONL input is untrusted.
- A registration must be owned by a Cordis effect, not a global mutable event-name set. A disposed registration cannot continue to stamp new records.
- Roundtable adoption must replace its direct `Session.append()` writer path; otherwise the core seam remains unused and the published cold-load probe stays blocked.

## External-review status

Codex failed before review because the local wrapper received repeated ChatGPT backend HTTP 404 responses. Claude exceeded the bounded two-minute window without a terminal report. No external approval is claimed.
