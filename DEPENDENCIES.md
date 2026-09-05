# 依赖说明

## 运行依赖

| 包 | 职责 |
| --- | --- |
| `next`, `react`, `react-dom` | 本地状态、来源、审核、检索与阅读界面 |
| `ai` | 非流式结构化生成与 Embedding 调用 |
| `@ai-sdk/openai`, `@ai-sdk/anthropic` | 声明式模型提供商适配 |
| `better-sqlite3` | 来源版本、队列、冲突、配置和向量真源 |
| `chokidar` | Markdown、文本和开发工具目录监听 |
| `zod` | API、来源、主题资料和模型输出校验 |
| `typescript` 与 React/Node 类型包 | TypeScript 编译及类型契约 |

`usearch` 是可选依赖：可用时提供 HNSW ANN；不可用、损坏或版本不一致时系统使用 JavaScript 精确余弦后端。

## 开发依赖

Vitest 与 V8 coverage 负责单元、集成和覆盖率门禁；Playwright 负责真实 Chromium 主流程；ESLint、Prettier 与 TypeScript 负责静态门禁；Tailwind CSS、PostCSS 和 Autoprefixer 负责样式构建。

## 依赖边界

- 核心 `src/features/` 与 `src/lib/` 不得引入 React 或 Next.js Route Handler。
- 生产依赖必须能从运行时入口到达；`npm run audit:dead-code` 检查本地模块可达性。
- 原生 `usearch` 不得成为 CI 和关键词降级的硬依赖。
- 新提供商优先通过 `src/config/providers.json` 注册，不为单个端点增加业务分支。
