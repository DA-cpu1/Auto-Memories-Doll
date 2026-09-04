#﻿# Agent 开发规范（面向 AI）

## 核心概念速览

| 概念 | 一句话 | 位置 |
|------|--------|------|
| **记忆 (Memory)** | Markdown 文件承载的独立知识单元，含 YAML 元数据，人类和 LLM 均可直读 | `memory-root/notes/` |
| **KnowledgeAgent 循环** | 来源版本 → 解析/归一化 → 候选入队 → 质量评价 → 发布/审核/恢复 | `src/server/services/knowledge-agent.ts` |
| **待审计队列** | 候选记忆写回前暂存的 SQLite 队列，按 `memoryId` 串行消费 | `src/server/services/memory-service.ts` |
| **LLMWiki** | Markdown + YAML frontmatter 格式，每条记忆自包含 | `src/lib/storage/markdown-formatter.ts` |
| **向量召回** | SQLite 保存向量真源 + USearch HNSW ANN；版本失配自动重建，JS 精确扫描仅作降级 | `src/lib/vector/retriever.ts` / `src/lib/vector/backend.ts` |
| **图谱关系** | 文件内 `[[wikilink]]` 构建的内存索引，替代图数据库边表 | `src/lib/graph/wiki-graph.ts` |
| **来源版本** | 规范来源 ID + 内容 revision + 稳定 event ID，未变化重扫成为无操作 | `src/lib/source/source-revision.ts` |
| **处理进度** | 每个来源事件以 `AgentProgressEvent` 持久化阶段、结果、耗时和降级能力 | `src/types/agent.ts` / `src/server/services/knowledge-agent.ts` |
| **降级模式** | LLM 不可用时依赖模型的候选转审核，Embedding 不可用时降级为关键词匹配 | `src/lib/ai/knowledge-model-adapter.ts` |
| **提供商目录** | `providers.json` 声明式注册 AI 提供商和模型，零代码接入新端点 | `src/config/providers.json` |
| **存储路径热重载** | 数据库路径固定（env），笔记路径存 db 配置表可在设置面板修改并自动迁移 | `src/lib/storage/path-resolver.ts` |
| **工具会话采集** | 监听 Cursor/Codex/Claude Code 工作目录，解析会话文件自动入队 | `src/server/watchers/tool-dir-watcher.ts` |
| **多路召回** | 原句 + budget 模型改写变体并行检索、按最高相似度合并去重；改写失败自动退回单路 | `src/lib/vector/query-expansion.ts` / `query-rewriter.ts` |
| **记忆纠错闭环** | 定位目标记忆 → budget 模型按指令改写 → 变更经审计队列落库并打 `corrected` 标签 | `src/lib/memory/correction.ts` |
| **检索评测** | 固定评测集上的 Recall@k / MRR 回归基线，报告写入 `evals/reports/`，`npm run eval` 触发 | `src/eval/retrieval-eval.test.ts` |

## 1. 文档目标
本文件用于描述系统架构、数据流、处理阶段、技术边界与推荐技术栈，供 AI 在编写、修改和审查代码时作为统一上下文。

## 2. 设计原则

以下 7 条是可逐条验证的架构约束，新代码应逐条对照审核：

1. **核心零 UI 依赖**：`src/features/` 和 `src/lib/` 不导入 React 组件、Next.js 路由细节或 CSS 模块。核心以来源事件、进度事件和领域对象为契约。

2. **事件是唯一契约**：采集入口统一产生 `SourceRevisionEvent`，知识循环统一记录 `AgentProgressEvent`。不引入框架特定回调、全局 emitter 或跨层 UI 状态耦合。

3. **来源适配器显式化**：来源请求先经 Zod 校验，再由文件/工具会话 parser 和 adapter 归一化，最后进入 `KnowledgeAgent`。无全局注册器、装饰器或聊天工具执行平台。

4. **审计后发布**：候选先追加到 SQLite `pending_events`，只有自动接受或人工接受后才能发布规范 Markdown。冲突和历史版本单独保存，同一 `memoryId` 串行消费。

5. **稳定身份与可恢复性**：来源、来源版本、事件和知识单元使用稳定 ID；进程中断后沿用原事件恢复并递增 attempt，未变化来源不得重复生成候选。

6. **模型边界显式化**：知识加工 AI 调用只经过不含聊天事件类型的 `KnowledgeModelAdapter`。LLM/Embedding API 不可用时降级状态必须可见，提供商通过 `providers.json` 声明式注册。

7. **文档跟随实现，差异有记录**：AGENTS.md 的偏差表（11.1）持续维护。任何与规范的偏差都必须记录在表中，附上优先级和预期修复版本。每个 Phase 结束必须更新偏差表和路线图。

## 3. 总体技术栈
- 语言：TypeScript
- 前端框架：React / Next.js
- AI 编排：Vercel AI SDK
- 样式：Tailwind CSS
- 状态管理：React Context
- **主存储：LLMWiki（Markdown + YAML frontmatter）**——每条记忆自包含，人类和 LLM 均可直读
- 加速层：SQLite（`better-sqlite3`）仅做向量索引和全文搜索缓存，主数据源是 Markdown 文件
- 向量存储：SQLite 承载 `vector_records` 真源，`VectorSearchBackend` 抽象搜索实现；默认 USearch HNSW ANN，索引以 `.usearch` sidecar 持久化且可从 SQLite 自动重建，`VECTOR_BACKEND=js` 时使用精确余弦 fallback
- 关系管理：`[[wikilink]]` 内嵌在 Markdown 正文中，替代传统图数据库边表
- 图谱查询：`src/lib/graph/wiki-graph.ts` 从文件扫描 wikilink 构建内存索引
- 队列存储：SQLite 表 `pending_events`，承载 `PendingEvent` 待审计队列，支持按 `memoryId` 串行消费
- 记忆索引：Markdown 索引地图、JSON 元数据、标签索引
- 向量检索：`src/lib/vector/*`，负责 embedding 生成、向量更新、召回和重排
- 图谱关系：`src/lib/graph/wiki-graph.ts`，基于文件 [[wikilink]] 扫描的关系查询（替代 SQLite graph_edges 表）
- 文件格式：`src/lib/storage/markdown-formatter.ts` + `markdown-parser.ts`，负责 YAML frontmatter 序列化/反序列化
- 模型适配：`src/lib/ai/*`，通过中转站适配层调用 LLM 和 embedding API，统一请求格式、响应格式和错误处理
- API 配置管理：`src/config/api.config.ts`，管理中转站 URL、API Key（从环境变量读取，不硬编码）、模型名称和降级开关
- SQLite 驱动：`better-sqlite3`（同步 API，适合本地单机场景）
- 文件监听：`chokidar`，监控 `memory-root/` 目录下 Markdown 文件变化，自动触发记忆导入与更新
- 后台 API 监听：`/api/listen` 端点，接收来自 Trae IDE、浏览器 AI 会话等外部工具的对话数据，自动提炼为结构化笔记
- 后台任务：Route Handlers、Node.js 任务、站内调度器；Cron 仅作为可选部署形态
- 外部能力接入：目标版本只保留本地文件、开发工具会话目录和 `/api/listen` 类型化采集入口；MCP、Skills 和浏览器历史采集运行时已删除

## 4. 项目结构与链路

### 4.1 结构层定义
项目按职责分为三个处理面：
- 入口层：来源配置、人工导入、审核、检索与阅读。
- 后台加工层：JSON 清洗、分类、索引构建、记忆提取。
- 审计持久化层：差异比对、冲突处理、写回与版本管理。

### 4.2 目录树与链路
```txt
src/
├─ app/
│  ├─ (main)/page.tsx           # 来源状态、审核与快速检索首页
│  ├─ layout.tsx                # 全局布局
│  └─ api/
│     ├─ memory/route.ts        # 记忆读写入口
│     ├─ memory/[id]/route.ts   # 单条记忆操作
│     ├─ memory/search/route.ts # 记忆搜索
│     ├─ ingest/route.ts        # 后台数据接入入口
│     ├─ listen/route.ts        # 外部工具监听入口（Trae/浏览器 AI 会话）
│     ├─ audit/route.ts         # 审计入口
│     ├─ audit/conflicts/route.ts # 冲突管理
│     └─ config/                # 配置管理（AI/存储/工具来源）
├─ components/
│  ├─ memory/                   # 知识检索、详情与图谱组件
│  ├─ settings/                 # AI、存储路径与工具来源设置
│  ├─ common/                   # 公共组件
│  ├─ ui/                       # Magic UI / Aceternity UI 炫酷组件
│  └─ audit/                    # 审计相关组件
├─ features/
│  ├─ agent/                    # Agent 状态迁移
│  ├─ memory/                   # 记忆处理、分类、评分
│  ├─ ingest/                   # 后台输入接入与解析
│  │  ├─ parser.ts
│  │  ├─ normalizer.ts
│  │  ├─ adapter.ts
│  │  └─ conversation-processor.ts  # AI 对话专用处理器
│  └─ audit/                    # 审计、diff、冲突处理
├─ lib/
│  ├─ ai/                       # Vercel AI SDK 与模型适配
│  ├─ source/                   # 来源版本与稳定身份
│  ├─ memory/                   # 记忆抽象
│  ├─ tools/                    # 工具会话解析器（Codex/Claude Code/Cursor/Markdown/Text）
│  ├─ vector/                   # 向量索引与检索
│  ├─ graph/
│  │  ├─ wiki-graph.ts          # 文件级 wikilink 图谱（主）
│  │  ├─ manager.ts             # SQLite 图谱（已废弃，保留兼容）
│  │  ├─ query.ts               # 图查询工具
│  │  └─ builder.ts             # 图构建工具
│  ├─ storage/                  # 本地存储与文件写回
│  │  ├─ markdown-formatter.ts  # LLMWiki 序列化
│  │  ├─ markdown-parser.ts     # LLMWiki 反序列化
│  │  ├─ path-resolver.ts
│  │  ├─ database.ts
│  │  ├─ file-manager.ts
│  │  ├─ lock.ts
│  │  └─ index-writer.ts
│  └─ utils/                    # 通用工具
├─ server/
│  ├─ services/                 # 服务编排
│  ├─ workers/                  # 异步任务
│  ├─ pipelines/                # JSON 处理流水线
│  ├─ watchers/                 # 文件系统监听器（chokidar）
│  ├─ listener/                 # 后台监听服务（API 端口监听）
│  └─ schedulers/               # 定时任务
├─ types/
├─ config/
├─ styles/
├─ instrumentation.ts           # Next.js 插桩入口，启动后台监听器（使用 src 目录时必须位于 src/ 下）
public/
│  └─ bridge/capture.js         # 浏览器桥接脚本（捕获 AI 聊天页面）
docs/
next.config.js                  # Next.js 配置，启用 instrumentationHook
```

入口层 -> `src/app/(main)/page.tsx` -> 来源状态 / 审核 / 检索入口 -> 对应 API route

后台加工层 -> `src/app/api/ingest/route.ts` -> `src/features/ingest/*` -> `src/server/pipelines/*` -> `src/features/memory/*` -> `src/lib/vector/*` / `src/lib/graph/*`

审计持久化层 -> `src/app/api/audit/route.ts` -> `src/features/audit/*` -> `src/server/schedulers/*` -> `src/server/workers/*` -> `src/lib/storage/*`

持久化层属于审计持久化层的落盘子链路：`src/lib/storage/*` -> Markdown / SQLite / 索引 -> 检索与审核页面读取

文件监听链路 -> `instrumentation.ts` -> `src/server/listener/listener-service.ts` -> `src/server/watchers/file-watcher.ts` -> `src/features/ingest/*` -> `src/server/services/memory-service.ts` -> 记忆写入 + 向量生成

