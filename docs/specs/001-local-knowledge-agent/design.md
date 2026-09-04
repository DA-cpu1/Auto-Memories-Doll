# 技术设计：本地知识整理 Agent

| 字段     | 内容                          |
| -------- | ----------------------------- |
| 规范编号 | `LKA-001`                     |
| 状态     | 已确认                        |
| 对应需求 | `spec.md` 中 FR-001 至 FR-023 |

## 1. 设计摘要

目标系统是一个长期运行、事件驱动的本地 Agent。Watcher 观察受支持的数据源并产生稳定的来源版本事件；中央编排状态机选择处理路径，执行确定性和模型辅助的知识加工，评价输出质量，并决定发布、拒绝、重试或等待人工审核。正式 Markdown 可以由用户直接阅读，SQLite 和 HNSW 为任务执行和检索提供支持。

通用聊天 Agent 循环不属于目标设计。目标系统通过“自主观察、路径决策、工具执行、结果评价、异常恢复”的知识加工闭环保持 Agent 属性。

## 2. 技术栈

### 2.1 运行时与语言

| 技术                  | 当前职责                   | 目标决策 |
| --------------------- | -------------------------- | -------- |
| Node.js 22+           | 本地服务和后台进程         | 保留     |
| TypeScript 严格模式   | 业务实现和类型契约         | 保留     |
| Next.js 14 App Router | 本地页面和 Route Handlers  | 保留     |
| React 18              | 检索、阅读、审核和设置界面 | 保留     |

### 2.2 AI 与 Agent 加工

| 技术                | 当前职责                     | 目标决策                                         |
| ------------------- | ---------------------------- | ------------------------------------------------ |
| Vercel AI SDK 7     | 模型请求、流式响应和工具循环 | 保留结构化生成能力，删除聊天循环                 |
| `@ai-sdk/openai`    | OpenAI 兼容模型端点          | 保留                                             |
| `@ai-sdk/anthropic` | Anthropic 模型端点           | 提供商目录仍支持时保留                           |
| Zod 4               | 请求和结构化结果运行时校验   | 保留                                             |
| MCP SDK             | 聊天工具和外部集成           | 目标运行时删除；未来只允许作为采集适配器重新引入 |

### 2.3 存储与检索

| 技术                        | 当前职责                           | 目标决策                         |
| --------------------------- | ---------------------------------- | -------------------------------- |
| Markdown + YAML frontmatter | 人类可读的知识文件                 | 继续作为规范知识格式             |
| `better-sqlite3`            | 元数据、队列、冲突、配置和向量记录 | 保留                             |
| USearch HNSW                | ANN 向量检索 sidecar               | 作为可选原生加速层保留           |
| JavaScript cosine scan      | 精确向量检索降级                   | 保留                             |
| Wikilink                    | 文件原生知识关系                   | 保留                             |
| JSONL                       | 聊天会话和部分追加式记录           | 删除聊天 JSONL，按需保留审计日志 |

### 2.4 采集、界面和工程质量

| 技术                   | 当前职责               | 目标决策                 |
| ---------------------- | ---------------------- | ------------------------ |
| Chokidar 5             | 文件和工具目录监听     | 保留                     |
| Tailwind CSS 3         | 页面样式               | 保留                     |
| Framer Motion          | 装饰性动画             | 无保留页面使用时删除     |
| Vitest 3 + V8 coverage | 单元、集成测试和覆盖率 | 保留                     |
| Playwright             | 浏览器 E2E             | 保留，改为知识加工主流程 |
| ESLint 10 + Prettier 3 | 静态检查和格式门禁     | 保留                     |
| GitHub Actions         | Windows/Linux CI       | 保留                     |

## 3. 系统上下文

