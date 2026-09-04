# Auto-Memories-Doll

**持续监听本地资料和开发工具会话，把含噪内容整理成可审核、可追溯、可直接检索的 Markdown 知识。**

[English](#english) · [快速开始](#快速开始) · [功能](#功能) · [架构](#架构) · [开发](#开发)

---

## 为什么需要这个

开发者的技术笔记、调试记录和工具会话分散在不同目录，混有重复日志、临时方案和不完整片段，普通文件搜索很难再次找到真正有用的内容。

Auto-Memories-Doll 做的事情很简单：

```
本地文件 / 开发工具会话 / Listen API
        ↓ 来源版本与归一化
  去重、提取、分类、质量评价
        ↓ 审核后发布
  带来源引用的 Markdown 知识
        ↓
  检索库 / 主题 / 图谱直接阅读
```

不是黑盒数据库，不是云端的 API。你的知识就是一个个 Markdown 文件，存在你自己电脑上，用任何编辑器都能打开看。

## 适合谁

- **学生** — 把课程笔记和工具会话整理成按话题分类的知识库
- **开发者** — 自动归档编程助手会话与技术文档，检索过去的解法
- **知识工作者** — 汇总散落在本地目录和开发工具中的资料，并保留来源

## 快速开始

### 前置要求

- Node.js >= 22
- 一个 AI API Key（支持 OpenAI 兼容接口：智谱 GLM、DeepSeek、OpenAI 等）

### 三步启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，至少填入 MODEL_API_KEY

# 3. 启动
npm run dev
```

打开 `http://localhost:3000`，查看来源处理状态、审核队列并检索知识。

应用默认只绑定本机 `127.0.0.1`，API 也会拒绝非本机 Host 请求。远程或局域网暴露当前不受支持，请不要把启动参数改为 `0.0.0.0` 后直接公开使用；本机工具应通过 `localhost` 或 `127.0.0.1` 调用 API。

### 环境变量示例

```env
# 用智谱 GLM（新用户有免费额度）
MODEL_BASE_URL=https://open.bigmodel.cn/api/paas/v4
MODEL_API_KEY=你的key
FLAGSHIP_MODEL=glm-5.2
STANDARD_MODEL=glm-4-flash
BUDGET_MODEL=glm-4-flash
EMBEDDING_MODEL=embedding-3

# 或用 DeepSeek
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_API_KEY=你的key
FLAGSHIP_MODEL=deepseek-chat
```

## 功能

### 自动采集：统一来源版本

| 来源                         | 怎么接             | 说明                     |
| ---------------------------- | ------------------ | ------------------------ |
| Trae IDE / 浏览器 AI         | `POST /api/listen` | 结构化会话推送           |
| Cursor / Codex / Claude Code | 设置里添加目录监听 | 自动解析会话文件         |
| 本地 Markdown / Text         | 配置来源目录       | 文件变化后生成稳定 revision |

### 自动归类：7 个话题分类

对话内容会先用规则生成候选话题，再由 `standard` 中级模型从合法话题白名单里复核，避免只靠关键词把“React 项目会议纪要”这类内容误塞进 AI 编程目录。模型不可用、输出非法或返回未知目录时，会回退到规则结果；低置信度结果进入 `uncategorized`。

| 话题     | 举例                        |
| -------- | --------------------------- |
| AI 编程  | 代码、React、API、bug、算法 |
| 学习笔记 | 学习、教程、笔记、总结      |
| 项目规划 | 项目、需求、架构、roadmap   |
| 日常记录 | 日记、今天、心情            |
| 会议记录 | 会议、讨论、决策            |
| 阅读摘录 | 论文、书籍、paper           |
| 灵感想法 | 想法、灵感、brainstorm      |

归类结果就是文件夹：`notes/ai-coding/`、`notes/learning/`……你可以直接打开看。

### 自动整理：摘要、标签、关联

每条记忆自动生成：

- **标题和摘要** — 从对话中提取关键信息
- **标签** — 自动提取 `#tag`、`@tag`、`[tag]`
- **知识关联** — 通过 `[[wikilink]]` 建立记忆之间的关系
- **热度评分** — 常访问的、最近更新的笔记排在前面

### 混合检索：直接查阅知识

用户在首页或检索库提交查询后，系统自动：

1. 多路召回：原句 + 改写变体并行检索（改写失败自动退回单路）
2. 用向量搜索找到语义相关的记忆
3. 用 MMR 重排保证多样性（不召回一堆相似内容）
4. 按命中的记忆 ID 精确加载，通过图谱扩展找到关联知识
5. 展示主题、来源和相关度，直接打开知识详情

### 审计安全：不会意外覆盖你的笔记

所有记忆写入都经过审计队列：

- 候选内容先排队，不直接写入
- 合并新内容前会先检查旧记忆卡片；如果旧卡存在乱码、英文残留、Markdown 格式不当或叙述不通顺，会先入队生成“旧记忆优化”事件，等旧卡清理通过审计后再继续合并新记忆
- 自动检测冲突（新旧内容矛盾时不盲目覆盖）
- 前端审计面板让你决定接受还是保留原版

### 降级保护

- LLM 不可用 → 依赖模型的候选转入人工审核
- Embedding 不可用 → 降级为关键词搜索
- 恢复后自动退出降级，前端全程可见状态

## 接入外部工具

### 通过 API 推送对话

```bash
curl -X POST http://localhost:3000/api/listen \
  -H "Content-Type: application/json" \
  -d '{
    "source": "trae-ide",
    "messages": [
      {"role": "user", "content": "帮我实现快速排序"},
      {"role": "assistant", "content": "这是快速排序的实现..."}
    ],
    "metadata": {"platform": "Trae IDE", "model": "claude-sonnet"}
  }'
```

返回自动归类的话题、生成的摘要和标签。

请求失败时统一返回以下结构，`error.code` 可用于调用方区分错误类型：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "具体错误"
  }
}
```

### 监听本地工具目录

在设置页面（`/settings/tools`）添加 Cursor、Codex CLI 或 Claude Code 的工作目录，新会话文件自动解析导入。

### 浏览器书签脚本

`public/bridge/capture.js` 可作为浏览器书签，一键捕获当前 AI 聊天页面并推送。

## 存储结构

```
memory-root/
├── memory.db              # SQLite（向量索引、审计队列、冲突记录）
├── notes/                 # 笔记（按话题分目录）
│   ├── ai-coding/
│   │   ├── Agent.md       # 该话题的摘要
│   │   └── note-*.md      # 具体笔记（YAML frontmatter + 正文）
│   ├── learning/
│   └── project-planning/
└── archive/               # 归档和历史版本
```

笔记是纯 Markdown 文件。你可以用 VS Code、Obsidian、甚至记事本打开编辑。

## 架构

最终版交互式结构图：

[打开知识库更新架构图](结构图/knowledge-architecture.architecture.html)

![Auto-Memories-Doll 知识库更新架构图](结构图/knowledge-architecture.architecture.visual-check.1440x900.light.png)

系统按“来源入口 → KnowledgeAgent → 审计发布 → 主存储/派生索引”组织。候选知识不会直接写入长期知识库，而是先进入待审计队列，再经过质量判断、人工复核和差异审计：

```
来源版本 → 解析与归一化
         → 候选知识入待审计队列
         → 中级模型话题复核（白名单约束，失败回退规则）
         → 质量闸门（accept / review / reject）
         → 旧记忆卫生检查（乱码 / 英文残留 / 格式 / 表达）
         → 人工复核与冲突裁决
         → Orchestrator + Auditor 差异比对
         → Markdown 真源写回 → Vector / Graph 派生索引刷新