外部工具监听链路 -> 外部工具 POST -> `/api/listen` -> `src/features/ingest/conversation-processor.ts` -> 对话格式化 + 话题提取 -> `MemoryService.stageCreateMemory()` -> 待审计队列 -> `Orchestrator` 以同一 memoryId 写入 SQLite 与 Markdown -> 返回知识卡片 + memoryId

### 4.3 术语定义
- 中转站适配层：用于封装模型供应商差异的本地适配模块，统一请求格式、响应格式和错误处理。
- 监听窗口：系统可接收外部输入的来源窗口，包含三种渠道：
  - **API 监听**：`/api/listen` 端点，Trae IDE、浏览器 AI 页面等外部工具通过 HTTP POST 发送结构化对话数据
  - **文件监听**：`memory-root/` 目录，自动检测 Markdown 文件新增/修改并导入
  - **前端交互**：Web UI 的记忆导入、来源设置和审核页面
- 短时记忆：当前主题下的高频摘要与要点，存放在 `notes/*/Agent.md`。
- 长时记忆：可追溯的具体事实与事件，存放在 `notes/*/note-*.md`。
- 索引地图：记录目录、标签、关系入口和引用路径的 `index-map.md`。
- 关系映射层：描述记忆之间关系的本地图结构，使用文件内 `[[wikilink]]` 替代数据库边表；`wiki-graph.ts` 从文件扫描构建索引
- 向量索引适配层：负责 embedding 生成、更新、ANN 检索和重排的本地模块；SQLite 保存 `vector_records` 真源，USearch HNSW 图作为可重建 sidecar，JS 精确余弦仅作降级。
- 待审计队列：后台加工层产出的候选记忆事件在写入最终文件前暂存的持久化队列，存储于 SQLite 表 `pending_events`，按 `memoryId` 串行消费。
- 冲突分级：审计持久化层对候选记忆与现有记忆进行差异比对后的分级判断，分为自动可合并、需人工裁决和不可合并三级。
- API 降级：当模型 API（LLM 或 embedding）不可用时，系统自动切换到有限功能的备用模式，保证本地数据操作不受影响。

### 4.4 分层关系
- 入口层负责接入来源配置、人工导入、审核动作和检索请求。
- 后台加工层负责结构化处理、索引构建和候选记忆生成。
- 审计持久化层负责比对、冲突解决、版本化写回和落盘。
- 持久化层是审计持久化层内部的存储实现，不是独立的第五层。

### 4.5 分层职责
**入口层**
- 配置并观察本地文件与工具会话来源
- 提交人工导入和审核决定
- 浏览、筛选和检索已发布知识

#### 4.5.1 KnowledgeAgent 循环

KnowledgeAgent 是后台加工与审计发布的显式编排边界，将来源版本转换为可恢复、可观察的知识处理进度。

**职责**

1. 接收带稳定 `sourceId`、`revision` 和 `eventId` 的 `SourceRevisionEvent`。
2. 选择 parser，完成解析、归一化和候选提取。
3. 将候选作为 `PendingEvent` 入队，并持久化每个 `AgentProgressEvent`。
4. 通过质量闸门得到 `accept`、`review` 或 `reject`。
5. 接受后发布 Markdown、关键词/向量索引和图谱关系；不确定时等待人工审核。
6. 失败时记录可重试状态，进程恢复后沿用原事件继续。

**非职责**

KnowledgeAgent 不依赖 React 或 Next.js Route Handler，也不提供通用聊天、会话、MCP 或 Skills 执行能力。

**关键实现**

| 组件 | 路径 | 角色 |
|------|------|------|
| `KnowledgeAgent` | `src/server/services/knowledge-agent.ts` | 来源版本、阶段迁移、审核发布与恢复主控 |
| `KnowledgeModelAdapter` | `src/lib/ai/knowledge-model-adapter.ts` | 结构化生成、Embedding 与降级状态 |
| `SourceRegistry` | `src/server/services/source-registry.ts` | 来源版本、健康状态和处理时间持久化 |
| `VectorRetriever` | `src/lib/vector/retriever.ts` | 向量语义召回 |
| `WikiGraph` | `src/lib/graph/wiki-graph.ts` | `[[wikilink]]` 图谱邻接扩展 |

**事件优先设计**

每个有意义的步骤都写入 `AgentProgressEvent`，包含来源、版本、事件、阶段、attempt、耗时、结果、错误和降级能力。前端通过只读状态 API 获取同一契约。

**后台加工层**
- 接收归一化后的事件对象
- 清洗、分类、打分
- 生成记忆 JSON、标签索引和向量索引候选
- 将处理结果封装为 `PendingEvent` 写入待审计队列（SQLite 表 `pending_events`），而不是直接覆盖最终文件
- `PendingEvent` 必须包含 `eventId`、`memoryId`、`sourceType`、候选 `MemoryRecord`（JSON 序列化）、变更字段列表 `changedFields`、生成时间戳、`status` 和 `retryCount`（完整字段见 5.6）

**审计持久化层**
- 从待审计队列按 `memoryId` 串行消费 `PendingEvent`
- 对候选记忆与现有记忆进行差异比对，按冲突分级策略处理（详见 4.10）
- 统一负责本地文件写回、SQLite 索引更新、版本管理和失败重试
- 写回完成后从队列中删除对应 `PendingEvent`，失败时保留并重试
- 处理候选状态与已发布知识之间的不一致合并

### 4.6 接口与实现约束
- UI 组件：React、Next.js、Tailwind CSS、shadcn/ui
- 状态管理：React Context，用于轻量共享状态；跨页面持久状态由本地存储或服务端缓存承载
- AI 调用：`KnowledgeModelAdapter` 提供结构化文本生成、Embedding 和降级状态
- 输入归一化：`src/server/pipelines/*`，将多源输入整理为标准事件对象
- JSON 校验：Zod，用于请求体、记忆结构和回写结果校验
- 校验顺序：先定义 `schema`，再定义 `zodSchema`，再定义 `parse` / `safeParse`，最后才允许进入业务处理函数
- 请求响应约束：所有 API route 的请求体 schema、响应体 schema 和错误码表统一登记在 `src/config/api-route-contracts.ts`；route handler 实现侧继续在入口执行 Zod 请求校验，避免受 Next.js route module 导出限制影响
- 批处理与调度：Node.js 任务与站内调度器；Cron 仅作为可选部署形态
- 前端搜索：关键词索引、笔记检索、结果排序、点击回写
- 本地排序：按相关度、质量、最近更新和明确访问行为重排，不读取推断画像
- 本地笔记存储：`src/lib/storage/*`，负责读写 `notes/*`、`index-map.md` 和 `archive/*`
- 记忆索引：Markdown 索引地图、标签索引、关系索引、语义检索层
- 向量索引：`src/lib/vector/*`，负责 embedding 生成、向量更新、语义相似度检索、重排、回写
- 关系存储：`src/lib/graph/*`，负责记忆关系边和关系查询
- 更新策略：主题要点更新 `notes/*/Agent.md`，知识单元更新 `notes/*/note-*.md`，索引地图更新 `index-map.md`
- 落盘与版本：记忆正文用 Node.js 文件系统 API 写入 Markdown 文件；向量、图谱、队列和冲突记录用 SQLite 事务写入
- 向量存储：`src/lib/vector/*` 使用 SQLite + `better-sqlite3` 驱动，通过 `vector_records` 表保存真源；搜索经 `VectorSearchBackend` 抽象，默认 USearch HNSW ANN，JS 精确扫描仅作显式/故障 fallback
- 图谱存储：`src/lib/graph/wiki-graph.ts`（主路径）从文件扫描 `[[wikilink]]` 构建内存索引；`src/lib/graph/manager.ts`（已废弃，保留兼容）使用 SQLite 表 `graph_edges` 存储关系边
- 队列存储：`src/features/audit/queue.ts`（内存 Map 实现，进程重启丢失）和 `src/server/services/memory-service.ts`（SQLite `pending_events` 表）提供双版本队列；推荐使用 SQLite 版本以保证持久化
- 冲突记录：`src/features/audit/*` 使用 SQLite 表 `conflict_records` 存储需人工裁决的冲突，支持按 `status` 过滤
- 文件监听：`src/server/watchers/file-watcher.ts` 使用 `chokidar` 监控 `memory-root/` 目录，在 `.md` 文件新增/修改时自动走 ingest 管线导入/更新记忆（详见 4.6.1）

### 4.6.1 文件监听子系统
文件监听器在 Next.js 服务端启动时通过 `instrumentation.ts` 注册，使用 `chokidar` 库监控 `memory-root/` 目录下的 Markdown 文件变化。

**监听范围**：
- 监控路径：`memory-root/` 下所有 `.md` 文件
- 排除：`memory.db*`、`archive/**`、`index-map.md`、`profile.md`

**触发行为**：
- `add` 事件（新文件）：读取内容，经 `InputParser -> InputNormalizer -> IngestAdapter` 管线处理后，以 Markdown frontmatter 中的稳定 `id`（无 frontmatter 时按规范化文件路径生成稳定 ID）创建 `PendingEvent`
- `change` 事件（文件更新）：解析同一稳定 `id`；记忆已存在时调用 `stageUpdateMemory()`，尚未落库时按同一 ID 执行 upsert-create，不得生成新的记忆 ID
- 系统自身通过审计持久化层写出的 Markdown 由 `write-tracker` 标记，文件监听器跳过该次事件，避免写回循环

**启动方式**：
- `next.config.js` 启用 `experimental.instrumentationHook`
- `src/instrumentation.ts` 在 `NEXT_RUNTIME === "nodejs"` 时调用 `startFileWatcher()`；项目使用 `src/` 目录时，Next.js 仅识别 `src/instrumentation.ts`，放在项目根目录不会被加载
- 服务端启动时自动运行，无需手动触发

**注意事项**：
- 文件内容少于 10 字符时跳过处理
- 使用 `awaitWriteFinish` 选项（500ms 稳定窗口）避免半写入文件触发
- 导入失败时输出日志但不阻塞后续监听

### 4.6.2 后台 API 监听子系统
后台 API 监听器是系统的核心对外接口，允许 Trae IDE、浏览器 AI 会话等外部工具将对话数据通过 HTTP POST 发送到 `/api/listen`，自动完成提炼和归档。

**API 端点**：
- `POST /api/listen` — 接收对话数据，自动提取话题、创建目录、生成记忆
- `GET  /api/listen` — 查询监听器状态和统计信息

**请求格式** (POST)：
```json
{
  "source": "trae-ide",
  "sourceType": "listen",
  "messages": [
    { "role": "user", "content": "帮我实现一个排序算法" },
    { "role": "assistant", "content": "好的，这是快速排序的实现..." }
  ],
  "tags": ["ai-coding", "algorithm"],
  "topic": "ai-coding",
  "metadata": {
    "platform": "Trae IDE",
    "model": "claude-sonnet-4-20250514",
    "url": "optional-source-url"
  }
}
```

**处理流程**：
1. Zod 校验请求体 → 消息列表、来源必填
2. `ConversationProcessor.formatConversation()` → 格式化对话内容，自动提取话题分类
3. `ConversationProcessor.generateKnowledgeCard()` → 生成摘要、标签和话题元数据
4. `MemoryService.stageCreateMemory()` → 只生成一条带稳定 `memoryId` 的 `PendingEvent`，不提前写 Markdown
5. `Orchestrator` 审计通过后沿用该 `memoryId` 写入 SQLite、向量索引和 `notes/{topic}/{memoryId}.md`；Markdown frontmatter 必须包含同一 `id`
6. 返回 `{ success, memoryId, topic, filePath, knowledgeCard }`，其中 `filePath` 是审计通过后的规范目标路径

**自动话题分类**：
`MemoryExtractor.extractTopic()` 基于关键词匹配自动分类：
| 关键词 | 话题目录 |
|--------|---------|
| 代码/编程/react/typescript/api/bug | `ai-coding` |
| 日记/今天/心情/生活 | `daily-notes` |
| 项目/需求/架构/规划 | `project-planning` |
| 学习/教程/笔记/知识 | `learning` |
| 会议/讨论/决策 | `meetings` |
| 阅读/书籍/论文 | `reading` |
| 无匹配 | `uncategorized` |