```text
+----------------------+       +----------------------------------+
| 本地环境             |       | 可选 AI 提供商                   |
|                      |       |                                  |
| Markdown / Text      |       | 知识提取 / 分类 / 质量评价       |
| Codex 会话           |       | Embedding                        |
| Claude Code 会话     |       +----------------+-----------------+
| Cursor 会话          |                        ^
+----------+-----------+                        |
           | 文件事件                           | 仅通过 KnowledgeModelAdapter
           v                                    |
+----------+------------------------------------+------------------+
|                   本地知识整理 Agent                             |
|          observe -> decide -> act -> evaluate -> recover         |
+----------+---------------------------+---------------------------+
           |                           |
           v                           v
+----------+-----------+    +----------+---------------------------+
| 规范 Markdown        |    | 可重建运行状态                       |
| 知识单元和主题资料   |    | SQLite + 关键词索引 + HNSW          |
+----------+-----------+    +----------+---------------------------+
           |                           |
           +-------------+-------------+
                         v
               +---------+----------+
               | 本地 Web 界面      |
               | 浏览/检索/审核     |
               +--------------------+
```

## 4. 目标组件架构

### 4.1 入口与观察层

- `ToolDirWatcher`：观察开发工具会话目录和通用内容目录。
- `FileWatcher`：观察规范知识目录或用户明确配置的 Markdown 来源。
- `Listen API`：接收无法通过目录监听表达的本地集成输入。
- `SourceRegistry`：从 `ConfigService` 中提取或新增，负责来源配置、稳定 ID 和来源健康状态。

所有 Watcher 必须只输出统一的 `SourceRevisionEvent`，禁止直接调用知识提取、Markdown Writer 或向量模块。

### 4.2 Agent 编排层

建议引入显式的 `KnowledgeAgent` 作为知识加工循环的唯一所有者。现有 `Orchestrator` 中的逻辑应当渐进迁移，禁止在没有行为测试保护时整体重写。

核心职责：

- 根据来源类型选择解析器和处理路径。
- 驱动持久化事件在合法状态之间迁移。
- 调用归一化、分块、提取、去重、分类和质量工具。
- 决定发布、重试、拒绝或转人工审核。
- 为 UI 和日志输出阶段进度。
- 强制所有知识加工模型行为经过 `KnowledgeModelAdapter`，不得依赖聊天事件契约。

`KnowledgeAgent` 禁止了解 React 组件结构，也不得直接构造 HTTP Response。

### 4.3 确定性知识加工层

- `InputParser`：将特定来源转换为标准文档。
- `InputNormalizer`：清除传输和格式噪声。
- `NoiseFilter`：删除已知低价值内容，并记录删除原因。
- `Splitter`：按照结构和大小边界生成块。
- `Deduplicator`：执行内容指纹和词法相似度判断。

这些阶段必须在付费模型操作之前执行。

### 4.4 模型辅助加工层

- `MemoryExtractionService`：将有效块转换为结构化知识候选。
- `TopicClassificationService`：复核或修正规则分类结果。
- `QualityFilterService`：输出分数、三态决策和原因。
- `VectorGenerator`：为语义去重和检索生成 Embedding。

所有结构化输出必须通过 Zod 校验后才能触发状态迁移。

### 4.5 发布与检索层

- `MemoryService`：管理 SQLite 记录和持久化候选事件。
- `MemoryWriter`：将已接受知识序列化为 Markdown。
- `StudyGuideBuilder`：新增组件，将已接受知识单元组织成带引用的主题学习资料。
- `VectorSearchBackend`：管理 HNSW 和精确检索降级。
- `KeywordIndex`、`WikiGraph`、query expansion 和 `Ranker`：共同提供混合检索。

## 5. Agent 状态机

```text
discovered
    |
    v
parsing ----------> failed_retryable
    |                      |
    v                      +------> parsing
normalizing
    |
    v
staged
    |
    v
processing --------> review <------ 模型非法输出或内容不确定
    |                   |
    |                   +---- 接受或编辑后接受 ---+
    |                   +---- 拒绝 --------------> rejected
    v
accepted
    |
    v
publishing --------> failed_retryable
    |
    v
indexed
    |
    v
done

终态：done、rejected
人工等待态：review
可恢复状态：failed_retryable
```

