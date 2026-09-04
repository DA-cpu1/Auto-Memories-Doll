# Phase 2 显式 KnowledgeAgent 契约报告

| 字段     | 内容                              |
| -------- | --------------------------------- |
| 规范编号 | `LKA-001`                         |
| 阶段     | Phase 2：建立显式知识整理 Agent   |
| 状态     | 已完成                            |
| 日期     | 2026-09-04                        |
| 前置阶段 | Phase 1 保留行为特征测试          |

## 1. 公开边界

本阶段测试只观察以下公开接口，不断言内部调用次数：

| 边界                                 | 可观察结果                                               |
| ------------------------------------ | -------------------------------------------------------- |
| `SourceRevisionEvent` 工厂和 Zod 契约 | 规范路径、稳定来源 ID、sha256 版本、稳定事件 ID           |
| `SourceRegistry`                     | 新增/变更/未变判定、最新成功版本、健康状态、错误信息      |
| `KnowledgeAgent`                     | 候选入队、来源关联、合法状态迁移、恢复、审核和阶段进度    |
| 文件、工具目录和 listen 入口         | 统一来源事件、幂等 no-op、add/change/delete/rescan 路由   |

LLM、Embedding、文件系统和时间属于系统边界；集成测试使用真实临时文件和 SQLite，仅在需要确定降级结果时替换模型边界。

## 2. 来源版本契约

- `sourceId` 由来源类型和规范身份计算，路径分隔符统一为 `/`。
- `revision` 是来源原始字节的 sha256，不以文件路径代替版本。
- `eventId` 由 `sourceId + revision` 计算；同一版本在 add 和 rescan 下保持一致。
- listen 优先使用 conversation/session ID、URL 或标题作为来源身份，无稳定外部标识时使用内容指纹。
- Trae 作为现有兼容来源保留在 `SourceType` 中。

## 3. 持久化迁移

新增 `source_documents`：

- 保存来源类型、规范路径、最新成功版本、健康状态、最近观察/处理时间和错误。
- `beginObservation()` 不推进最新版本；只有候选成功暂存或确定性忽略后，`markProcessed()` 才提交版本。

新增 `processing_attempts`：

- 追加保存 `sourceId`、`revision`、`eventId`、`memoryId`、阶段、attempt、耗时、结果、错误码、可重试性和降级能力。
- `GET /api/listen` 返回来源快照和最近 50 条进度，供后续状态页消费。

扩展 `pending_events`：

- 新增可选 `sourceEventId`、`sourceId`、`sourceRevision`，兼容旧记录为空。
- 普通状态更新经过集中迁移校验；`done` 和 `rejected` 不能重新打开。

## 4. Agent 状态和恢复

正常发布路径：

```text
discovered -> parsing -> normalizing -> staged -> processing
  -> accepted -> publishing -> indexed -> done
```

分支路径：

- 不确定或模型降级：`processing -> review`。
- 人工接受：`review -> accepted -> publishing -> indexed -> done`。
- 人工拒绝：`review -> rejected`。
- 可恢复失败：`processing -> failed_retryable -> processing`。
- processing 中断：记录失败后回到 staged，队列恢复为 pending，事件和来源版本保持不变。
- 来源删除：终止同来源尚未发布的 pending/review 候选；已发布知识通过带来源版本的 delete 事件入队。

## 5. 编排所有权

生产入口不再直接实例化 `Orchestrator`。`KnowledgeAgent` 现在拥有来源路由、状态、恢复、队列消费、人工审核、冲突解决和重建入口。为控制迁移风险，原 `Orchestrator` 仍作为 `KnowledgeAgent` 内部兼容执行引擎，Phase 2 没有整体重写已由 Phase 1 固定的发布行为。

## 6. 测试

新增：

- `source-revision.test.ts`：2 条。
- `source-registry.test.ts`：1 条。
- `agent-state-machine.test.ts`：3 条。
- `knowledge-agent.integration.test.ts`：5 条。
- 新增合计：11 条；全量共 56 个测试文件、497 条测试。

阶段门禁结果：

| 门禁                   | 结果 |
| ---------------------- | ---- |
| `npm run format:check` | 通过 |
| `npm run typecheck`    | 通过 |
| `npm run lint`         | 通过 |
| `npm run test`         | 通过 |
| `npm run eval`         | 通过 |
| `npm run build`        | 通过 |
| `npm run test:e2e`     | 通过 |

## 7. Phase 3 进入条件

- 所有保留采集入口已具有统一来源版本语义。
- 去噪报告、块级身份和来源-知识关系可以基于 `sourceId/revision/eventId` 扩展。
- 范围外聊天、画像、Prompt 和聊天型 MCP/Skills 仍未删除；生产删除继续等待 Phase 4 解耦完成。
