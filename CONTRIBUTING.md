# 贡献指南

开发前先阅读 `Agents.md` 与 `docs/specs/001-local-knowledge-agent/`。项目范围是本地知识整理 Agent，不接受重新引入通用聊天、画像、人格 Prompt、聊天型 MCP/Skills 或浏览器历史采集的改动。

## 架构约束

1. `src/features/` 和 `src/lib/` 不依赖 React、Next.js 路由或 CSS。
2. 采集入口统一产生 `SourceRevisionEvent`，处理进度统一写 `AgentProgressEvent`。
3. 候选先进入 SQLite `pending_events`，接受后才能发布 Markdown。
4. 模型调用只经过 `KnowledgeModelAdapter`；降级必须可见且 fail-closed。
5. 新 API 必须登记到 `src/config/api-route-contracts.ts` 并在入口做 Zod 校验。
6. 文档、测试和实现必须在同一变更中更新。

## 本地检查

```bash
npm ci
npm run format:check
npm run typecheck
npm run lint
npm run audit:dead-code
npm run test:coverage
npm run eval
npm run build
npm run test:e2e
```

Playwright 使用 `e2e/.tmp/` 隔离数据，不读写真实 `memory-root/`。首次运行需要 `npx playwright install chromium`。

## 提交要求

- 行为变更应有单元或集成测试；用户主流程变化应更新 Playwright。
- 新检索策略必须更新版本化评测集和明确回归阈值。
- 删除模块后运行 `npm run audit:dead-code`，并同步清理依赖。
- 不提交 `.env*`、数据库、真实来源内容、日志或评测生成报告。
- PR 描述应列出关联 FR/AC、故障行为和验证命令。