**浏览器桥接**：
`public/bridge/capture.js` — 可作为浏览器书签或 Tampermonkey 用户脚本使用，自动捕获 ChatGPT、Claude、Gemini 等 AI 平台当前页面的对话内容，弹窗确认后 POST 到 `/api/listen`。

**集成方式**：
- **Trae IDE**：在 AI 对话完成后，调用 `POST /api/listen` 发送对话数据
- **浏览器**：安装 `capture.js` 书签，点击即可捕获当前 AI 页面
- **任意工具**：只需发送符合格式的 HTTP POST 请求即可接入

### 4.7 记忆目录结构
记忆系统使用本地文件夹承载，建议结构如下：
```txt
memory-root/
├─ index-map.md              # 索引地图，记录所有记忆文件夹、标签和关系入口
├─ profile.md                # 旧版本遗留数据（可保留，生产代码不再读写）
├─ memory.db                 # SQLite 数据库：向量索引、关系图谱、待审计队列、冲突记录
├─ notes/                    # 具体记忆内容文件夹集合
│  ├─ topic-a/
│  │  ├─ Agent.md            # 该主题的短时记忆要点
│  │  ├─ note-001.md
│  │  └─ note-002.md
│  ├─ topic-b/
│  │  ├─ Agent.md
│  │  └─ note-003.md
│  └─ topic-c/
│     ├─ Agent.md
│     └─ note-004.md
└─ archive/                   # 历史版本与归档内容
   └─ failures/              # 失败上下文归档，文件名含 memoryId、阶段标识和时间戳
```

### 4.8 记忆链路
- `MemoryRecord` 是主数据对象；一条记忆在文件层对应一份 `notes/*/note-*.md`，其 JSON 形态作为写回前后的规范中间表示。
- `index-map.md` 由审计持久化层在目录结构变化、标签变化或关系变化后更新，用于记录目录总索引、父子关系、标签入口和引用路径。
- `notes/*/Agent.md` 由审计持久化层在该目录下新增、修改或删除 `note-*.md` 后同步更新，保存该目录的短时记忆要点。
- `notes/*/note-*.md` 由写回流程生成或覆盖，保存实际记忆内容、来源信息、创建时间和更新时间。
- `archive/*` 由审计持久化层在版本快照、冲突回滚或人工保留历史时写入，历史快照必须带时间戳。
- 读取顺序固定为 `index-map.md` -> `notes/*/Agent.md` -> `notes/*/note-*.md` -> `archive/*`。
- 写回顺序固定为先写 `notes/*/note-*.md`，再同步对应 `notes/*/Agent.md`，必要时更新 `index-map.md`，最后写入 `archive/*` 快照。
- 进入审计持久化层前必须先进入待审计队列；同一 `memoryId` 的事件按顺序串行处理，避免并发覆盖。
- 待审计队列存储于 `memory-root/memory.db` 的 `pending_events` 表，每条记录包含 `eventId`、`memoryId`、`sourceType`、`candidate`（候选 `MemoryRecord` 的 JSON 序列化）、`changedFields`（变更字段列表）、`createdAt`、`status`（`pending` | `processing` | `done` | `failed`）和 `retryCount`（完整字段见 5.6）。
- 消费顺序：按 `memoryId` 分组，组内按 `createdAt` 升序串行消费；不同 `memoryId` 可并行处理。
- 写回成功后 `status` 置为 `done` 并保留记录 24 小时用于审计追溯，之后自动清理；失败时 `status` 置为 `failed` 并触发重试流程。
- 状态页可以展示候选的当前阶段，但未经审计内容必须标注为候选，不得混入正式知识库。
- 后台加工负责结构化补全，最终文件只在审计持久化层写入。
- 搜索回写由前端搜索命中事件触发，只更新点击次数、最近访问时间和相关标签。
- 推荐回写由推荐曝光事件触发，只更新曝光次数、热度和时间衰减权重。
- 向量回写由记忆新增或内容变更事件触发，先生成 `VectorRecord`，再同步向量索引。
- 图谱写回由记忆关系变更事件触发，关系边以 `GraphEdge` 为准，顶点属性由 `MemoryRecord` 承担。

### 4.9 记忆检索与推荐
- 检索采用混合策略：关键词召回、向量召回、标签过滤三者并行，再进行合并与重排。
- 向量召回前置多路召回（`searchWithExpansion`）：原句 + budget 模型改写变体分别检索，按最高相似度合并去重；改写失败或模型降级时自动退回单路原句召回。
- 注入提示词时按召回的 `memoryId` 精确加载（`getMemoriesByIds`），不再全量拉取记忆库；主体相关记忆上限 8 条，叠加图谱邻居后总量不超过 `RETRIEVAL_MAX_INJECTED_MEMORIES`。
- 记忆纠错闭环（`MemoryCorrectionService`）：按 `memoryId` 或检索定位目标 → budget 模型按纠错指令改写标题/摘要/内容 → 变更经 `stageUpdateMemory` 走审计队列落库并追加 `corrected` 标签；模型降级时拒绝改写以避免污染。
- 检索质量由 `src/eval/retrieval-eval.test.ts` 的 Recall@k / MRR 基线守护，`npm run eval` 生成报告。
- 重排优先级依次考虑相关度、知识完整性与来源可追溯质量、最近更新和访问次数，不得读取用户画像。
- 检索结果注入 prompt 时，只注入摘要、来源和引用路径，不直接展开全部原文。
- 前端必须支持关键词搜索索引到笔记。
- 本地推荐算法按访问次数、最近访问时间和时间衰减动态更新。
- 推荐结果必须可解释，并能回写到本地索引地图和相关时间戳。

### 4.10 数据类型约束
- `MemoryRecord` 是主记录；`VectorRecord` 是按 `memoryId` 关联的向量索引；`GraphEdge` 是关系边；`MemoryVersion` 是历史快照索引。
- `MemoryRecord.version` 表示结构版本，写回时必须随 schema 变更同步递增。
- 并发写回冲突：当两个 `PendingEvent` 同时修改同一 `memoryId` 的同一字段时，优先采用”基于 `updatedAt` 的最后写入优先”策略，并保留落选版本为 `MemoryVersion` 快照；这与候选-现有冲突不同，后者按冲突分级策略生成 `ConflictRecord` 等待人工裁决。
- 并发控制采用单 `memoryId` 串行队列或文件锁；写入前必须校验当前版本号，版本不一致时拒绝覆盖并转入重读-重算-重写流程。
- 版本回滚只在写回失败、冲突不可解、或人工审计明确要求恢复历史状态时触发，回滚目标必须来自 `archive/*` 快照。
- `VectorRecord.embedding` 的维度由 `dimensions` 字段决定，必须与 `model` 对应（见 5.2）。
- `GraphEdge.from` 与 `GraphEdge.to` 均引用 `MemoryRecord.id`。
- `heatScore` = `accessScore * 0.55 + recencyScore * 0.45`，各子项归一化到 0 到 1：
  - `accessScore` = `ln(1 + accessCount) / ln(1 + maxAccessCount)`，其中 `maxAccessCount` 为当前所有记忆中的最大访问次数；无记忆时取 0。
  - `recencyScore` = `exp(-λ * Δt)`，其中 `Δt` 为当前时间与 `updatedAt` 的小时差，`λ = 0.01`（半衰期约 69 小时，约 3 天）。
  - 各子项的默认参数（`λ`、归一化基准）定义在 `src/config/scoring.config.ts`，允许调整但变更后需重新计算全部 `heatScore`。
- 冲突分级策略：审计持久化层比对候选记忆与现有记忆时，按以下三级处理：
  - 自动可合并：候选记忆与现有记忆的变更字段不重叠，或重叠字段值相同——直接合并写入，生成 `MemoryVersion` 快照。
  - 需人工裁决：候选记忆与现有记忆的同一字段值不同——生成 `ConflictRecord`，保留双方版本，标记为 `pending` 状态，不自动覆盖；用户可在前端审计界面选择接受候选、保留现有或手动编辑。
  - 不可合并：schema 版本不兼容、数据损坏或格式校验失败——触发人工接管，不写入任何变更。
- `snapshotPath` 只保存归档文件路径，不保存业务正文。

### 4.11 模型与检索约束
- `budget` 模型用于查询改写和低成本整理，`standard` 模型用于结构化提取与话题复核，`flagship` 模型用于质量评价和高风险知识维护。
- 模型选择规则按知识任务的成本与风险显式选择，不提供聊天响应路由。
- 模型 API 通过中转站适配层调用，配置定义在 `src/config/api.config.ts`，包含：中转站 `baseURL`、`apiKey`（从环境变量 `MODEL_API_KEY` 读取，不硬编码）、Mini LLM 和 Pro 模型的模型名称、embedding 模型名称和维度、请求超时时间（默认 30 秒）和最大重试次数（默认 2 次）。
- API 降级策略：LLM 不可用或输出非法时，依赖模型的候选 fail-closed 转入 `review`；embedding 不可用时，检索降级为关键词通道，待恢复后补建向量。
- 降级状态必须在前端展示明确提示，告知用户当前处于降级模式及影响范围。
- 向量模型默认使用 `text-embedding-3-small`（维度 1536）；embedding 模型配置通过 `EmbeddingModelConfig`（见 5.5）管理，更换模型时必须同步更新维度约束和重建全部向量索引。
- 向量真源持久化于 `memory-root/memory.db` 的 `vector_records` 表；HNSW 加速图保存为同目录的 `memory.db.ann-{dimensions}.usearch`，通过 SQLite sourceVersion 校验一致性，失配或损坏时自动重建；查询经 `src/lib/vector/backend.ts` 后端接口执行
- 图谱关系通过文件内 `[[wikilink]]` 维护，`WikiGraph` 从文件扫描构建索引，无需独立图数据库
- 检索重排默认采用 `MMR`；当需要更高精度时可在实现层切换为交叉编码器重排，但必须保持结果可回写。
- 检索结果写回前必须保留召回来源、重排得分和最终入选理由，方便审计和调试。

### 4.12 目录约束
- `app` 只放路由和页面级入口。
- `components` 只放可复用 UI。
- `features` 只放业务功能。
- `lib` 只放基础能力和适配层。
- `server` 只放服务编排、任务和管线。
- `types` 只放共享类型定义。
- `config` 只放环境与常量。

### 4.13 结构原则
- UI、业务、存储三层分离。
- 来源接入、后台加工与审计发布分离。
- 模型调用与业务逻辑分离。
- 持久化写回和前端展示分离。
- 所有链路必须可从文件树直接定位到职责模块。

### 4.14 来源适配系统

目标产品不提供聊天型工具执行平台。外部输入通过类型化来源适配器进入统一知识循环：

| 来源 | 入口 | 处理 |
|------|------|------|
| Markdown / Text | `file-watcher.ts` | 稳定窗口、来源版本、解析与归一化 |
| Codex / Claude Code / Cursor | `tool-dir-watcher.ts` | `session-parser.ts` 提取会话内容后归一化 |
| 外部结构化会话 | `POST /api/listen` | Zod 校验后构造 `SourceRevisionEvent` |
| 人工导入 | `POST /api/ingest` | 解析、去重并提交候选 |

MCP 与 Skills 运行时已在 LKA-001 Phase 5 删除。未来若重新接入，只能作为有明确 schema、来源身份和 revision 的采集适配器，不得恢复通用工具调用平台。

### 4.15 旧会话数据策略

通用聊天与会话恢复不属于目标产品，相关页面、API 和运行时代码已删除。迁移遵循非破坏原则：

- 不主动扫描、修改或删除用户已有 `memory-root/sessions/*.jsonl`。
- 旧会话可以继续作为开发工具来源文件导入，但必须经过来源版本、去噪、质量审核和发布流程。
- 生产启动链、导航和 API 契约不得重新依赖旧会话目录。

