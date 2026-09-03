# Agent Note: Required external Session events

Status: implemented

[English](2026-09-03-required-external-session-events.md) | 中文

## 问题

外部插件可以追加会改变插件重建状态的持久事件，但全新的 Harness 进程只认识仓库生成的 Session 事件类型。把这类事件视为 `ignorable` 会丢弃必需状态；仅因事件名称处于已挂载状态就接受它，则由当前组合决定已存记录是否安全。插件自有的侧车日志会在 Session 日志旁创建第二个真源。

## 决定

`SessionEvent` 携带可选的 `requiredExternal` 标识，其中含有插件命名空间与正 schema 版本。该标记与 `ignorable` 互斥，Harness 自有事件类型不能携带它。

`SessionStore.registerRequiredExternalEvents()` 接受一个由命名空间事件类型和同步载荷校验器组成的插件词汇，并返回幂等 disposer。插件通过 `ctx.effect()` 拥有该注册。一个事件类型只能有一个活跃写入注册，因此替换其 schema 版本会先释放原注册。`SessionStore.appendRequiredExternalEvent()` 会在校验前冻结分离载荷，并在不可变事件提交前写入精确标识；返回 Promise、释放自身注册或尝试递归 append 的校验器都会被拒绝，不会创建未观察的异步检查。普通 `Session.append()` 不能写入此标记。

`validateStoredEvents()` 会校验固定事件信封，且只在活动读取方快照包含精确命名空间、版本、类型，并由校验器接受不可变载荷时，才接纳必需外部记录。缺少注册会产生 `SessionFormatUnsupportedError`；格式错误的信封或标记、Harness 类型上的标记、任意并存的 `ignorable` 或被拒绝的载荷会产生 `SessionPersistenceCorruptionError`。`SessionStore.prepare({ seedSource: 'persistence' })` 会在构造不可变 Session 前重复进行活动注册校验，并在之后确认快照仍有效；直接 seed 和直接调用 `Session.fromRestore()` 会拒绝外部标记。JSONL 会在 I/O 后捕获读取方快照，并在校验后确认其仍然有效才缓存，因此释放注册后不会复用先前被接受的缓存日志。

`SESSION_FORMAT_VERSION` 保持 `0`，因为 Harness 仍处于预发布阶段，不为旧的本地实验日志承诺兼容性。[可忽略外部事件决策](2026-08-30-retain-ignorable-external-session-events.zh.md)仍适用于可安全省略的信息性记录。

## 曾考虑的替代方案

**把 Roundtable 状态事件标为 `ignorable`。** 不予采用，因为每个 Roundtable 事件都可能改变后续重建；跳过其中一个会组装出错误状态。

**把已挂载的事件名称注册为第一方词汇。** 不予采用，因为类型名称不持久记录其写入方标识，也不说明缺失是否安全。它也无法区分匹配的读取方版本与不兼容版本。

**把插件状态保留在侧车数据库或第二条事件流中。** 不予采用，因为持久化、恢复、分支与人工审批将拥有两条独立排序的持久历史。

**让插件修改已完成的 Session 事件或设置任意标记。** 不予采用，因为存储观察方已经可以看到已提交事件；标记所有权与载荷校验必须在提交前发生。

## 影响

状态变化的外部插件可以继续使用单一日志，而不削弱读取必需语义。插件必须拥有命名空间、版本与载荷校验器，并在冷读取运行期间保留注册。插件重载或缺少插件会正确令其必需会话不可用，而不会悄悄生成局部状态。信息性扩展继续使用独立的 `ignorable` 路径。

## 验证

聚焦测试覆盖注册表所有权与释放、带标记的写入、存储分类、JSONL 跨上下文冷读取，以及释放后的缓存失效。在与 Roundtable 集成之前，聚焦的 Session、持久化和 JSONL 测试套件及其三个 TypeScript 包构建均通过。
