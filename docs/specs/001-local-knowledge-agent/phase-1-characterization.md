# Phase 1 保留行为特征报告

| 字段     | 内容                             |
| -------- | -------------------------------- |
| 规范编号 | `LKA-001`                        |
| 阶段     | Phase 1：固定需要保留的行为      |
| 状态     | 已完成                           |
| 日期     | 2026-09-03                       |
| 前置基线 | `pre-scope-reduction-2026-09-03` |

## 1. 测试边界

本阶段从准备长期保留的公开接口观察行为，不对私有方法和内部调用次数做断言：

| 任务 | 公开边界                                                               | 可观察结果                                   |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------- |
| T1.1 | `ingestMarkdownFile()`、`scanMemoryRoot()`                             | 队列事件、稳定 ID、变更事件和重复数量        |
| T1.2 | `MemoryService`、`Orchestrator.processQueue()`、`recoverStuckEvents()` | 正式记忆、Markdown、事件状态、冲突和恢复结果 |
| T1.3 | `VectorRetriever`、`searchWithExpansion()`、`WikiGraph`、`Ranker`      | 检索模式、排序结果、图谱邻居和多样性         |
| T1.4 | `HnswVectorSearchBackend`                                              | sidecar 重建、检索结果和规范 Markdown 字节   |

测试使用真实临时文件系统、真实 `better-sqlite3`、真实关键词索引、真实 JavaScript 向量后端和真实 HNSW/USearch 后端。只有 LLM 和 Embedding 这种外部系统边界使用确定性替身。

## 2. T1.1 监听到队列

已固定以下行为：

- 无 frontmatter 的本地 Markdown 通过稳定路径生成 `file-{hash}` ID。
- 新文件只生成一条 create 事件。
- 同一文件并发 add/change 观察只产生一条真实 SQLite 队列事件。
- 正式发布后执行 `scanMemoryRoot()`，未变化来源不产生新 pending 事件。
- 文件内容发生变化后，产生 update 事件并沿用原 memory ID。
- 文件重扫前后正式知识数量保持为一条。

## 3. T1.2 队列到发布

已固定以下真实持久化结果：

- `accept`：事件进入 done，SQLite 和 Markdown 使用同一 ID，向量记录可检索，来源位置保留。
- `review`：事件跨连接保留为 review，不创建正式记忆或 Markdown。
- `reject`：事件进入 rejected、`retryCount=0`，不再进入 pending。
- `failed`：损坏候选进入 failed，`retryCount` 增加，不发布内容。
- 进程恢复：processing 事件重新打开数据库后可恢复为 pending，事件 ID 和重试次数不变。
- 标量冲突：更新不会覆盖既有值，而是写入真实 `conflict_records` 等待人工裁决。

## 4. T1.3 混合检索

已固定以下检索行为：

- Embedding 为空时，`searchDetailed()` 返回 `keyword` 模式和真实关键词命中。
- Embedding 可用时，通过真实 `vector_records` 和余弦检索返回最近知识。
- 原句和 budget 改写变体并行召回，同一知识按最高相似度合并。
- 原句命中的结果不会因查询改写而丢失。
- `WikiGraph` 从正式 Markdown 的关系字段重建正向和反向邻居。
- MMR 首先保留最高相关结果，再优先选择标签不同的知识，降低近似重复。

## 5. T1.4 索引重建

测试实际创建并删除 `.usearch` sidecar。重新创建 HNSW 后端后，索引从 SQLite `vector_records` 自动重建，检索结果恢复，同时正式 Markdown 内容逐字节保持不变。

## 6. 本阶段发现并修复的问题

### 来源哈希被归一化内容覆盖

Watcher 使用原文件正文计算 `evidence.sourceHash`，但 `Orchestrator.commitExtractedCards()` 原先会用归一化后的候选正文重新计算并覆盖它。原文件和归一化文本可能不同，导致未变化文件在重扫时被错误识别为更新并重复入队。

修复后优先保留采集阶段的原始 `evidence.sourceHash`，只有旧入口没有提供哈希时才根据候选正文回退计算。

## 7. 新增测试

- `retained-core-characterization.integration.test.ts`：7 条。
- `retained-retrieval-characterization.integration.test.ts`：6 条。
- 新增合计：13 条。

## 8. 全量验证

| 门禁                   | 结果                             |
| ---------------------- | -------------------------------- |
| `npm run format:check` | 通过                             |
| `npm run typecheck`    | 通过                             |
| `npm run lint`         | 通过，0 warning                  |
| `npm run test`         | 52 files，486 tests 全部通过     |
| `npm run eval`         | 3 tests 通过，Phase 0 指标无回退 |
| `npm run build`        | 通过                             |
| `npm run test:e2e`     | 6/6 通过，38.2 秒                |

## 9. Phase 2 进入条件

- 保留链路已经有真实持久化特征测试保护。
- Phase 2 可以定义统一 `SourceRevisionEvent` 和 Agent 状态迁移契约。
- Phase 2 仍不删除聊天、画像等范围外功能。
- 生产功能删除继续等待 Phase 4 解耦完成。