## 5. 数据类型
系统维护以下七类本地数据。

### 5.1 记忆 JSON
```ts
export type MemoryRecord = {
  id: string;
  version: number;
  source: string;
  sourceType: "chat" | "ingest" | "manual" | "mcp" | "skill" | "listen";
  /** 原标题（AI 可读） */
  title: string;
  /** 中文标题（人可读），为空时前端回退到 title */
  titleZh?: string;
  content: string;
  /** 原摘要（AI 可读） */
  summary: string;
  /** 中文摘要（人可读），为空时前端回退到 summary */
  summaryZh?: string;
  /** 原标签（AI 可读） */
  tags: string[];
  /** 中文标签（人可读），为空时前端回退到 tags */
  tagsZh?: string[];
  /** 所属话题目录，如 "ai-coding"、"daily-notes" */
  topic: string;
  /** 中文话题标签，为空时前端用 getTopicLabel(topic) */
  topicZh?: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  accessCount: number;
  heatScore: number;
  vectorId?: string;
  graphLinks: string[];
};
```
- `id` 由写回流程生成，全局唯一。
- `version` 表示结构版本，schema 变更时必须递增。
- `source` 记录原始来源标识，必须可回溯到输入事件。
- `sourceType` 表示来源通道，必须取自固定枚举。
- `title`、`content`、`summary` 由记忆提取流程生成；`title` 为短标题，`summary` 为压缩摘要。
- `titleZh`/`summaryZh`/`tagsZh`/`topicZh` 为可选的中文翻译字段，供前端人类可读展示；为空时前端回退到原字段。AI 检索和注入 prompt 时只用原字段，不读 zh 字段。
- `tags` 由分类流程生成，写回时允许增量合并。
- `topic` 表示所属话题目录，由分类流程生成（见 4.6.2 自动话题分类）。
- `createdAt` 记录记忆首次落盘时间；`updatedAt` 记录最后一次写回时间；`accessedAt` 记录最近一次访问时间。
- `accessCount` 在每次命中后递增。
- `heatScore` 按 4.10 定义的公式和子项计算，默认参数在 `src/config/scoring.config.ts` 中配置。
- `vectorId` 在向量索引生成后写入。
- `graphLinks` 由关系写回流程生成，保存相关记忆 ID 列表。

### 5.2 向量索引
```ts
export type VectorRecord = {
  memoryId: string;
  embedding: number[];
  model: string;
  dimensions: number;
  updatedAt: string;
};
```
- `memoryId` 必须引用 `MemoryRecord.id`。
- `embedding` 由向量生成流程写入，长度必须与 `dimensions` 一致。
- `model` 记录实际使用的 embedding 模型名称，默认为 `"text-embedding-3-small"`，通过 `EmbeddingModelConfig`（见 5.5）管理可选范围。
- `dimensions` 记录向量维度，必须与 `model` 对应（如 `text-embedding-3-small` 对应 1536）。
- `updatedAt` 记录最后一次重建向量的时间。

### 5.3 图谱信息
```ts
export type GraphEdge = {
  from: string;
  to: string;
  relation: string;
  weight: number;
  updatedAt: string;
};
```
- `from` 与 `to` 必须引用 `MemoryRecord.id`。
- `relation` 记录关系类型，由关系提取流程生成。
- `weight` 记录关系强度，由关系更新流程维护。
- `updatedAt` 记录最后一次关系变更时间。

### 5.4 历史记忆版本
```ts
export type MemoryVersion = {
  versionId: string;
  memoryId: string;
  snapshotPath: string;
  createdAt: string;
  reason: string;
};
```
- `versionId` 由审计持久化层生成。
- `memoryId` 必须引用 `MemoryRecord.id`。
- `snapshotPath` 只保存归档文件路径，不保存正文。
- `createdAt` 记录快照写入时间。
- `reason` 记录生成快照的原因。

### 5.5 Embedding 模型配置
```ts
export type EmbeddingModelConfig = {
  name: string;
  dimensions: number;
  maxTokens: number;
  batchSize: number;
};
```
- `name` 记录模型标识，如 `"text-embedding-3-small"`。
- `dimensions` 记录向量维度，必须与 `VectorRecord.dimensions` 一致。
- `maxTokens` 记录单次请求的最大 token 数，超限时分段处理。
- `batchSize` 记录单次 API 请求的最大条目数，默认为 100。
- 默认配置定义在 `src/config/api.config.ts`；更换模型时必须更新此配置、`VectorRecord.dimensions` 约束，并重建全部向量索引。

### 5.6 待审计事件
```ts
export type PendingEvent = {
  eventId: string;
  memoryId: string;
  sourceType: "chat" | "ingest" | "manual" | "mcp" | "skill" | "listen";
  candidate: string; // 候选 MemoryRecord 的 JSON 序列化
  changedFields: string[];
  createdAt: string;
  status: "pending" | "processing" | "done" | "failed";
  retryCount: number;
};
```
- `eventId` 由后台加工层生成，全局唯一。
- `memoryId` 引用目标 `MemoryRecord.id`；新建记忆时由后台加工层预分配。
- `sourceType` 继承自原始输入事件的来源通道。
- `candidate` 存储候选 `MemoryRecord` 的完整 JSON 序列化，审计层反序列化后进行差异比对。
- `changedFields` 记录相对于现有记忆的变更字段列表，用于冲突检测；新建记忆时为全部字段。
- `createdAt` 记录入队时间。
- `status` 记录当前处理状态；`done` 状态保留 24 小时后自动清理，`failed` 触发重试流程。
- `retryCount` 记录重试次数，达到上限后触发人工接管。

### 5.7 冲突记录
```ts
export type ConflictRecord = {
  conflictId: string;
  memoryId: string;
  eventId: string;
  field: string;
  existingValue: string; // 现有值的 JSON 序列化
  candidateValue: string; // 候选值的 JSON 序列化
  status: "pending" | "resolved_accept" | "resolved_keep" | "resolved_manual";
  resolution?: string; // 用户手动编辑后的值（JSON 序列化）
  createdAt: string;
  resolvedAt?: string;
};
```
- `conflictId` 由审计持久化层生成，全局唯一。
- `memoryId` 和 `eventId` 引用关联的 `MemoryRecord` 和 `PendingEvent`。
- `field` 记录冲突字段名。
- `existingValue` 和 `candidateValue` 分别保存双方版本的 JSON 序列化，不直接存储对象引用。
- `status` 记录裁决状态：`pending` 为待处理，`resolved_accept` 为接受候选值，`resolved_keep` 为保留现有值，`resolved_manual` 为用户手动编辑。
- `resolution` 在 `resolved_manual` 时保存用户编辑后的值，其他状态为空。
- `createdAt` 记录冲突发现时间；`resolvedAt` 记录裁决时间。
- 存储于 SQLite 表 `conflict_records`，支持按 `status` 和 `memoryId` 查询。

## 6. 处理策略
- 新增功能前先判断属于入口、后台加工还是审计持久化。
- 后台加工负责归一化、去重、分类、索引构建和候选记忆生成，结果先进入待审计队列。
- 审计持久化负责冲突消解、版本管理、回滚和最终落盘。
- 处理 JSON 时先做拆分、去重、格式化，再进入索引与评分。
- 涉及写回时必须明确区分”增量更新”和”覆盖写入”。
- 冲突分级处理：审计层收到候选记忆后，按 4.10 定义的冲突分级策略进行差异比对和处理。
- API 降级处理：LLM API 不可用时，依赖模型的候选转人工审核；embedding API 不可用时，向量召回降级为关键词召回并在恢复后补建；降级状态须在前端提示。
- API 开发规范：所有 API 应先在 `src/config/api-route-contracts.ts` 登记请求体 Zod schema（无请求体可省略）、响应体 schema 和错误码枚举，再写 route handler；handler 内必须继续执行请求体 Zod 校验。
- 并发写入本地文件时必须通过单写入队列或文件锁保证顺序；同一 `memory-root/` 下的写入任务不得并行覆盖同一目标文件。
- 后台任务失败时必须保留失败上下文，并允许重试；重试前必须保留原始输入和上一次处理结果。
- 任何推测性内容都应在代码中显式标注，不能伪装成确定数据。
- schema 变更时必须同步更新 `MemoryRecord.version`、迁移脚本和读取方兼容逻辑。
- 涉及敏感记忆、个人信息或外部来源原文时，默认仅写入必要摘要，不直接扩散全文。
- 功能变更完成后必须补充对应单元测试或集成测试，覆盖新增分支、写回结果或重排结果。

## 7. 失败与重试
- 任何失败都必须记录失败类型、输入快照、处理阶段、错误堆栈、重试次数和最后一次处理时间。
- 失败上下文默认写入 `memory-root/archive/failures/`，文件名必须包含 `memoryId`、阶段标识和时间戳。
- 重试策略默认采用最多 3 次重试，间隔分别为 1 分钟、5 分钟、20 分钟；退避算法采用指数退避并叠加随机抖动。
- 幂等任务允许在检测到相同输入快照时直接复用上一次成功结果，不重复写入最终文件。
- API 调用失败（LLM 或 embedding）与业务重试分开管理：LLM 失败时将不确定候选置为 `review` 并等待恢复；embedding 失败不影响关键词检索，恢复后补建向量。
- API 连续失败超过 10 分钟时，在前端持久提示降级状态，直到恢复检测成功。
- 当同一任务连续失败达到重试上限，或者检测到版本冲突、schema 不兼容、数据损坏时，必须触发人工接管。
- 人工接管条件包括：自动重试耗尽、冲突无法合并、历史快照缺失、校验失败不可修复、或用户明确要求回滚。
- 人工接管入口必须保留原始输入、失败原因、候选修复结果和建议操作，不得只给出简短错误码。

## 8. 决策点
- 部署形态：纯本地单机，不考虑多用户隔离和远程访问；进程重启后从 SQLite 恢复待审计队列和冲突记录状态。
- 监听数据的接入形式：统一为标准化事件对象，底层输入可以来自 JSON、事件流或文件落盘，但进入系统前必须归一化。
- 本地存储目录：使用 `memory-root/` 作为根目录，结构以 `index-map.md`、`memory.db`、`notes/*` 和 `archive/*` 为准；旧 `profile.md` 可以原位保留但不再由生产代码读写。
- 存储方案：记忆正文用 Markdown 文件（人类可读、可直接编辑）；向量索引、关系图谱、待审计队列和冲突记录用 SQLite（结构化查询、事务保证、单文件便于备份）。
- 外部接入边界：只接受具有明确 schema、来源身份和 revision 的采集输入，不提供 MCP/Skills 通用执行平台。
- `memory/route.ts` 写入模式：默认采用合并写入，冲突时进入审计持久化层按冲突分级策略处理。
- `heatScore` 计算：各子项公式和默认参数定义在 4.10 和 `src/config/scoring.config.ts`，变更参数后需重新计算全部 `heatScore`。
- 模型档位：`budget`、`standard`、`flagship` 均通过 `KnowledgeModelAdapter` 调用，按知识任务成本和风险选择，API 不可用时按 fail-closed 降级策略处理。
- 决策点应在实现前优先判断，若与已有章节冲突，则以”设计原则、处理策略、失败与重试、数据类型约束”为准。

## 9. 安全与隐私
本系统为纯本地单机部署，安全策略聚焦于本地数据保护和 API 凭证管理，不涉及多用户隔离和远程访问控制。

