# LKA-001 Phase 9：全站界面统一与交互改版

| 字段 | 内容                                                         |
| ---- | ------------------------------------------------------------ |
| 阶段 | Phase 9：全站界面统一与交互改版                              |
| 日期 | 2026-09-26                                                   |
| 状态 | 完成                                                         |
| 依据 | 项目现有页面、组件、路由、API、AGENTS.md 与 Open Design 原型 |

## 交付范围

- 全局采用浅灰画布、白色表面、轻边界、柔和圆角和克制蓝色强调；导航统一为“首页 / 状态 / 检索库 / 设置”。
- 首页输入区提供两行布局和“提问 / 检索”切换。提问立即显示用户消息，实际 SSE 工具轨迹位于回答前；答案、拒答或错误到达后折叠处理轨迹。关键词检索仍跳转检索库并保留查询词。
- 新增 `/status`，用真实监听接口、来源状态、watcher 状态、队列计数和模型健康数据展示运行情况；接口读取失败或字段缺失时显示说明或“—”。
- `/memory` 使用左侧记录列表和右侧详情布局，保留关键词搜索、主题筛选、分页、访问回写、详情/主题链接和全量索引重建入口。
- AI、存储和来源设置保留真实配置读写、连接测试、存储迁移、来源 CRUD、监听状态与手动扫描；记忆详情、主题资料和知识图谱沿用同一视觉语言。

## 真实数据与接口映射

| 用户流程                   | 使用的现有接口                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| 首页问答、处理轨迹与引用   | `GET /api/ask`、`POST /api/ask`（SSE）                                                              |
| 首页快捷检索               | 导航至 `/memory?q=...`，由检索库使用 `GET /api/memory/search`                                       |
| 检索库列表、分页、主题筛选 | `GET /api/memory`、`GET /api/memory/search`                                                         |
| 选中记录详情、来源与关联   | `GET /api/memory/[id]`、`POST /api/memory/[id]/access`                                              |
| 全量索引重建               | `POST /api/memory/rebuild`                                                                         |
| 运行状态                   | `GET /api/listen`、`GET /api/config/tool-sources/status`、`GET /api/health`                         |
| AI 配置与连接测试          | `GET/POST /api/config/ai`、`POST /api/config/ai/test`                                               |
| 存储路径与迁移             | `GET/PATCH/POST /api/config/storage`                                                                |
| 来源监听配置与扫描         | `GET/POST /api/config/tool-sources`、`GET /api/config/tool-sources/status`、`POST /api/listen/scan` |
| 主题资料生成与读取         | `GET/POST /api/topics/[topic]`                                                                      |

## 验证

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run format:check`：通过。
- `npm test`：61 个测试文件、499 条测试通过。
- `npm run build`：Next.js production build 通过，包含新增 `/status` 页面。
- `npm run test:e2e`：8 条 Chromium 流程通过，覆盖真实来源配置/扫描/检索/主题追溯、幂等、首页 SSE、模型降级和移动端布局。
