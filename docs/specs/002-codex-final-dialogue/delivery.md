# LKA-002 交付与 Review 报告

日期：2026-09-05。代码基线：`1e865e4`（已推送的 Phase 8 代码），不是仅保存文档的 `f2d9522`。本报告与 KA-002 实现、测试一同提交。

## 实现结果

Codex 来源使用 `codex-final-dialogue-v1` 确定性策略，只将真实用户输入和每轮明确最终回答送入知识循环。过滤在长度预算、分块、候选及模型调用之前执行；等待轮次、未知来源和孤立回答不生成候选。其他工具解析语义保持不变。

监听器传入计算原始 revision 的同一份快照；无快照调用会验证读取字节的 revision，读取失败仍进入可恢复错误路径。筛选后内容哈希不变时复用既有无操作路径。诊断复用 source_versions 的 JSON 报告字段持久化，通过 `/api/listen` 和首页来源状态展示。

支持格式详见 [design.md](./design.md) 的实现格式契约。CLI/桌面端名称改为“Codex（CLI / 桌面端）”，已有自定义名称、目录、toolType 和知识 ID 算法保持原样。

## 验收证据

下表的 P 指 `src/__tests__/codex-dialogue.test.ts`，I 指 `src/__tests__/codex-dialogue.integration.test.ts`，E 指 `e2e/main-flows.spec.ts`。全部 fixture 为合成内容。

| 验收 | 验证证据 |
| --- | --- |
| AC-01 | P final phase 参数化测试；I 哨兵检查；E 从来源扫描到发布 |
| AC-02 | P final/final_answer、Desktop UserMessage/AgentMessage、CLI turn_context/user_message/agent_message/completion |
| AC-03 | P response/item/completion 去重、重放 item ID、内部子轮次 ID 双顺序镜像测试 |
| AC-04 | P same-channel/cross-turn 重复与用户纠正顺序；Codex 分块使用 ordinal 保留重复内容 |
| AC-05 | P 保留 analysis 词语与代码围栏；I 候选中的 tool result 引用保持存在 |
| AC-06 | P kinds 混合块、数量失配、缺失 kinds；允许用户主动粘贴环境标签 |
| AC-07 | P 中途追加重复问题与 Correction 的原顺序 |
| AC-08 | P 只输出已完成前缀；I 新最终轮次追加后稳定 memoryId；E 等待到发布 |
| AC-09 | P 未最终、未知阶段与取消轮次；I 空结果无队列和模型调用 |
| AC-10 | I 发布后追加噪声及完成镜像、关闭并重开 SQLite、重复扫描，队列数量/文件字节/模型调用不变 |
| AC-11 | P/I JSON 半行后补全，仅完整版本入队一次 |
| AC-12 | P 坏行隔断、后续独立完整轮次、孤立 final；不跨损坏边界配对 |
| AC-13 | I 独特哨兵不进入候选、来源证据、非空 LLM/Embedding 入参、诊断、归档 Markdown 和新笔记 |
| AC-14 | P 独立调用没有跨来源状态；I 来源路径和原始 revision 随候选保留 |
| AC-15 | P 未知来源、子代理、跨线程 item、内部消息来源、无文本附件；E 显示不支持格式 |
| AC-16 | I 超预算允许正文设置 truncated=true；过滤正文直接入候选，避免重复日志包装二次截断 |
| AC-17 | I 无模型配置及模型返回 degraded，保持 review；人工接受后才发布 |
| AC-18 | I 旧 processed revision 不重跑、过滤为空保留旧候选和已发布笔记；session-parser 测试回归 Claude/Cursor/Markdown/Text/Trae；既有 listen 和文件监听测试通过 |

## 工程门禁

| 命令 | 本次结果 |
| --- | --- |
| 定向 Codex 测试 | 21 个 parser 用例、6 个真实存储集成用例通过 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm run format:check` | 通过；修正 Phase 8 基线 AI test route 的一处格式 |
| `npm run audit:dead-code` | 通过，162 个生产模块可达 |
| `npm run test:coverage -- --silent` | 52 个文件、439 条测试通过；lines 59.97%、branches 75.33%、functions 71.59%，超过现有阈值 |
| `npm run eval` | 3 条评测测试通过；keyword Recall@5 0.7105 / MRR 0.693；vector Recall@5 0.9737 / MRR 0.8969 |
| `npm run build` | 通过，25 个页面生成完成 |
| `npm run test:e2e` | 5 条通过，含来源→扫描→审核→发布→检索、移动端与 Codex 状态 |

已检查 `test-results/main-flows-Codex-来源显示等待与未知格式，最终回答到达后可审核发布/` 中的桌面和手机截图。手机搜索区及处理记录不再被长 ID 撑宽；来源表保留原有局部水平滚动。

E2E 中一次新增断言在导航前执行导致超时，调整顺序后全套通过。Next dev 曾输出一次临时 manifest JSON 读取警告，页面及浏览器断言均通过，生产构建通过；未将其当作 Codex 筛选故障。离线测试中的向量不可用提示是预期降级。

## Review 与修复

1. 原递归文本提取会引入工具、推理和注入内容：改为独立 schema 白名单；未知事件不回退提取。
2. 哈希与解析之间二次读取可能错配 revision：改为共享快照，补充文件变化和 I/O 测试。
3. 通用正文去重误删跨轮真实重复，重复块又触发 SQLite 唯一约束：Codex 保留原文，块身份增加顺序标识。
4. 镜像合并后丢失次级 ID，会把重放 item 误当新用户：记录已合并 ID 集合并补充回归。
5. Desktop assistant metadata turn_id 与外层轮次不同：通过相同 item/message ID 关联，支持镜像先后两种顺序，不按文本猜测跨轮关系。
6. 手机页面长来源 ID 撑宽内容网格：移动端显式使用 minmax(0,1fr) 单列；补充控件边界断言和截图检查。

最终 scoped review 未发现剩余阻断问题。只读检查了 3 份本机真人会话的结构统计，均能保留已完成轮次，修复后孤立 final 计数为 0；这些文件未导入、修改或提交，未发往模型。

## 发布边界

- 不自动处理旧 processed revision，不拒绝或删除旧候选，不清洗旧笔记及归档。旧候选仍可能由既有队列继续处理。
- 原始日志仍保存在 Codex 目录；本功能不会阻止 Codex 自身保存工具事件。
- 未有格式证据的 source/phase/轮次或附件内容默认跳过。新增客户端变体应先补正反例 fixture。
- 验证未使用真实远程 API Key；远程边界以模型 stub 的非空调用参数验证。
