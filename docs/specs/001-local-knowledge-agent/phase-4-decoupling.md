# Phase 4 保留代码解耦报告

> Phase 8 后续：本报告记录 Phase 4 当时的解耦结果。最终死代码审计确认聊天式纠错和 nightly 没有产品入口，自动 retention 还会绕过审计队列；这些模块及其旧测试已在 Phase 8 删除，详见 `phase-8-delivery.md`。

| 字段     | 内容                                      |
| -------- | ----------------------------------------- |
| 规范编号 | `LKA-001`                                 |
| 阶段     | Phase 4：将保留代码与待删除功能解耦       |
| 状态     | 已完成                                    |
| 日期     | 2026-09-04                                |
| 交付边界 | 不删除用户数据，不提前删除 Phase 5 的页面 |

## 1. 排序与画像解耦

`Ranker` 的公开 API 不再接收 `profileTags`，基础分数改为四个可解释因子：

```text
score = relevance * 0.5
      + quality   * 0.2
      + recency   * 0.2
      + access    * 0.1
```

`quality` 由知识记录完整性和来源证据确定性计算，不读取推断画像。`heatScore` 同步移除标签亲和度，收缩为访问行为和时间衰减。MMR 仍使用候选知识之间的标签 Jaccard 相似度做多样性惩罚，该相似度只比较知识条目，不涉及用户画像。

## 2. 路径与 Prompt 解耦

`StorageMigrationService` 迁移后只失效路径缓存并重启文件监听器，不再导入或调用 `PromptCache`。`path-resolver.ts` 只负责数据库位置和知识文件路径，不承担聊天 Prompt 或画像缓存生命周期。

## 3. 知识 AI 契约

新增两个边界：

- `knowledge-model.ts`：只定义结构化文本生成、Embedding、模型档位和降级能力。
- `knowledge-model-adapter.ts`：实现知识提取、分类、质量评价、纠错、查询改写和 Embedding 所需的非流式调用。

保留服务全部改用 `KnowledgeModelAdapter`，不再导入 `AiEvent` 或聊天 `ModelAdapter`。旧 `ModelAdapter` 变为聊天流兼容门面，仅负责 `ReadableStream<AiEvent>`，等待 Phase 5 随聊天 API 一并删除。

## 4. 后台任务

`NightlyOrchestrator` 只保留知识矛盾检测、wikilink 补充和日报生成。以下任务已从 nightly 和日报契约移除：

- 用户画像聚合更新。
- 动态聊天任务路由优化。

默认服务启动也不再创建 MCP 自动采集调度器。旧实现文件暂时保留，便于 Phase 5 集中删除，不再进入保留产品启动链。

## 5. 配置非破坏迁移

新增 `KnowledgeConfigService`，只初始化和访问：

- `config.ai`
- `config.storage`
- `tool_watch_sources`

旧 `ConfigService` 退为 MCP/Skills 兼容子类。已有 `mcp_servers`、`skills` 表和记录不删除；保留服务初始化时也不会创建或读取这些表。`AppConfig` 和 `ConfigSection` 只描述目标产品配置，旧集成类型单独标记为 `LegacyIntegrationConfig`。

## 6. 回归保护

新增 `phase-4-decoupling.test.ts`，覆盖：

- 排序和热度计算不得出现画像标签依赖。
- 路径迁移不得导入 PromptCache。
- 保留 AI 消费者不得导入聊天事件或聊天适配器。
- nightly 不得恢复画像或路由优化。
- 默认启动不得恢复 MCP 采集调度器。
- 知识配置初始化不创建旧表，且已有旧记录保持不变。

Ranker、nightly、模型降级、质量闸门、主题分类、编排器和真实 SQLite/文件系统特征测试均已切换到新边界。

阶段门禁结果：

| 门禁                    | 结果                          |
| ----------------------- | ----------------------------- |
| `npm run format:check`  | 通过                          |
| `npm run typecheck`     | 通过                          |
| `npm run lint`          | 通过                          |
| `npm run test`          | 57 个文件，503 条测试全部通过 |
| `npm run test:coverage` | 通过既有覆盖率阈值            |
| `npm run eval`          | 3 条检索评测全部通过          |
| `npm run build`         | 通过，40 个页面完成生成       |
| `npm run test:e2e`      | 6 条 Chromium 流程全部通过    |

## 7. Phase 5 进入条件

- 保留的采集、加工、审计、存储和检索链不再依赖聊天、画像、PromptCache 或聊天型 MCP/Skills 配置。
- Phase 5 可以删除旧聊天页面/API、会话持久化、画像、人格 Prompt、MCP/Skills 及其兼容适配器，而不改动 `KnowledgeModelAdapter`、`KnowledgeConfigService` 或排序接口。
- 旧用户数据仍保持原位，删除范围外运行时代码不得顺带删除 JSONL、profile 或旧配置表。