- API Key 管理：中转站 API Key 必须从环境变量 `MODEL_API_KEY` 读取，不得硬编码在源码或配置文件中；`.env` 文件必须加入 `.gitignore`。
- 本地数据备份：`memory-root/` 目录支持整体备份（Markdown 文件 + `memory.db`）；建议提供 `导出全部记忆` 和 `导入备份` 功能，导出格式为 `memory-root/` 的 zip 压缩包。
- 敏感信息处理：涉及外部来源原文（如工具会话）时，默认仅写入必要知识和来源标识；远程模型调用前必须脱敏，敏感记录需在 `MemoryRecord.tags` 中加入 `sensitive` 标签。
- 数据清理：用户可以单条或批量删除记忆；删除操作将记忆正文移至 `archive/deleted/`（带时间戳），同步删除向量索引和图谱关系，保留 `MemoryVersion` 快照用于恢复。
- 日志安全：失败上下文和审计日志中不得包含 API Key、完整原文或用户隐私内容；如需包含输入快照用于调试，必须脱敏处理。
- 进程隔离：SQLite 数据库使用文件锁保证单进程访问，不允许多个进程实例同时写入同一 `memory.db`。

## 10. 测试策略
测试按层定义关注点，每层必须覆盖新增分支、写回结果或重排结果。

**来源与 Agent 测试**
- 测稳定来源 ID、revision、重复观察无操作和处理中断恢复。
- 测候选生成逻辑：输入归一化 → 抽取 → `PendingEvent` 结构完整性。
- 测 LLM API 不可用时的 fail-closed 审核路径和降级提示。

**后台加工层测试**
- 测 JSON 清洗和去重：重复输入不产生重复 `PendingEvent`。
- 测分类和打分：`tags` 生成一致性、`heatScore` 子项计算公式正确性。
- 测 embedding API 不可用时：新记忆标记”向量待生成”、关键词召回降级是否生效。
- 测 `PendingEvent` 入队：字段完整性、`status` 初始值为 `pending`。

**审计持久化层测试**
- 测冲突分级：自动可合并（不同字段）、需人工裁决（同字段不同值生成 `ConflictRecord`）、不可合并（schema 不兼容阻断写入）。
- 测版本管理：写回后 `MemoryVersion` 快照生成、版本号递增、回滚后状态恢复。
- 浘并发控制：同一 `memoryId` 串行处理、不同 `memoryId` 可并行。
- 测写回顺序：`note-*.md` → `Agent.md` → `index-map.md` → `archive/*`。
- 测 `ConflictRecord` 裁决：`resolved_accept` / `resolved_keep` / `resolved_manual` 三种路径的写回结果。

**持久化层测试**
- 测 SQLite 事务：向量、图谱、队列写回的原子性，失败时回滚。
- 测文件锁：多写入请求串行执行，不并行覆盖同一目标文件。
- 测备份与恢复：导出 → 删除原目录 → 导入 → 数据完整性校验。

**集成测试**
- 端到端：来源版本 → 后台加工 → 审计写回 → 前端状态同步。
- 检索端到端：关键词 + 向量 + 标签混合召回 → MMR 重排 → 带来源结果 → 点击回写。
- 工具会话采集：来源目录 → 会话解析 → 稳定版本 → 候选生成 → 审计写回。

## 11. 已知偏差与待办事项

本章记录 AGENTS.md 与当前代码实现之间的已知 gap，以及计划中的修正方向。

### 11.1 文档与代码偏差

