# Agent Note: External controller ownership

Status: implemented

English | [中文](2026-09-20-external-controller-ownership.zh.md)

## Problem

External products can drive DSH through ACP, SDK, webhook, and plugin entry points. Their task, delegation, admission, and cross-run operation lifecycles can be confused with DSH Session events, approvals, projections, and reminders, which would let native execution evidence become an external business conclusion.

## Decision

DSH owns its Session log, agent lifecycle, tool execution, session-scoped approval, and reminder facts. An external controller owns its task, delegation, admission, cross-run operation, recovery, and management projection state.

ACP and SDK clients may correlate DSH Session, attempt, and tool facts as execution evidence. Those facts do not establish external completion, verification, admission, or projection state without the external owner's decision.

External integration packages keep their lifecycle and recovery rules in the owning project. A DSH plugin or profile may expose native facts or accept controller commands without importing the controller's business lifecycle into DSH.

## Alternatives considered

**Copy the personal-agent topology into DSH documentation.** Rejected because that topology is deployment-specific and would make DSH a second documentation authority for Personal Runtime, Agent Fabric, and Workbench.

**Represent external task and operation lifecycles in DSH Session state.** Rejected because it would couple a reusable Harness to controller-specific business state and let one Session fact acquire multiple meanings.

## Consequences

DSH documentation states the generic ownership rule, while each external project owns its schemas, recovery, qualification, and acceptance evidence. Integrations can use stable DSH transports without treating Session success as business completion. The decision changes no runtime API or stored format.