合法迁移必须由一个模块集中约束。进程异常退出后遗留的 `processing` 事件必须恢复到可重试状态。重试必须保留原事件 ID 和来源版本。

## 6. 核心数据契约

```ts
type SourceType = "markdown" | "text" | "codex" | "claude-code" | "cursor" | "listen";

interface SourceRevisionEvent {
  eventId: string;
  sourceId: string;
  sourceType: SourceType;
  sourcePath?: string;
  revision: string;
  observedAt: string;
  operation: "add" | "change" | "delete" | "rescan";
}

interface NormalizedDocument {
  sourceId: string;
  revision: string;
  title?: string;
  content: string;
  sections: Array<{ heading?: string; content: string }>;
  removedNoise: Array<{ kind: string; count: number }>;
  metadata: Record<string, string | number | boolean>;
}

interface KnowledgeCandidate {
  memoryId: string;
  sourceId: string;
  sourceRevision: string;
  title: string;
  summary: string;
  content: string;
  topic: string;
  tags: string[];
  citations: Array<{ sourceId: string; revision: string; locator?: string }>;
}

interface QualityDecision {
  decision: "accept" | "review" | "reject";
  score: number;
  reasonCode: string;
  reason: string;
}

interface RetrievalHit {
  memoryId: string;
  title: string;
  topic: string;
  score: number;
  channels: Array<"keyword" | "vector" | "tag" | "graph">;
  source: { sourceId: string; revision: string; path?: string };
}
```

实施时可以根据现有类型调整命名，但来源版本、质量状态和检索解释字段属于强制语义，不得删除。

## 7. 存储设计

### 7.1 文件目录

```text
memory-root/
├─ index-map.md
├─ memory.db
├─ notes/
│  └─ {topic}/
│     ├─ Agent.md                 # 兼容保留的主题简要索引
│     └─ {memoryId}.md            # 规范知识单元
├─ guides/
│  └─ {topic}.md                  # 带知识单元引用的主题学习资料
└─ archive/
   ├─ audits/
   ├─ failures/
   └─ versions/
```

`guides/` 是可重建但人类可读的产品输出。发布前必须验证其引用；内容哈希没有变化时不得重复写入。

### 7.2 SQLite 表

保留的逻辑表：

- `memories`：已接受知识的元数据和运行时查询。
- `pending_events`：持久化 Agent 工作队列和状态。
- `conflict_records`：需要人工处理的不兼容变更。
- `vector_records`：重建 ANN 索引所需的向量真源。
- `memory_classifications`：主题和分类信息。
- `tool_watch_sources`：监听来源配置。
- `storage_config`：运行时存储路径。

建议新增或迁移：

- `source_documents`：稳定来源 ID、类型、规范化路径、最新版本、状态和时间戳。
- `source_memory_links`：来源版本与知识单元的关系。
- `processing_attempts`：阶段、尝试次数、耗时、错误类别和重试结果。

聊天会话和画像数据不属于目标 schema。迁移时保留既有本地文件或旧表，除非用户另行明确授权删除数据。

### 7.3 ID 和版本

- `sourceId`：来源类型和规范化路径构成的哈希或命名空间 ID。
- `revision`：捕获内容的稳定哈希。
- `eventId`：一个来源版本对应的处理任务标识。
- `memoryId`：稳定知识单元 ID；语义身份未变化时更新必须沿用。

文件路径只能标识来源，不能标识来源版本，因为文件内容可以在原路径直接修改。

## 8. 知识加工链路

### 8.1 路径选择

```text
SourceRevisionEvent
  |- 工具会话 -> session parser -> 对话归一化
  |- Markdown -> frontmatter parser -> 章节归一化
  |- Text     -> 编码验证 -> 文本归一化
  `- Listen   -> 请求校验 -> adapter 归一化
