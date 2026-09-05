# LKA-001 Phase 8 架构图

```mermaid
flowchart TB
  subgraph Entry[入口与观察]
    UI[Next.js 状态 / 来源 / 审核 / 检索 UI]
    FS[Markdown / Text]
    TOOL[Codex / Claude Code / Cursor / Trae]
    API[Listen API]
    REG[(SourceRegistry)]
    FS --> REG
    TOOL --> REG
    API --> REG
  end

  subgraph Agent[KnowledgeAgent 循环]
    REV[SourceRevisionEvent]
    PARSE[解析 / 去噪 / 语义分块]
    QUEUE[(pending_events)]
    DECIDE{去重与质量评价}
    PROGRESS[(AgentProgressEvent)]
    REG --> REV --> PARSE --> QUEUE --> DECIDE
    REV --> PROGRESS
    DECIDE --> PROGRESS
  end

  subgraph Audit[审计与发布]
    REVIEW[人工审核 / 冲突裁决]
    REJECT[rejected]
    PUBLISH[Orchestrator + Auditor]
    DECIDE -->|review| REVIEW
    DECIDE -->|reject| REJECT
    DECIDE -->|accept| PUBLISH
    REVIEW -->|接受或编辑后接受| PUBLISH
    REVIEW -->|拒绝| REJECT
  end

  subgraph Storage[规范数据与可重建派生层]
    MD[Markdown 知识真源]
    SQL[(SQLite 来源 / 队列 / 向量真源)]
    GUIDE[带引用的主题学习资料]
    ANN[USearch HNSW / JS exact]
    GRAPH[Wikilink 图谱]
    PUBLISH --> MD
    PUBLISH --> SQL
    MD --> GUIDE
    MD --> GRAPH
    SQL --> ANN
  end

  subgraph Retrieval[检索与阅读]
    EXPAND[原句 + 可选查询改写]
    MERGE[关键词 / 向量 / 标签 / 图谱合并]
    MMR[MMR 重排]
    READ[知识详情 / 主题资料 / 来源版本]
    UI --> EXPAND --> MERGE --> MMR --> READ
    ANN --> MERGE
    GRAPH --> MERGE
    GUIDE --> READ
    MD --> READ
  end

  MODEL[KnowledgeModelAdapter\n可选远程 LLM / Embedding]
  PARSE -. 脱敏后结构化生成 .-> MODEL
  DECIDE -. fail-closed .-> MODEL
  EXPAND -. 失败退回原句 .-> MODEL
```

## 边界

- 核心模块不依赖 React 或 Next.js Route Handler。
- `SourceRevisionEvent` 是采集入口契约，`AgentProgressEvent` 是可观察性契约。
- 未经接受的候选只存在于 SQLite 队列，不写入规范 Markdown。
- Markdown 和 SQLite `vector_records` 是重建依据；HNSW 与内存图谱可以丢弃后重建。
- 远程模型是可选增强，故障不会阻止本地阅读和关键词检索。
