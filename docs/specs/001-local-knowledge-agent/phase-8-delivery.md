# LKA-001 Phase 8：验证和作品集交付

| 字段 | 内容 |
| --- | --- |
| 阶段 | Phase 8：验证和作品集交付 |
| 状态 | 完成 |
| 日期 | 2026-09-05 |
| 基线 | `pre-scope-reduction-2026-09-03` |
| 关联任务 | T8.1 至 T8.7 |

## 1. 交付结论

LKA-001 的范围收缩、核心闭环和作品集材料已经完成。真实浏览器流程从空数据库与一个 Markdown 文件开始，依次完成来源配置、扫描、稳定版本、降级转审核、人工接受、发布、关键词检索、主题资料生成和来源版本追溯；第二次扫描没有产生副本。

Phase 8 验证时发现并修复了两个 P0 实现偏差：审核 API 丢失自动决策原因；生产搜索未接入已经实现的查询改写、Wikilink 邻居和 MMR。两项现在都有单元/集成测试和 Playwright 主流程保护。

## 2. 验收场景

| 场景 | 自动化证据 | 结果 |
| --- | --- | --- |
| AC-001 新来源形成知识 | Playwright 真实来源闭环；retained core integration | 通过 |
| AC-002 重复观察无副本 | Playwright 二次扫描；稳定 revision 特征测试 | 新增重复知识 0 |
| AC-003 不确定结果禁止发布 | 无 Embedding 的候选进入 review，显示原因后人工接受 | 通过 |
| AC-004 Embedding 降级 | 搜索显示关键词降级通道并返回已发布知识 | 通过 |
| AC-005 来源可追溯 | 主题资料展示知识链接、sourceId、revision 和文件路径 | 通过 |
| AC-006 索引重建安全 | HNSW sidecar 删除重建不修改规范 Markdown 特征测试 | 通过 |
| AC-007 删除功能不可访问 | Playwright 验证 chat/profile 页面与 API 返回 404 | 通过 |

## 3. 检索评测

评测集由 24 条记忆/30 条查询扩展到 26 条记忆/38 条查询。新增 `noise`、`synonym`、`topic-filter` 和 `near-duplicate` 四组；使用确定性字符 bigram 向量和 JS exact 后端，不依赖外部网络。

| 模式 | 数据集 | Recall@1 | Recall@5 | MRR | 回归阈值 |
| --- | ---: | ---: | ---: | ---: | --- |
| Phase 0 keyword | 24 / 30 | 0.7333 | 0.7333 | 0.7333 | 未单列 |
| Phase 8 keyword | 26 / 38 | 0.6842 | 0.7105 | 0.6930 | Recall@5 >= 0.65；MRR >= 0.65 |
| Phase 0 vector | 24 / 30 | 0.8667 | 0.9667 | 0.9167 | 未单列 |
| Phase 8 vector | 26 / 38 | 0.8421 | 0.9737 | 0.8969 | Recall@5 >= 0.85；MRR >= 0.75 |

Phase 8 vector 的四个新增分组 Recall@5：含噪 1.0、同义词 1.0、主题过滤 1.0、近似重复 1.0。整体 MRR 下降来自更难的新查询，Recall@5 仍高于旧集并通过明确阈值。

## 4. 改造前后指标

统计口径与 Phase 0 一致：`src` 下非空行用于规模比较，不代表语义复杂度。

| 指标 | Phase 0 | Phase 8 | 变化 |
| --- | ---: | ---: | ---: |
| 产品 TS/TSX 文件 | 226 | 161 | -65（-28.8%） |
| 产品 TS/TSX 非空行 | 25,769 | 18,227 | -7,542（-29.3%） |
| 产品实现 + CSS 非空行 | 27,014 | 19,495 | -7,519（-27.8%） |
| API Route Handlers | 33 | 21 | -12（-36.4%） |
| 页面 | 14 | 9 | -5（-35.7%） |
| 运行依赖 | 17 | 13 | -4（-23.5%） |
| Vitest 测试文件 | 50 | 50 | 持平，范围转向知识闭环 |
| Vitest 测试用例 | 473 | 411 | -62，删除范围外旧测试并补核心回归 |
| Playwright 用例 | 6 | 4 | 改为完整闭环、幂等、移动端和范围边界 |

覆盖率当前为 Lines 58.18%、Branches 73.08%、Functions 69.62%，通过 30% / 70% / 50% 门槛。Phase 0 未保存覆盖率百分比，因此不伪造前值。

重复率：确定性演示首次扫描发布 1 条知识，未变化二次扫描新增 0 条，重复率 0%。

耗时：本机 Playwright 完整来源到追溯主流程为 15.1 秒，4 条 Phase 8 E2E 合计 28.3 秒；Phase 0 的 6 条旧 E2E 为 41.1 秒。由于场景不同，只将其作为演示预算证据，不作为性能基准。五分钟人工演示仍有充足余量。

## 5. 死代码与依赖审计

新增 `npm run audit:dead-code`，从 Next.js 页面/API/layout、middleware、instrumentation 和集中 API 契约遍历本地 import 图。160 个可执行生产模块全部可达，命令已接入 Windows/Linux CI。

本阶段删除：

- 8 个未引用旧 UI/装饰组件及其 `clsx`、`tailwind-merge` 依赖。
- 无入口的聊天式记忆纠错模块与旧测试。
- 无运行时入口的 nightly 维护模块与旧测试。
- 绕过待审计队列直接压缩/归档知识的 retention 服务、worker 和 scheduler。
- 未使用的独立 MemoryScorer；Ranker 直接读取统一 scoring 配置。

历史 `chat / mcp / skill` 来源枚举和旧数据库表不删除，它们只承担非破坏兼容，不构成可执行聊天/MCP/Skills 运行时。

## 6. 最终门禁

| 命令 | 结果 | 关键数据 |
| --- | --- | --- |
| `npm run format:check` | 通过 | Prettier 无差异 |
| `npm run typecheck` | 通过 | TypeScript 无错误 |
| `npm run lint` | 通过 | ESLint 0 warning |
| `npm run audit:dead-code` | 通过 | 160 个生产模块可达 |
| `npm run test:coverage` | 通过 | 50 files，411 tests；58.18 / 73.08 / 69.62 |
| `npm run eval` | 通过 | 26 memories，38 queries，全部阈值通过 |
| `npm run build` | 通过 | Next.js production build |
| `npm run test:e2e` | 通过 | Chromium 4/4，28.3 秒 |

## 7. 作品集入口

- 项目首页：`README.md`
- 当前架构图：`结构图/knowledge-agent-phase8.md`
- 确定性演示来源：`demo/phase8-source/observable-agent-loop.md`
- 五分钟脚本：`demo/phase8-demo.md`
- 需求与验收：`docs/specs/001-local-knowledge-agent/spec.md`
- 改造前基线：`docs/specs/001-local-knowledge-agent/phase-0-baseline.md`

## 8. 最终边界

Phase 8 结束后没有已知 P0/P1 规范偏差。旧用户数据继续原位保留；生产导航、API、启动链和 import 图均不依赖聊天、画像、Prompt、MCP/Skills、浏览器历史、nightly 或非审计 retention 代码。
