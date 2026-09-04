# Phase 5 范围外功能删除报告

| 字段     | 内容                                                |
| -------- | --------------------------------------------------- |
| 规范编号 | `LKA-001`                                           |
| 阶段     | Phase 5：删除范围外功能                             |
| 状态     | 已完成                                              |
| 日期     | 2026-09-04                                          |
| 数据策略 | 删除运行时代码，不删除既有 JSONL、profile 或旧配置表 |

## 1. 产品入口

首页已从聊天入口替换为知识处理概览，直接展示来源数量、监听状态、待处理/待审核数量、最近处理阶段和快速检索。主导航现在只保留首页、检索库、审核和设置；设置只保留 AI、存储与来源监听。

## 2. 删除范围

- 删除聊天页面、组件、API、`AgentDispatcher`、`ChatHandler`、聊天分类/提示组装及流式 `AiEvent` 适配层。
- 删除聊天会话 JSONL 运行时与迁移 UI，但不扫描或删除用户已有会话文件。
- 删除画像 updater、页面、API、Prompt 注入与画像专属存储辅助函数。
- 删除人格 Prompt 页面、API、模板管理器和缓存。
- 删除 MCP/Skills 页面、API、配置兼容服务、运行时 manager/bridge/scheduler，以及 `@modelcontextprotocol/sdk`。
- 删除浏览器历史/书签 collector、scheduler 和环境配置。
- 删除旧 Hero 动画及其已无消费者的动画依赖。

历史记忆中的 `chat`、`mcp`、`skill` 仍作为来源 provenance 枚举保留，保证既有 Markdown 和 SQLite 记录可继续读取。

## 3. API 契约

`api-route-contracts.ts` 已删除聊天、会话、画像、Prompt、MCP 和 Skills 路由登记，并继续登记 `/api/config/tool-sources/status` 来源状态契约。主题学习资料的 schema 和路由由 Phase 6 T6.1 定义；Phase 5 不预登记尚不存在的路由，避免契约表出现 stale entry。

## 4. 回归保护

新增 `phase-5-scope-removal.test.ts`，固定以下边界：

- 范围外页面、API 和运行时文件不可恢复。
- 保留生产依赖图不得导入已删除模块。
- API 契约表不得登记旧路由。
- 首页必须提供来源、审核和检索入口。
- MCP 运行依赖已移除，同时历史来源类型仍可解析。

E2E 主流程同步替换聊天场景，覆盖首页状态、移动端无横向溢出与检索、知识详情、图谱、来源设置和 listen 错误契约。

## 5. 验证结果

| 门禁                    | 结果                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run format:check`  | 通过                                                  |
| `npm run typecheck`     | 通过                                                  |
| `npm run lint`          | 通过                                                  |
| `npm run test`          | 49 个文件、438 条测试全部通过                         |
| `npm run test:coverage` | Lines 52.95%、Branches 72.85%、Functions 67.01%，通过 |
| `npm run eval`          | 3 条检索评测全部通过                                  |
| `npm run build`         | 通过，应用路由由 40 个降至 27 个                      |
| `npm run test:e2e`      | 6 条 Chromium 流程全部通过                            |

## 6. 后续

Phase 3 仍负责去噪和来源追踪；Phase 6 在此精简边界上定义并生成带合法知识引用的主题学习资料。完整页面信息架构与可访问性收口仍属于 Phase 7。