| 偏差项 | AGENTS.md 描述 | 实际代码 | 优先级 |
|--------|---------------|---------|--------|
| 队列存储路径 | `src/lib/storage/queue.ts`（第 4.6 节旧版描述） | 已修复：删除 `src/features/audit/queue.ts`（内存 Map），Auditor 统一使用 MemoryService SQLite 队列；dequeueEvent 事务化（悲观锁） | ~~P1~~ |
| 图谱存储方式 | 第 4.6 节仅描述 `graph_edges` SQLite 表 | 已修复：删除 `manager.ts` 和 `query.ts`，唯一路径为 `wiki-graph.ts` | ~~P2~~ |
| sortBy 参数 | 无约束 | 已修复：`SORTABLE_FIELDS` Set 白名单 | ~~P1~~ |
| memory/search 性能 | 无约束 | 已修复：`listMemories()` 调用处统一加 limit 约束（handler: 500, tool-registry: 200, orchestrator: 500） | ~~P1~~ |
| 文件锁实现 | 未描述实现细节 | 已修复：`fs.open(path, O_WRONLY \| O_CREAT \| O_EXCL)` 原子操作 | ~~P2~~ |
| 日志系统 | 未提及 | 已修复：核心链路（model-adapter, memory-service, orchestrator）迁移到 `logger` | ~~P3~~ |
| 测试覆盖 | 第 10 节定义了完整测试策略 | 已修复：LKA-001 Phase 1 为 52 个 Vitest 文件、486 passed / 0 skipped，另有 6 个 Playwright E2E 全部通过；新增 13 条真实 SQLite/文件系统特征测试，覆盖监听幂等、队列终态、进程恢复、冲突、关键词/向量/多路/图谱/MMR 检索和 HNSW 重建不修改 Markdown | ~~P2~~ |
| 工具结果分层 | 未定义 | 已修复：`ToolResult` 新增 `content` 字段（给模型读的自然语言），`data` 保持不变（给 UI/日志） | ~~P3~~ |
| 会话系统提示快照 | 持久化 system 消息 | 已修复：`ChatSessionService.appendSnapshot` 过滤 system 角色消息，恢复时由 Handler 重建 | ~~P2~~ |
| 聊天 UI 与记忆页面契约回归 | Phase 2 要求多会话 UI 已接入；第 4.9 节要求前端可检索并进入记忆详情 | 已修复：恢复 `/chat`、`ChatInterface` 与 `useChatSession`，首页快捷入口提供“开始对话”并保留顶部导航仅“首页 / 检索库 / 设置”三项；首页搜索统一读取 `data.results`，检索库统一读取 `data.items`；`/memory/[id]` 专用于记忆 ID，话题聚合迁至 `/memory/topic/[topic]` | ~~P0~~ |
| 提供商配置 | AI 配置仅前端表单 | 已修复：`src/config/providers.json` 声明式目录经 `provider-loader.ts` 做 Zod 校验和读写，`/api/config/ai` 返回 `providerCatalog`，设置页模型/供应商选项由目录驱动并有单测覆盖 | ~~P2~~ |
| docs 目录未纳入版本控制 | 第 2 节要求文档跟随实现，差异有记录 | 已修复：`.gitignore` 明确放行 `docs/specs/**`，规范文档可进入版本控制；`docs/` 下其他个人资料和 `docs-zh/.obsidian/workspace.json` 继续忽略 | ~~P2~~ |
| 降级状态恢复 | 第 4.11 节描述降级但未提恢复 | 已修复：`ModelAdapter.startHealthCheck()` 周期性轮询，恢复后自动退出降级；scheduler setInterval 类型修复 | ~~P1~~ |
| 记忆创建绕过审计 | 第 4.8 节要求先入队再审计 | 已修复：tool-registry 的 create_memory/update_memory 改为生成 PendingEvent 入队而非直接写库 | ~~P0~~ |
| MMR 重排 | 第 4.11 节"重排默认采用 MMR" | 已修复：`Ranker.rankWithMMR()` 实现真正的 MMR（α*score - (1-α)*max_sim），用 tags Jaccard 作为文档间相似度，α 默认 0.7；handler.ts 已切换到 rankWithMMR；保留 `rank()` 作为基础多因子加权排序供其他场景使用 | ~~P2~~ |
| reject 路径 | 第 4.10 节"不可合并：schema 版本不兼容、数据损坏或格式校验失败" | 已修复：`conflict-resolver.ts` 补全三种 reject 触发条件（candidate.version < existing.version / 必要字段为空 / tags|graphLinks 非数组），reject 优先级在字段比对前；Auditor 处理 reject 时 status=failed 并透传 reason | ~~P1~~ |
| 向量检索相似度阈值 | 无约束 | 已修复：`VectorRetriever.search` 新增 `minSimilarity` 参数（默认 0.3），过滤低相似度噪声；搜索 API 新增 `?threshold=` 查询参数 | ~~P1~~ |
| MCP 工具 execute | 未描述 | 已修复：`handler.ts collectToolDefs` 为 MCP 工具包装 execute 闭包调用 `mcpManager.callTool`，替代原先 `execute: undefined`（会导致模型调用卡住） | ~~P2~~ |
| 访问计数污染 | 第 4.8 节"搜索回写由前端搜索命中事件触发" | 已修复：`handler.ts retrieveRelevantMemories` 移除召回时的 `incrementAccess` 调用（召回 ≠ 访问），避免 heatScore 失真 | ~~P2~~ |
| MemoryRecord 国际化字段 | 第 5.1 节 `MemoryRecord` 类型未定义 | 已修复：`types/memory.ts` 补齐 `titleZh`/`summaryZh`/`tagsZh`/`topicZh` 四个可选字段；AGENTS.md 5.1 节类型定义同步更新；`validateMemoryRecord` 增加 zh 字段类型校验 | ~~P2~~ |
| validatePendingEvent sourceType 白名单 | 第 5.6 节 `sourceType` 含 `listen` | 已修复：`validator.ts` 的 `validatePendingEvent` 白名单补全 `listen`（共 6 种），与 `PendingEvent` 类型定义一致；`/api/listen` 入队事件校验恢复正常 | ~~P1~~ |
| validateVectorRecord 空数组放行 | 无约束 | 已修复：`validateVectorRecord` 改为 `!Array.isArray(record.embedding) || record.embedding.length === 0`，空数组不再放行 | ~~P3~~ |
| 访问计数回写入口 | 第 4.8 节"搜索回写由前端搜索命中事件触发" | 已修复：新增 `POST /api/memory/[id]/access` 端点，前端用户点击记忆时调用 `incrementAccess`；配合之前从 `retrieveRelevantMemories` 移除召回时递增的修复，访问计数现在有正确的回写路径 | ~~P2~~ |
| 预处理管线未接入主路径 | 第 4.6 节"输入归一化：`src/server/pipelines/*`"与《架构检查文档》4.3 "不要让原始输入直接进入索引和记忆" | 已修复：`Orchestrator.processIngest` 接入 `processJsonPipeline`，完成 formatMemoryContent 清洗 + detectDuplicates（分页全量扫描的 Jaccard 去重）+ splitText 长文拆包；重复内容抛 `MemoryValidationError` 拒绝入库，多 chunk 合并为 markdown 分段正文 | ~~P0~~ |
| 分类驱动路由未生效 | 第 4.14 节工具调用流程 + 《架构检查文档》4.4 "分类驱动路由" | 已修复：`ChatHandler.streamResponse` 调用 `ChatClassifier.classify` 对最近 user 消息做本地意图分类，结果注入 prompt 的"用户意图"块（零 LLM 开销），引导模型选择工具与回复风格 | ~~P0~~ |
| 置信度评分为硬编码常量 | 第 4.11 节"模型与检索约束"未约束置信度算法；《架构检查文档》4.4 要求区分"高可信事实"与"待确认推测" | 已修复：`ChatClassifier`/`MemoryClassifier` 改为 `score = min(0.95, 0.5 + 0.12*命中数 + 0.05*位置加分)`，区分多关键词命中（高可信）与单关键词命中（待确认） | ~~P1~~ |
| 审计可读文本缺失 | 第 4.10 节"冲突分级策略" + 《架构检查文档》4.7 "markdown 流式转码 + LLM 检查" | 已修复：`AuditReporter.generateMarkdownReport()` 生成按来源/话题分布 + 冲突清单 + 最近记忆的可读 Markdown；`Orchestrator.processQueue` 末尾自动落盘到 `archive/audits/audit-{timestamp}.md` | ~~P1~~ |
| ChatHandler 职责偏重 | Agent 循环负责检索、意图、提示词、流式输出 | 历史修复；LKA-001 Phase 5 已删除 ChatHandler、系统提示组装和对应测试 | ~~P3~~ |
| Orchestrator 审计报告 I/O 内联 | 审计持久化层应由服务拆分职责 | 已修复：审计报告落盘拆到 `src/server/services/audit-report-writer.ts`，`Orchestrator` 仅调度 `AuditReportWriter.write()`；新增独立单测覆盖路径、文件名与写入内容 | ~~P3~~ |
| 向量搜索后端固定 JS 实现 | Phase 3 规划升级原生向量索引 | 已修复：`VectorSearchBackend` 默认使用 USearch HNSW ANN；SQLite 版本触发器检测索引失配并自动重建，按 embedding 维度分图持久化；JS 精确搜索仅作 `VECTOR_BACKEND=js` 或初始化失败 fallback；测试覆盖增删改、持久化重载和自动重建 | ~~P3~~ |
| 画像回写无阈值 | 《架构检查文档》6.3 "回写震荡风险：自动更新 loop 如果太激进，会导致提示词频繁变化、标签漂移" | 已修复：`ProfileUpdater` 新增 `UPDATE_SIMILARITY_THRESHOLD=0.85`，新旧画像行级 Jaccard 相似度 ≥ 阈值时跳过回写，避免 `profile.md` 反复刷新导致 `PromptCache` 震荡 | ~~P2~~ |
| API schema 导出 | 第 4.6 节和第 6 节要求所有 route handler 导出请求体 schema、响应体 schema、错误码表 | 已修复：受 Next.js route module 导出限制，契约集中到 `src/config/api-route-contracts.ts`，为所有 API route 声明请求 schema（需 body 的路由）、响应 schema 与错误码表；`api-route-contracts.test.ts` 防止新增路由漏登记 | ~~P2~~ |
| 配置 API 请求体验证 | 当前阶段至少保证 Zod 请求体校验覆盖 | 已修复：`config/storage` POST/PATCH 与 `config/tool-sources` POST/PUT 统一使用 `validation.ts` 中的 Zod schema；工具源 PUT 字段与 `ToolWatchSource` 契约对齐，并补充错误类型、默认值、路径遍历和旧字段名测试 | ~~P1~~ |
| 存储路径硬编码 | 第 8 节"本地存储目录：使用 `memory-root/` 作为根目录"未支持运行时可配置 | 已修复：`path-resolver.ts` 改造为 `getDatabasePath()` 固定用 env（避免循环依赖），`getMemoryRoot()` 从 db storage_config 读取带缓存；新增 `StorageMigrationService`（停 watcher→复制→更新 config→invalidatePathCache→重启 watcher）；`/api/config/storage` API（GET/POST/PATCH 预览）；`StorageConfigForm` 前端组件 | ~~P1~~ |
| 本地工具对话无法采集 | 第 4.6.2 节仅描述 API 监听和书签抓取，无本地工具工作目录采集 | 已修复：新增 `ToolWatchSource` 类型 + `ConfigService` CRUD + `session-parser.ts`（Codex/Claude Code/Cursor/Markdown/Text 五种解析器，递归提取 content）+ `ToolDirWatcher`（多源 chokidar + mtime+size 去重）+ `/api/config/tool-sources` API + `ToolSourceList` 前端组件（预设快速添加） | ~~P1~~ |
| 用户画像无演化可视化 | 第 4.8 节"profile.md 由审计持久化层更新"但用户无法感知画像变化 | 已修复：`ProfileUpdater` 新增"学习中的领域"区块 + `profile-changelog.jsonl` 变更历史记录 + `getChangelog` 方法 + `/api/profile` API（GET 画像+历史 / POST 手动分析）+ `ProfilePanel` 前端组件（分区块展示 + 演化时间线）+ Navbar 加画像 tab | ~~P2~~ |
| 浏览器历史未采集 | 第 4.6 节外部能力接入未覆盖浏览器历史 | 已修复：新增 `history-collector.ts`（Chrome/Edge History SQLite copy+读取+Chrome 时间戳转换+域名分组 / Bookmarks JSON 解析+文件夹分组）+ `BrowserCollectScheduler`（历史 30min / 书签 6h，默认 `BROWSER_COLLECT_ENABLED=false` 关闭）+ instrumentation 启动 | ~~P3~~ |
| 文件监听与 `/api/listen` 重复写入 | 第 4.8 节要求候选先入待审计队列、最终文件只由审计持久化层写入 | 已修复：`/api/listen` 移除提前 Markdown 落盘，仅调用 `stageCreateMemory()`；审计新建沿用队列 `memoryId`；FileWatcher 按稳定 ID 区分 add/create 与 change/update，并增加外部文件修改集成测试 | ~~P0~~ |
| 本地服务监听安全 | 纯本地单机部署，不应默认暴露所有网卡 | 已修复：`dev`/`start` 显式绑定 `127.0.0.1`；API middleware 允许 localhost、IPv4/IPv6 loopback 与端口，拒绝非本机 Host 并返回统一错误结构；跨 Origin 的本机工具调用保持可用 | ~~P0~~ |
| 检索库与图谱路由语义 | `/memory` 应承担检索库职责，图谱应有唯一入口 | 已修复：`/memory` 提供列表、搜索、话题筛选、分页和详情/话题/图谱链接；`/memory/map` 统一由 `KnowledgeMap` + `MemoryMapViewport` 渲染，删除重复路由实现 | ~~P0~~ |
| `/api/listen` 错误响应契约 | 错误应使用 `{ success:false, error:{ code, message } }` | 已修复：非法 JSON、Zod 校验、大小超限和内部异常统一使用 `apiError`；内部异常客户端消息稳定且详细信息仅写 logger；桥接脚本兼容对象错误 | ~~P1~~ |
| 工程门禁与真实浏览器流程 | CI 仅覆盖 typecheck/lint/test/eval，缺少格式、覆盖率、构建和真实 E2E | 已修复：严格 Lint、Prettier、覆盖率阈值、production build、Playwright Chromium E2E 和隔离测试数据接入 CI；E2E 覆盖首页→聊天、检索库→详情、检索库→图谱、设置→工具监听和 listen 错误契约 | ~~P1~~ |
| 写入质量闸门 fail-open | 第 4.8 节仅要求候选入队审计，无质量判定语义；旧实现为单一 LLM PASS/FAIL 且降级/异常/API 失败时直接放行 | 已修复：`QualityFilterService` 重写为三态判定（`accept ≥7 分` / `reject <4 分` / `review 4-6 分`），闸门不可用转 `review` 人工裁决而非放行（fail-closed）；`PendingEvent.status` 新增 `rejected`（终拒不重试）与 `review`（待人工，不进重试循环）；质量 FAIL 不再进重试循环 | ~~P0~~ |
| 更新路径绕过质量闸门 | 旧实现仅新建记忆过质量闸门，update 事件 content 变更直接进审计 | 已修复：`Orchestrator` 更新分支在 `changedFields` 含 `content` 时同样执行向量去重 + 质量闸门（reject → rejected；review → warn 后继续审计 diff/冲突兜底） | ~~P1~~ |
| 多入口写入无语义去重 | 旧实现仅 ingest 入口有 Jaccard 快筛，chat/listen/tool 等入口无语义去重 | 已修复：`Orchestrator` 统一入口向量语义去重（`VectorIndex.search` cosine ≥ 0.95 判重 → rejected）；一次 embedding 召回 top-K 相似记忆同时服务去重与闸门新颖性上下文（≥0.6 才注入 prompt，省 token） | ~~P1~~ |
| review 无人工裁决出口 | 无 | 已修复：`Orchestrator.resolveReviewEvent(eventId, action)`（accept 跳闸门直接落盘，避免重新入队死循环；reject 终拒归档）+ `GET/POST /api/audit/review-events` 路由 + API 契约登记 | ~~P2~~ |
| 产品范围与 LKA-001 目标不一致 | `docs/specs/001-local-knowledge-agent/` 将产品收缩为本地知识整理 Agent，并明确删除聊天、画像、人格 Prompt 和聊天型 MCP/Skills | 已修复：Phase 5 删除范围外页面、API、运行时、scheduler 和依赖；首页改为来源状态、审核和检索入口，旧用户数据保持原位 | ~~P0~~ |
| Phase 5 与主题资料 API 契约顺序 | T5.8 要求增加主题学习资料契约，但 T6.1 才定义主题资料 schema，且当前没有对应路由 | 已澄清：Phase 5 只登记真实存在的来源状态路由并删除旧契约；主题资料 schema 与真实路由在 T6.1 同步登记，禁止预置 stale contract | ~~P1~~ |
| 来源版本、块身份与正式知识关系缺失 | LKA-001 FR-004、FR-006、FR-014、FR-015 要求可追溯和增量处理 | 已修复：新增 `source_versions`、`source_chunks`、`source_memory_links`；语义块哈希支持仅噪声变化无操作，发布/人工接受后建立来源关系，旧证据尽可能迁移 | ~~P0~~ |
| 主题学习资料尚未实现 | LKA-001 FR-013 至 FR-015 要求可阅读、可追溯且增量更新的主题资料 | 已修复：`StudyGuideBuilder` 以已接受知识确定性生成 `guides/{topic}.md`，可选模型只能调整标题和顺序；schema 拒绝非法引用，原子发布先验证临时文件，发布链路只刷新受影响主题 | ~~P0~~ |
| Phase 7 UI 未承载完整知识循环 | 状态、来源、检索、资料与审核页面必须展示同一来源/事件/知识契约 | 已修复：状态页展示来源健康、版本、进度与分项降级；来源设置支持完整 CRUD 与扫描；搜索返回分数和命中通道；主题页读取 StudyGuide；审核支持来源对照、原因和编辑后接受；桌面/移动端 Playwright 验收通过 | ~~P0~~ |

### 11.2 渐进式路线图

以下路线图记录原有通用记忆产品建设历史，Phase 0 至 Phase 5 已完成。新的范围收缩工作由 11.3 节的 LKA-001 路线图接管。