```

二进制文件或不支持的格式必须记录“忽略原因”，不得伪装成模型调用失败。

### 8.2 去噪顺序

1. 编码和控制字符清理。
2. 空消息、重复消息和纯传输消息删除。
3. 已知命令或工具样板删除。
4. 重复堆栈和生成日志压缩。
5. 在远程模型请求前执行密钥模式脱敏。
6. 在知识提取前执行最低信息量检查。

每次会删除内容的转换必须记录类型和数量。首版可以只保存来源定位信息和删除统计，不强制保存完整 diff。

### 8.3 去重顺序

1. 来源版本哈希：未变化来源直接跳过。
2. 规范化块哈希：跳过完全相同的重复块。
3. 词法相似度：不调用 Embedding 排除明显近似重复。
4. 语义相似度：候选级相似度初始阈值沿用 `0.95`。

所有阈值必须进入配置，并通过评测数据保护。

### 8.4 质量闸门

保留现有三态规则：

- `accept`：7 至 10 分，且 schema 和来源完整。
- `review`：4 至 6 分、模型不可用、输出非法或存在不确定冲突。
- `reject`：0 至 3 分、空内容、结构损坏或确认重复。

Schema 和来源验证必须先于分数判断。模型给出的高分不能弥补来源缺失。

### 8.5 主题学习资料生成

每个发生变化的主题按以下流程更新：

1. 加载该主题的已接受知识和既有资料元数据。
2. 按标签、图谱关系和语义相似度分组。
3. 尽可能确定性地产生大纲。
4. 可以使用标准模型仅根据传入知识改善顺序和标题。
5. 验证每个生成章节至少引用一个合法知识 ID。
6. 原子发布并更新主题索引。

模型编写但没有合法知识引用的事实性段落必须拒绝发布。

## 9. RAG 与检索设计

```text
用户查询
  |
  +--> 规范化关键词 -----------------------+
  +--> 原句 Embedding ---------------------+--> 按 memoryId 合并
  +--> budget 模型查询变体（可选）---------+          |
  +--> 标签和主题过滤 ----------------------+          v
  +--> 图谱邻居扩展（可选）---------------------> 分数融合
                                                          |
                                                          v
                                                      MMR 重排
                                                          |
                                                          v
                                               带来源的检索结果