```

| 层           | 职责                                                               | 关键模块                                                                                     |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 入口层       | 来源配置、文件/工具会话监听、人工导入、审核和检索                  | `src/app/`, `src/server/watchers/`, `src/app/api/`                                           |
| Agent 编排   | 来源版本、阶段迁移、候选入队、恢复和进度记录                       | `src/server/services/knowledge-agent.ts`, `src/lib/source/`                                    |
| 后台加工层   | 清洗、分类、去重、结构化和待审计事件生成                           | `src/features/ingest/`, `src/server/pipelines/`, `MemoryService`                             |
| 话题复核     | 用 `standard` 模型复核候选话题，只允许选择白名单目录，失败回退规则 | `src/server/services/topic-classification-service.ts`, `src/server/services/orchestrator.ts` |
| 质量闸门     | 按规则将候选分为接受、人工复核或拒绝                               | `src/server/services/quality-filter-service.ts`                                               |
| 人工复核     | 处理 review 事件、冲突和人工裁决                                   | `src/features/audit/`, `src/components/audit/`, `src/app/api/audit/`                           |
| 审计中枢     | 差异比对、版本校验、写回调度和失败重试                             | `src/server/services/orchestrator.ts`, `src/server/workers/audit-worker.ts`                  |
| 主存储真源   | 保存 Markdown LLMWiki、SQLite 队列、版本和冲突记录                 | `memory-root/`, `src/lib/storage/`                                                           |
| 派生检索索引 | 从真源重建向量 ANN、关键词和 wikilink 图谱索引                     | `src/lib/vector/`, `src/lib/graph/`                                                          |

技术栈：TypeScript / Next.js 14 / React 18 / Vercel AI SDK / SQLite / HNSW 向量索引 / Tailwind CSS

## 开发

```bash
npm run typecheck    # 类型检查
npm run lint         # 严格 Lint（0 warning）
npm test             # 运行单元/集成测试（49 文件，438 用例）
npm run test:coverage # 覆盖率门禁（Lines 30% / Branches 70% / Functions 50%）
npm run eval         # 检索评测（Recall@k / MRR 报告）
npm run format:check # 格式检查
npm run format       # 格式化代码
npm run build        # 生产构建
npm run test:e2e     # 真实浏览器门禁（需先安装 Chromium）
```

Playwright E2E 使用 `e2e/.tmp/` 下的隔离 memory root 和数据库，测试结束后不会读取或写入真实 `memory-root/`。首次运行可执行 `npx playwright install chromium` 安装本地测试浏览器。

## 项目状态

个人学习项目，v0.1 阶段。核心链路已跑通，持续改进中。

**已完成：** KnowledgeAgent 来源循环 · 审计发布管线 · HNSW 向量检索 · 关键词降级 · MMR 重排 · 多路召回 · 检索评测（Recall@k/MRR）· 多源采集 · 降级恢复 · loopback 安全边界 · 真实 Playwright E2E · 438 个测试用例

**计划中：** 去噪与来源追踪 · 主题学习资料生成 · 页面信息架构收口 · 评测集扩充

## License

MIT

---

<a id="english"></a>

## English

**Auto-Memories-Doll** is a local-first knowledge organization agent that watches local files and development-tool sessions, then turns noisy source material into reviewable, traceable Markdown knowledge.

### The Problem

Technical notes, debugging logs, and tool sessions are scattered across local directories and are difficult to reuse with ordinary file search.

### What It Does

- **Auto-captures** Markdown, text, Codex, Cursor, Claude Code, and typed listener input
- **Auto-categorizes** into 7 topic directories (coding, learning, planning, daily notes, meetings, reading, ideas)
- **Auto-organizes** with summaries, tags, heat scores, and knowledge graph links
- **Auto-retrieves** relevant memories via HNSW vector search + MMR diversity reranking
- **Human-readable** — all notes are plain Markdown files on your disk

### Quick Start

```bash
git clone https://github.com/your-username/Auto-Memeries-Doll.git
cd Auto-Memeries-Doll
npm install
cp .env.example .env.local   # Add your API key
npm run dev
```

Open `http://localhost:3000` to inspect processing status, review candidates, and search knowledge.

### Key Features

- Stable source revisions across API, tool-directory, and file watchers
- 7 auto topic categories with customizable rules
- HNSW vector search with keyword fallback
- Audit queue with conflict detection (never overwrites your notes accidentally)
- Graceful degradation when API is unavailable
- All data stored locally as Markdown + SQLite