```text
Phase 0 — 工程健康 [DONE]
  [x] AGENTS.md 规范文档
  [x] TypeScript strict mode + vitest 基础设施
  [x] ErrorCode 枚举 + apiResponse/apiError 包装
  [x] AI SDK 版本适配（openai-provider.ts / tool-schemas.ts 修复）
  [x] 文件锁原子操作（O_EXCL）
  [x] sortBy 白名单校验

Phase 1 — 核心稳定 [DONE]
  [x] 设计原则清单化（7 条可验证架构约束）
  [x] 工具结果分层（ToolResult.content + data）
  [x] 会话系统提示重建（不持久化 system 消息）
  [x] 核心概念速览表
  [x] 提供商声明式配置（providers.json）
  [x] pending_events 持久化统一（auditor 用 SQLite 版替代内存 Map）
  [x] listMemories 分页查询（避免全量内存加载）
  [x] 图谱废弃代码清理（manager.ts）
  [x] 降级状态恢复（ModelAdapter 健康检查 + setInterval 类型修复）
  [x] 记忆创建绕过审计队列修复（tool create/update → PendingEvent 入队）
  [x] 功能 Bug 修复（MCP execute / 访问计数污染 / 向量相似度阈值）
  [x] MMR 重排实现（Ranker.rankWithMMR，tags Jaccard 文档间相似度）
  [x] reject 路径补全（schema 不兼容 / 数据损坏 / 格式校验失败）
  [x] 核心模块单元测试（builder/validator/differ/conflict-resolver/VectorIndex/Ranker/MemoryService/Auditor，112 用例）
  [x] validator 修复（PendingEvent 白名单补 listen / VectorRecord 空数组拦截 / MemoryRecord zh 字段校验）
  [x] 访问计数回写端点（POST /api/memory/[id]/access）
  [x] 存储路径热重载（path-resolver 改造 + StorageMigrationService + StorageConfigForm + /api/config/storage）
  [x] 本地工具采集（session-parser 五种解析器 + ToolDirWatcher + ToolSourceList + /api/config/tool-sources）
  [x] 用户画像演化可视化（画像加"学习中的领域"区块 + profile-changelog.jsonl + ProfilePanel + /api/profile）
  [x] 浏览器历史/书签采集（history-collector + BrowserCollectScheduler，默认关闭）
  [x] 文件监听幂等化（`/api/listen` 单一入队、稳定 memoryId、add/create + change/update、外部修改集成测试）

Phase 2 — 会话升级
  [x] localStorage → JSONL 文件持久化（服务端列表/恢复/删除 API + 最终 assistant 回复落盘 + 一次性旧数据迁移）
  [x] 多会话列表 + 切换（JSONL 为唯一真源，switchSession / removeSession UI 已接入）
  [x] 会话恢复系统提示重建（ChatHandler 已支持，system 消息不持久化）

Phase 3 — 智能增强
  [x] 会话上下文压缩（长对话旧消息压缩为稳定摘要块，保留最近上下文）
  [ ] 会话树形分支（从任意节点分支对话）
  [x] 向量检索升级为 USearch HNSW ANN（SQLite 版本触发器 + sidecar 持久化 + 自动重建 + JS fallback）

Phase 4 — 测试与质量
  [x] 快轨层测试（ChatHandler Agent 循环、降级路径、候选记忆生成）
  [x] 后台加工层测试（清洗去重、分类打分、全量去重扫描）
  [x] 审计持久化层测试（冲突分级、版本管理）
  [x] 集成测试（端到端：用户输入 → 快轨 → 审计 → 文件写回）

Phase 5 — 检索与质量收口 [DONE]
  [x] 多路召回（query-rewriter budget 改写 + query-expansion 合并去重，降级退回单路）
  [x] 注入改为 getMemoriesByIds 精确加载，移除 500 条全量拉取
  [x] 记忆纠错闭环（MemoryCorrectionService + correct_memory 工具 + memory_update 意图路由 + 记错/纠正关键词）
  [x] 检索评测集与指标（src/eval，Recall@k / MRR，npm run eval 出报告）
  [x] GitHub Actions CI（ubuntu + windows 基础检查；Ubuntu 独立 coverage/build/E2E job）
  [x] Prettier 格式门禁与 ESLint 0 warning
  [x] Lines 30% / Branches 70% / Functions 50% 覆盖率回退阈值
  [x] Playwright Chromium 真实 E2E（隔离 memory root/database）
  [x] usearch 字面量加载，生产构建无 Critical dependency warning
  [x] usearch 移至 optionalDependencies（CI 走 JS 精确后端）
  [x] 写入质量闸门三态化（QualityFilterService：accept/reject/review 分级评分，fail-closed，相似记忆注入新颖性上下文）
  [x] 全入口向量语义去重（cosine ≥ 0.95 判重，新建/更新路径统一，一次召回双重复用）
  [x] review 人工裁决出口（resolveReviewEvent + GET/POST /api/audit/review-events）
```

### 11.3 LKA-001 功能收缩路线图

详细规范位于 `docs/specs/001-local-knowledge-agent/`。Phase 3 至 Phase 7 已完成；当前进入 Phase 8 验证和作品集交付。

```text
Phase 0 — 确认范围和建立基线 [DONE]
  [x] 确认本地知识整理 Agent 的目标与非目标
  [x] 建立代码量、路由、依赖、测试和检索指标基线
  [x] 修复移动端会话恢复竞争和图谱 E2E 过期契约
  [x] format/typecheck/lint/test/eval/build/E2E 全部门禁通过

Phase 1 — 固定保留行为 [DONE]
  [x] 监听到队列的真实 SQLite 特征测试
  [x] 队列到发布的 accept/review/reject/failed/conflict/restart 测试
  [x] 关键词/向量/多路/图谱/MMR 检索测试
  [x] HNSW sidecar 重建不修改规范 Markdown 测试

Phase 2 — 显式 KnowledgeAgent 契约 [DONE]
  [x] SourceRevisionEvent TypeScript + Zod 契约与稳定来源/版本/事件 ID
  [x] SourceRegistry 持久化来源版本和健康状态
  [x] 文件、工具目录和 listen 统一输出来源版本事件
  [x] Agent 与 pending_events 集中状态迁移保护及中断恢复
  [x] 生产入口统一经 KnowledgeAgent，Orchestrator 降为内部兼容执行器
  [x] processing_attempts 类型化进度、结构化日志和状态查询
Phase 3 — 去噪和来源追踪 [DONE]
  [x] 去噪报告契约和确定性噪声分类统计
  [x] LLM/Embedding 远程请求前统一密钥脱敏
  [x] Markdown 章节、会话轮次优先的语义分块
  [x] 来源版本与块哈希持久化，仅噪声变化无操作
  [x] 发布知识与来源版本关系、Markdown 来源元数据及旧证据迁移
Phase 4 — 保留代码解耦 [DONE]
  [x] 排序与 heatScore 删除画像亲和度
  [x] path resolver / 存储迁移删除 PromptCache 依赖
  [x] KnowledgeModelAdapter 与聊天 AiEvent 契约分离
  [x] nightly 删除画像更新和聊天路由优化
  [x] KnowledgeConfigService 仅持久化 AI、存储和工具来源配置，旧集成数据非破坏保留
Phase 5 — 删除范围外功能 [DONE]
  [x] 删除聊天页面、API、Dispatcher、ChatHandler、AiEvent 流和会话持久化
  [x] 删除用户画像、人格 Prompt、聊天型 MCP/Skills 和浏览器历史采集
  [x] 首页替换为来源状态、审核队列、最近进度和快速检索
  [x] API 契约、依赖、单测和 E2E 同步收口，旧用户数据非破坏保留
Phase 6 — 主题学习资料生成 [DONE]
  [x] 主题资料 schema、Markdown 编解码与 `/api/topics/[topic]` 契约
  [x] 按标签和图谱关系生成确定性章节与完整知识/来源版本引用
  [x] 标准模型可选调整标题和顺序，非法引用回退确定性结果
  [x] 临时文件复验后的原子发布与内容哈希无变化跳过
  [x] 发布、删除、重建和冲突解决只刷新受影响主题
Phase 7 — 用户界面重构 [DONE]
  [x] 状态页展示来源健康、最近版本、事件结果、耗时和分项降级
  [x] 来源设置支持新增、编辑、停用、移除和手动扫描
  [x] 检索结果展示最终分数、主题、来源和命中通道
  [x] 主题资料页展示大纲、章节、知识链接和来源版本
  [x] 审核工作台支持候选/来源对照、原因、接受、编辑和拒绝
  [x] 桌面与移动端响应式、语义标签、焦点和横向溢出验收
Phase 8 — 验证和作品集交付
```

## 12. 本轮补充记录

- LKA-001 Phase 0 已完成：规范确认、Git 基线、代码规模报告、移动端 hydration 竞争修复、图谱 E2E 更新和全门禁验证；详细结果见 `docs/specs/001-local-knowledge-agent/phase-0-baseline.md`
- LKA-001 Phase 1 已完成：新增 13 条真实存储特征测试，并修复抽取卡覆盖原始 `sourceHash` 导致未变化文件重复入队的问题；详细结果见 `docs/specs/001-local-knowledge-agent/phase-1-characterization.md`
- LKA-001 Phase 2 已完成：新增统一来源版本、`SourceRegistry`、集中状态机、显式 `KnowledgeAgent` 与持久化进度，生产入口不再直接实例化 `Orchestrator`；详细结果见 `docs/specs/001-local-knowledge-agent/phase-2-knowledge-agent.md`
- LKA-001 Phase 3 已完成：新增可审计去噪、模型调用前密钥脱敏、语义分块、块级身份、来源版本与正式知识关系；详细结果见 `docs/specs/001-local-knowledge-agent/phase-3-noise-and-provenance.md`
- LKA-001 Phase 4 已完成：排序、路径、AI 契约、nightly 和配置持久化均已与待删除功能解耦；详细结果见 `docs/specs/001-local-knowledge-agent/phase-4-decoupling.md`
- LKA-001 Phase 5 已完成：删除范围外聊天、会话、画像、Prompt、MCP/Skills 和浏览器采集运行时，首页改为知识处理概览；详细结果见 `docs/specs/001-local-knowledge-agent/phase-5-scope-removal.md`
- LKA-001 Phase 6 已完成：新增带合法知识与来源版本引用的确定性主题资料生成、可选模型排序、原子发布和增量刷新；详细结果见 `docs/specs/001-local-knowledge-agent/phase-6-study-guides.md`
- LKA-001 Phase 7 已完成：状态、来源、检索、资料阅读和审核界面统一到来源事件契约，并完成桌面/移动端可访问性验收；详细结果见 `docs/specs/001-local-knowledge-agent/phase-7-user-interface.md`