```

原始查询必须始终参与检索。查询改写失败不得导致搜索失败。结果应展示各通道最高得分和最终重排得分。删除画像亲和度后，基础分数只考虑相关度、内容质量、时间和明确的用户访问行为。

## 10. 目标 API 和页面

### 10.1 保留或调整的 API

- `/api/listen`、`/api/listen/import`、`/api/listen/scan`、`/api/listen/rebuild`
- `/api/ingest`
- `/api/memory`、`/api/memory/[id]`、`/api/memory/search`、`/api/memory/rebuild`
- `/api/audit`、`/api/audit/conflicts`、`/api/audit/review-events`
- `/api/config/ai`、`/api/config/ai/test`
- `/api/config/storage`
- `/api/config/tool-sources`
- `/api/health`

### 10.2 删除的 API

- `/api/chat`
- `/api/chat/stream`
- `/api/chat/sessions/**`
- `/api/profile`
- `/api/prompt/**`
- `/api/config/mcp/**`
- `/api/config/skills/**`

### 10.3 目标页面

- `/`：来源处理状态、最近事件、待审核数量和快速检索。
- `/sources`：监听来源配置和扫描状态。
- `/library`：知识单元搜索和筛选；既有 `/memory` 可以重定向至此。
- `/topics/[topic]`：主题学习资料及其引用知识。
- `/knowledge/[id]`：知识详情和来源信息。
- `/map`：可选 Wikilink 图谱视图。
- `/review`：质量审核和冲突处理。
- `/settings/ai`、`/settings/storage`：最小运行配置。

首页必须直接呈现可操作产品，不再使用营销型 Hero 作为主要内容。

## 11. 故障和降级矩阵

| 故障                     | 必须采取的行为                                     |
| ------------------------ | -------------------------------------------------- |
| Watcher 暂时无法访问路径 | 标记来源不可用，退避重试，保留既有知识             |
| 读取期间文件继续变化     | 等待稳定窗口并重新计算同一来源版本                 |
| 解析器拒绝格式           | 记录不可重试的来源错误和原因                       |
| LLM 不可用               | 继续确定性阶段，将依赖模型的候选置于等待或审核状态 |
| Embedding 不可用         | 跳过语义去重，保留词法保护和关键词检索             |
| SQLite busy              | 有界重试事务，禁止提前发布 Markdown                |
| Markdown 写入失败        | 保持事件可重试，记录规范数据和派生文件不一致       |
| HNSW 缺失或损坏          | 从 `vector_records` 重建或使用精确扫描             |
| 学习资料引用非法         | 拒绝本次更新，保留上一份合法资料                   |

## 12. 安全设计

- 监听前解析并规范化配置路径。
- API 参数和生成文件名必须阻止路径穿越。
- 默认禁止记录完整 API Key 和完整来源正文。
- 调用远程模型前执行可配置的密钥识别和脱敏。
- 保留 localhost Host 检查和回环地址绑定。
- 所有工具会话内容必须作为不可信输入处理。
- Markdown 渲染默认转义危险 HTML。

## 13. 可观察性

结构化日志使用以下公共字段：

```text
sourceId, revision, eventId, memoryId, stage, attempt,
durationMs, outcome, errorCode, retryable, degradedCapabilities
```

本地状态页应展示：

- 监听来源健康状态。
- pending、processing、review、rejected 和 failed 数量。
- 最近处理耗时。
- LLM 与 Embedding 降级状态。
- 最近一次成功索引重建时间。

## 14. 测试设计

### 14.1 单元测试

- 稳定来源 ID 和版本哈希。
- 解析路由、归一化、去噪规则、分块边界和去重阈值。
- 状态迁移校验和错误重试分类。
- 质量结果解析和 fail-closed 行为。
- 多路分数融合和 MMR。

### 14.2 集成测试

- 文件新增、更新和重扫经过队列、发布和索引的完整链路。
- 事件处于 processing 时模拟进程重启。
- 人工接受、编辑、拒绝和冲突处理。
- Markdown、SQLite、关键词、图谱和 HNSW 重建一致性。
- 分别模拟 LLM 与 Embedding 降级。

### 14.3 浏览器 E2E

- 配置来源并观察处理状态。
- 审核一条不确定候选。
- 搜索并打开带来源的结果。
- 阅读主题资料并检查引用。
- 验证移动端布局没有横向溢出。

### 14.4 检索评测

- 保留 Recall@k 和 MRR。
- 增加含噪查询、同义查询和近似重复陷阱。
- 在报告中记录阈值变化及指标差值。

## 15. 迁移策略

1. 确认本规范，冻结新的聊天和画像功能。
2. 为保留的采集、队列、存储和检索行为补充特征测试。
3. 引入统一来源版本和 Agent 状态契约。
4. 将排序、路径和后台任务与画像及 Prompt 模块解耦。
5. 将首页替换为来源处理状态页。
6. 删除聊天、画像、Prompt 路由和页面，再清除不可达支持代码。
7. 增加主题学习资料生成和来源展示。
8. 将 E2E 和 CI 调整到目标产品主流程。
9. 更新 `Agents.md`、README、API 契约、架构图和依赖清单。

删除代码必须发生在保留模块完成解耦且测试通过之后。既有用户数据默认保留，除非单独需求明确授权删除。

## 16. 架构决策记录

- **ADR-001**：删除聊天；知识整理闭环成为唯一 Agent 循环。
- **ADR-002**：Markdown 保持规范知识源；SQLite 和 HNSW 为可重建运行状态。
- **ADR-003**：质量控制保持 fail-closed，并保留人工审核状态。
- **ADR-004**：主题学习资料只允许使用带引用的已接受知识。
- **ADR-005**：首个目标版本删除 MCP；未来只能作为类型化采集适配器重新引入。
- **ADR-006**：从排序中删除用户画像个性化因素。
