# Agent Note: External controller ownership

Status: implemented

[English](2026-09-20-external-controller-ownership.md) | 中文

## 问题

外部产品可以通过 ACP、SDK、webhook 与插件入口驱动 DSH。它们的任务、委派、准入与跨运行 operation 生命周期可能与 DSH Session 事件、权限、投影和提醒混淆，使原生执行证据被错误提升为外部业务结论。

## 决策

DSH 拥有自己的 Session 日志、agent 生命周期、工具执行、会话级权限与提醒事实。外部控制器拥有自己的任务、委派、准入、跨运行 operation、恢复与管理投影状态。

ACP 与 SDK 客户端可以把 DSH Session、attempt 和工具事实关联为执行证据。没有外部 owner 的决定，这些事实不能认定外部完成、验证、准入或投影状态。

外部集成包把生命周期与恢复规则留在其 owning project。DSH 插件或 profile 可以公开原生事实或接受控制器命令，但不能把控制器的业务生命周期导入 DSH。

## 考虑过的替代方案

**把个人 agent 拓扑复制进 DSH 文档。** 拒绝，因为该拓扑属于特定部署，并会让 DSH 成为 Personal Runtime、Agent Fabric 与 Workbench 的第二个文档 authority。

**在 DSH Session 状态中表达外部任务与 operation 生命周期。** 拒绝，因为这会把可复用 Harness 与控制器特有的业务状态耦合，并让一个 Session 事实具有多重含义。

## 后果

DSH 文档说明通用所有权规则，每个外部项目则拥有自己的 schema、恢复、qualification 与验收证据。集成可以使用稳定的 DSH transport，而不会把 Session 成功当作业务完成。本决策不改变运行时 API 或存储格式。