- 历史 ChatHandler 系统提示拆分已随 LKA-001 Phase 5 范围收缩删除
- 已完成审计报告写入拆分：`src/server/services/audit-report-writer.ts`
- 已完成向量搜索后端抽象：`src/lib/vector/backend.ts`
- 已完成提供商目录化配置：`providers.json` + `provider-loader.ts` + 设置页动态选项
- 已完成 API 契约集中登记：`src/config/api-route-contracts.ts`
- 历史长对话上下文压缩已随 LKA-001 Phase 5 范围收缩删除
- 已完成分类/重排阈值常量化：`src/config/constants.ts`
- 已完成去重扫描从固定最近 200 条扩展为分页全量内容扫描
- 已完成 nightly 降级保护：模型降级时跳过矛盾精判、wikilink 智能补充、路由优化和旗舰画像更新
- 已完成 WikiGraph 增量更新清理：文件变更/删除时移除旧节点关系，避免脏边残留
- 已完成多路召回：`query-rewriter.ts`（budget 改写，降级退回空变体）+ `query-expansion.ts`（多路合并取最高相似度）
- 已完成注入精确加载：`handler.ts retrieveRelevantMemories` 用 `getMemoriesByIds` 替代 `listMemories({limit:500})`
- 已完成记忆纠错闭环：`src/lib/memory/correction.ts` + `correct_memory` 工具 + `memory_update` 意图接入纠错
- 已完成检索评测：`src/eval/`（fixtures/metrics/retrieval-eval），Recall@k / MRR 回归基线 + 报告
- 已完成 GitHub Actions CI：`.github/workflows/ci.yml`（typecheck + lint + test + eval，ubuntu/windows）
- usearch 移至 `optionalDependencies`：CI 不装原生 usearch，向量检索走 JS 精确后端
- 新增/更新测试：`chat-system-prompt.test.ts`、`audit-report-writer.test.ts`、`vector-backend.test.ts`、`provider-loader.test.ts`、`api-route-contracts.test.ts`、`conversation-compressor.test.ts`、`ai-config-form.test.tsx`、`query-rewriter.test.ts`、`query-expansion.test.ts`、`memory-correction.test.ts`、`eval-metrics.test.ts`、`retrieval-eval.test.ts`
- 已恢复聊天与多会话能力：`/chat`、`ChatInterface`、`useChatSession`、消息输入/展示/模式选择组件重新接入现有 Agent 事件流与 JSONL 会话 API；顶部导航按既有 UI 设计继续保持“首页 / 检索库 / 设置”三项，不展示对话入口
- 已修复记忆浏览契约与路由语义：新增 `memory-api-client.ts` 统一消费 `data.items` / `data.results`；单条记忆使用 `/memory/[id]`，话题聚合使用 `/memory/topic/[topic]`
- 新增回归测试：`memory-api-client.test.ts`、`chat-ui-restoration.test.tsx`
- 已收紧本地安全边界：默认 `dev`/`start` 绑定 `127.0.0.1`，middleware 拒绝非本机 Host；本机跨 Origin 工具调用保持可用
- 已恢复检索库语义：`/memory` 提供列表/搜索/话题筛选/分页，`/memory/map` 使用唯一的 `KnowledgeMap` 实现
- Phase 5 已将首页快捷入口替换为来源设置、审核队列、检索库和知识图谱
- 已统一 `/api/listen` 错误契约，并让 `public/bridge/capture.js` 读取对象错误中的 `message`
- 已加入 Vitest 临时 memory root、覆盖率阈值和 Playwright 隔离 seed；真实浏览器覆盖 5 条关键流程
- 已完成写入质量闸门三态化：`QualityFilterService` 输出 `{verdict: accept|reject|review, score, reason}`，LLM 0-10 分级评分（≥7 入库 / 4-6 人工 / <4 拒绝），降级/解析失败重试后/API 异常统一转 `review`（fail-closed）；prompt 注入库内相似记忆（top-K，≥0.6）供新颖性比对
- 已完成全入口向量语义去重：`Orchestrator.recallSimilarMemories` 一次 embedding + `VectorIndex.search`，cosine ≥ 0.95 → `rejected`；`recallSimilarMemories` + `commitNewMemory` 抽取复用，更新路径 content 变更同样过闸门
- 已完成人工裁决出口：`Orchestrator.resolveReviewEvent`（accept 跳闸门落盘防死循环 / reject 终拒）+ `/api/audit/review-events` 路由；`MemoryService` 新增 `getEvent` / `getEventsByStatus`
- `PendingEvent.status` 扩展 `rejected` / `review`：终拒不重试，review 不被自动消费；`retryFailedEvents` 仅重置 `failed`
- 已完成更新并入框架级融合：`MemoryCorrectionService` 改写 prompt 要求把新信息纳入记忆的知识框架（按主题逻辑归位重组、重复表述合并成更完整说法、读起来像一开始就是这么写的，禁止末尾追加孤立补充段、不遗漏原有信息、同步更新 summary）；`update_memory` 工具描述同步引导模型框架级融合 content
- 已完成融合硬校验（非提示词的程序化保障）：`isAppendLikeRewrite` 结构判定——改写结果归一化空白后若以原文为严格前缀（且确有改动）即判为"末尾追加式"，拒绝并注入 `APPEND_REJECT_FEEDBACK` 重试一次，仍追加则改写失败不入队；改错字等开头重组场景不误判
- 新增/更新测试：`quality-filter-service.test.ts`（10 用例三态协议）、`orchestrator.test.ts`（reject/review/去重/提示注入/resolveReviewEvent）、`memory-correction.test.ts`（框架级融合 prompt 契约 + 追加式硬校验）、`api-route-contracts.test.ts` 登记 review-events 路由
- 当前测试总量：44 个测试文件，429 passed / 0 skipped（共 429 用例）
- 已修复知识地图三症状：①清理库内 5 条写入时编码丢失（中文全 `?`）的测试脏数据（memories/vector_records 归零）；②topic 页对已解码路由参数二次 `decodeURIComponent` 遇裸 `%` 抛 URIError 致知识点打不开，已去掉二次解码并新增 loadError + 重试按钮（不再吞错误）；③悬停乱码为库内坏数据非渲染问题，另修复 `KnowledgeMap` label 首字符大写与超长截断的代理对安全问题（`Array.from` 按码点处理）
- 已按用户期望重构 `/memory/topic/[topic]` 布局为"左目录右阅读"：左栏"← 退出到上一级"（/memory/map）+ 文章目录（序号徽章、单篇删除）+ 底部统计；右侧单篇阅读视图（标题/分类/标签/正文、删除本文、上一篇/下一篇切换）
- 已补齐人工裁决 UI：AuditPanel 新增「人工裁决」tab，消费 `/api/audit/review-events`（GET 列表 + POST accept/reject），展示候选摘要/标签/重试次数，review 事件不再只能 curl 裁决
- 已补齐监听状态可见性：新增 `GET /api/config/tool-sources/status`（fileWatcher 运行状态 + toolWatcher 配置/活跃计数 + pending/review/failed 事件计数），`file-watcher.ts` 新增 `getFileWatcherStatus` 导出；`/settings/tools` 顶部新增运行状态面板，review>0 时给出审计页跳转链接
- 已新增 Trae 记忆目录预设（`TOOL_PRESETS.trae`：markdown 类型、`~/.trae-cn/memory`、`**/*.md`），设置页可一键快速添加
- 已支持 Embedding 独立凭证：`EmbeddingConfig` 新增可选 `apiKey`/`baseURL`（留空回落共享顶层配置），回落逻辑落地于 `openai-provider.generateEmbedding`、`provider.createEmbeddingModel`（anthropic 特判放宽为"有 embedding 专属 baseURL 则放行"）、`model-adapter.generateEmbedding` 空 key 判断与健康检查；`/api/config/ai` GET 对 embedding.apiKey 脱敏、POST 用 `resolveMaskedKey` 回填；`aiConfigSchema` 增加对应可选字段；设置页 Embedding 区块新增"Embedding API Key / Base URL（可选）"输入
- `providers.json` 新增 `zhipu`（`https://open.bigmodel.cn/api/paas/v4`：glm-4.5 / glm-4.5-flash / embedding-3 2048 维）与 `moonshot`（`https://api.moonshot.cn/v1`：kimi-k2-0905-preview / moonshot-v1-8k，无 embedding 模型）条目，设置页提供商下拉自动出现
- 已完成派生存储解耦（SQLite 真源原则落地）：`Orchestrator.syncDerivedStores` 统一承载 Markdown / Agent.md / 索引同步，每个派生任务独立 catch（记日志 + `createFailureRecord` 归档，不向上抛）；新建路径与 auto_merge 路径中 `classifyMemory` 失败同样不阻塞事件完成。派生失败不再把已入库事件整条打成 failed（避免 retryFailedEvents 错误改走更新+审计路径）；冲突解决路径 `syncResolvedMemory` 刻意保持同步感知不动；`commitNewMemory`/auto_merge 去掉 `getMemory()!` 非空断言（读取为空时用 candidate 兜底或跳过派生同步并记日志）。`orchestrator.test.ts` 新增 2 用例（写 Markdown 抛错 → 事件仍 done + 归档失败记录；classifyMemory 抛错 → 事件仍 done），全量 431 passed
- 已完成质量闭环四项改造（写入前流程控制 → 内容可信度分层）：
  - **embedding 失败 fail-closed**：`recallSimilarMemories` 返回 `SimilarHit[] | null`（降级/空 content/异常 → null）；新建路径 null 时事件转 review + `vector-recall` 失败归档（不再静默放行绕过语义去重）；更新路径 null 时记 warn 跳过语义去重与相似提示，继续走审计兜底（diff/冲突检测）
  - **更新审核收紧**：更新内容过闸门 verdict=review 时置 `updateQualityReview` 标志，Auditor 即使返回 auto_merge 也不写回——按 changedFields（过滤 version/id/createdAt/updatedAt）逐字段对比 candidate vs existing 生成冲突记录（人工裁决"这次更新想改什么"），事件转 done，由 `conflict_records.status='pending'` 承载待裁决
  - **kind 记忆类型**：`MemoryRecord` 新增 `kind: fact | inference | hypothesis | insight`（默认 fact），质量闸门 LLM 顺带判定输出；非 fact 一律强制转 review 进待验证区，accept 后回填 `candidate.kind`；frontmatter 平铺 `kind:` 键序列化/解析（markdown-formatter / markdown-parser 同步支持）
  - **证据校验入口分层**：`MemoryRecord` 新增 `evidence?: { text, location? }`；`EVIDENCE_REQUIRED_SOURCE_TYPES = ["ingest", "listen"]` 白名单内入口的 fact 缺 evidence 强制转 review（reason 提示补证据），manual/chat 等不强制避免 review 积压；tool-dir-watcher / listen 路由 / file-watcher 回退路径自动填充证据（内容片段 + 来源位置），frontmatter 平铺 `evidenceText:` / `evidenceLocation:` 键
- 新增/更新测试：`orchestrator.test.ts`（fail-closed 转人工、更新禁 auto_merge 逐字段冲突、更新路径降级跳过去重正常写回）、`quality-filter-service.test.ts`（17 用例：kind 四类强制 review、kind 非法值兜底 fact、白名单内无证据 review / 白名单外放行、证据注入 prompt 断言）、`listen-api.integration.test.ts`（断言对齐 stageCreateMemory 10 参签名）
- 当前测试总量：44 个测试文件，441 passed / 0 skipped（共 441 用例）；tsc src 零错误
- 已修复 `/settings/ai` 假页面问题：原页面为旧演示实现（仅存 localStorage、保存/连接测试均为模拟、Embedding 区块缺独立 Key/URL 字段），与真实后端完全脱节——此前"Embedding 独立凭证"功能只存在于未被任何路由引用的 `SettingsPanel`（死代码）。现改为与其他设置子页（mcp/tools/storage）一致的真实现：加载 `GET /api/config/ai`（脱敏 key + providerCatalog）→ 渲染 `AiConfigForm`（提供商目录下拉、模型分层、Embedding 独立 API Key/Base URL、真实连接测试 `/api/config/ai/test`）→ `POST /api/config/ai` 保存（服务端 resolveMaskedKey 回填脱敏 key）。适用于"主配置走 GLM Coding Plan 中转（无 embedding 模型）+ Embedding 填智谱正式 Key/BaseURL + embedding-3"的组合场景
- 已修复 `loadProviderCatalog` 打包路径 bug：`DEFAULT_PATH` 原用 `path.join(__dirname, "providers.json")`，Next.js 打包后 `__dirname` 指向 `.next/server/app/api/config/ai/` 导致 `GET /api/config/ai` ENOENT 500（此前未暴露是因为 SettingsPanel 从未被真实挂载、单测不经过打包）；改为 `path.join(process.cwd(), "src", "config", "providers.json")`（dev/start 均以项目根为 cwd），线上接口实测 200 且 providerCatalog 完整返回
- 已按用户要求清空 `providers.json` 预设目录（原 openai/custom-proxy/zhipu/moonshot 为示例数据，用户实际使用自定义中转站，预设反而干扰且选中会覆盖手填 baseURL）：`"providers": {}` 后下拉仅剩 OpenAI/OpenAI Compatible/Anthropic/Custom 四个通用选项，`buildProviderSelectionPatch` 对无目录条目的提供商只改 provider 字段不覆盖 baseURL/模型，所有字段纯手填；模型名输入框本就是自由文本，可填中转站任意模型。注意 providers.json 是运行时 fs 读取 + 模块级缓存，改文件后需重启 dev server 才生效
- 已完成工具监听自动采集闭环（用户实际环境验证）：
  - **修复 `~` 路径静默失效**：chokidar/fs 在 Windows 不识别 `~` 前缀且 watch 不存在路径不抛错，preset 配置的监听源全部无效；`startSingleSource` 现用 `homedir()` 展开后再 watch
  - **新增 trae 解析类型**：`ToolType` 扩展 `"trae"`，`parseTrae` 解析 `~/.trae-cn/memory/projects/` 下 session_memory_*.jsonl（每行结构化摘要 `{intent, actions[], outcome, learned[], message_summary_time}`），渲染为 LLM 友好中文 Markdown（意图/动作/结果/经验/时间分区），title 取首条 intent 前 40 字；validation z.enum、tool-presets（`~/.trae-cn/memory` + `**/*.jsonl`）、ToolSourceList 标签同步
  - **实测采集**：本机三源全部生效——Codex CLI（`~/.codex/sessions`，102 条）、Trae 会话记忆（jsonl 结构化摘要，54 条）、Trae 记忆笔记（topics.md 等记忆文档，markdown 类型，42 条），pending_events 共 241 条待审计流水线消费
  - 已知行为：dev server 重启后 processedFiles 内存去重清空，历史文件重新入队，靠 Orchestrator 向量语义去重（cosine ≥ 0.95）兜底
- 新增测试：`session-parser.test.ts`（parseTrae 中文 Markdown 渲染 + 无 intent 回退文件名）；修正 `config-api-validation.test.ts` providerCatalog 断言（providers.json 已置空，改断言目录结构契约）
- 当前测试总量：45 个测试文件，443 passed / 0 skipped（共 443 用例）；tsc src 零错误
