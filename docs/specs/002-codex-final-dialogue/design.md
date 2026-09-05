# LKA-002 技术设计：Codex 对话筛选

状态：实现与验证完成。需求和验收编号以 [spec.md](./spec.md) 为准，执行顺序见 [tasks.md](./tasks.md)，结果见 [交付报告](./delivery.md)。

### 实现格式契约（2026-09-05）

- 合成结构位于 `src/__tests__/fixtures/codex-dialogue.ts`，来源是本机结构字段抽查，不提交个人正文。session metadata 必须声明 `source=cli/vscode/desktop`；桌面端实际样本为 `source=vscode, thread_source=user`。thread_source 若存在必须为 user；子代理 source 对象、非空 parent_thread_id、未知来源不支持。
- `task_started` 或 `turn_context` 必须提供 turn_id。消息可继承当前确定性边界；显式 turn_id 必须对应已知轮次，外部 thread_id 必须匹配会话 ID。不支持无轮次证据的历史格式。
- Desktop kinds 读取 `internal_chat_message_metadata_passthrough.content_item_kinds`（也支持显式同名字段）；UserMessage 使用 `text` 块，AgentMessage 使用 `Text` 块。response 消息支持 input_text/output_text；未知块不展开。
- Desktop assistant response 的 metadata.turn_id 可能是内部子轮次，与外层 turn_id 不同；实际结构确认 response.id 等于 AgentMessage.id。以同一文件中的已验证 item ID 关联这些镜像（支持任意出现顺序），不按未知 turn_id 猜测归属。
- CLI `user_message` 证明真实输入；无 kinds 的 response 用户记录跳过，保留可信 CLI/item 镜像。final/final_answer 为最终阶段；同轮 task_complete 快照可作为 fallback，冲突则整轮跳过。
- Codex 筛选结果绕过通用正文去重和 tool-boilerplate 正则，直接形成对话候选，避免跨轮重复内容丢失或结构化日志再次复制和截断正文。Codex chunkId 加 ordinal 后缀解决重复内容块的唯一约束，内容 hash 保持不变。
- 诊断持久化于现有 `source_versions.normalizationReport.dialogue`，由 `/api/listen` 的 `agent.sources[].dialogue` 暴露，并以 `listenStatusAgentSchema` 校验；首页显示原因与截断状态。不需要新增数据库列。

## 1. 改动边界

| 模块 | 职责与改动 |
| --- | --- |
| `src/lib/tools/session-parser.ts` | Codex 分支改用 schema 白名单与轮次解析；不改其他工具共享行为 |
| `src/lib/tools/` 内的 Codex 专用模块 | 需要拆分时承载纯函数事件适配和去重；不引入插件注册器 |
| `src/server/services/knowledge-agent.ts` | 消费筛选后的正文与诊断，在截断/归一化/候选生成前落实边界 |
| `src/server/watchers/tool-dir-watcher.ts` | 继续监听同一目录；需要时保证 revision 与解析使用同一份文件快照 |
| `src/server/services/source-registry.ts` | 复用来源版本与归一化内容无变化判断，不改 sourceId/revision 算法 |
| `src/types/normalization.ts`、`src/types/agent.ts` | 最小增量表达筛选计数、原因及解析策略版本，不引入 UI 依赖 |
| `src/config/tool-presets.ts`、`src/components/settings/ToolSourceList.tsx` | 默认显示名覆盖 CLI/桌面端，不修改既有自定义名称或 `codex` 值 |
| `src/config/api-route-contracts.ts` | 仅在实际暴露诊断字段时同步类型和响应 schema |

禁止通过修改全局 `extractContent()` 来粗略过滤所有提供商；Codex 规则必须有独立测试和明确调用入口。默认不增加运行时依赖，使用现有 TypeScript、Zod 和 Node.js 能力。

## 2. 数据流

```text
原始 JSONL 快照 -> 原始 revision / SourceRevisionEvent
               -> 支持格式校验
               -> 用户身份及最终阶段白名单
               -> 轮次归属 / 镜像事件去重
               -> 已完成轮次的用户输入与最终回答
               -> 长度限制 / 归一化 / 分块 / 内容无变化判断
               -> pending_events -> 质量评价 / 审核 -> Markdown 与索引

被排除事件 -> 仅类别、数量和原因，不进入业务正文
未完成轮次 -> 等待文件后续版本，不创建空白或半成品候选
```

同一文件在观察和解析之间可能继续追加。实现必须使原始 revision 对应实际解析字节，优先复用已读取的快照；不能先哈希 A 内容、再读 B 内容却仍记录 A 的 revision。

## 3. 明确支持的事件表示

先建立小型纯数据 schema，再适配为内部的允许消息。下表是开发起点，支持项必须由 fixture 固化。

| 原始表示 | 处理策略 |
| --- | --- |
| `event_msg.item_completed`，`item.type=UserMessage` | 作为实际用户输入的优先候选；校验会话来源与内容块，排除明确的后台/子代理消息 |
| `response_item`，`payload.type=message`，`role=user` | 按 `content_item_kinds` 与内容块逐一判断；保留 `user.text`，丢弃 instructions/environment 等注入块；与同一 UserMessage 去重 |
| `event_msg.user_message` | 作为已支持 CLI 格式的用户输入，按 schema 确认字段和轮次，不递归抓取任意 message |
| `response_item.message`，`role=assistant` | 仅接受经 fixture 验证的 `phase=final_answer` 或等价 `phase=final`；`analysis/commentary` 一律排除 |
| `event_msg.item_completed`，`item.type=AgentMessage` | 按 `item.phase` 验证最终回答，提取明确的文本块；与 response_item 合并 |
| `event_msg.agent_message` | 必须同时有明确最终阶段或同轮完成证据；缺少证据不接受 |
| `event_msg.task_complete.last_agent_message` | 首先作为同轮完成证据或已选 final 的镜像；仅在无更完整 final 且能确定轮次和来源的支持格式中作为正文 fallback |
| `task_started`、`turn_context`、session metadata | 只用于来源与轮次边界，不输出其正文 |
| 工具、reasoning、压缩摘要、world_state、token 记录、其他事件 | 排除正文；未知种类计数，不泛化为消息 |

### 3.1 用户输入判定

本机桌面端样本存在一个 role=user 记录携带两块注入内容，`content_item_kinds` 分别为 `agents_md.instructions` 与 `environments.environment_context`；真实输入另有 `user.text`。不得忽略这个差异。

当 kind 列表与正文块数量不匹配、身份不明确时，不凭位置猜测。优先取同轮已验证的 `UserMessage` 或 `user_message` 镜像；仍无法证明来源的块跳过并诊断。旧 CLI 若没有 kinds，可通过明确用户事件镜像建立身份，不能简单放开所有 role=user。

用户主动粘贴的代码、日志、指令文本按用户内容保留，不使用字符串前缀、正则关键词或 XML 标签删除来替代结构身份。图片或附件只保留明确的用户文本块，不抓取图像 URL 对应内容、OCR、base64 或工具结果补全。

### 3.2 最终回答判定

最终性来源于允许的阶段或明确完成事件。对于缺少 phase 的旧格式，只有同轮的完成快照与消息能确定性对应时才允许 fallback；禁止“最后一个 assistant 就是 final”。不同镜像最终内容冲突时，不按文本长度择优，也不合并为猜测回答，应跳过该歧义轮次并记录原因。

完整回答可能由多个文本块组成，保留其顺序、段落、代码围栏、链接和引用。reasoning 内容块即使与文本块相邻也不能提取。消息内出现单词 `analysis` 或引用工具命令不改变最终消息身份。

### 3.3 轮次与消息身份

优先使用来源会话 ID、`turn_id`、消息/item ID 和明确的客户端消息关联字段。没有显式 turn ID 的受支持格式，允许由 `task_started/task_complete` 等确定性边界构造本地轮次标识；推断规则需要独立 fixture。

先收集允许的候选与完成证据，再在同轮中匹配镜像，最后按原始消息顺序输出，避免双通道记录交错改变对话顺序。标识缺失时，只在已确认同轮同消息的镜像对中使用规范化指纹；不建立全会话正文去重集合。

解析过程中不依赖文件名中的客户端名称决定内容是否可信。session metadata 明确标记为子代理或后台生成时，不作为真人会话采集；无法确定的来源不升级为真人消息。

## 4. 解析结果与诊断

继续向下游提供 `ParsedSession.content/title/messageCount`，其中 content 只来自已完成轮次，title 来自首个实际被保留的用户输入，messageCount 只计算去重后已输出消息。

按实际需要给 Codex 解析结果增加可选诊断对象，避免要求其他工具同时迁移。建议至少记录：

- `policyVersion`：固定策略版本，例如 `codex-final-dialogue-v1`。
- 已保留用户消息数、最终回答数、完整轮次数。
- 排除计数：reasoning、tool、non-final、context、duplicate、unknown、invalid。
- 未完成轮次数、缺少用户输入的 final 数，以及是否发生允许正文截断。
- 非错误结果原因：`no_final_answer`、`no_dialogue`、`unsupported_format`、`orphan_final`、`ambiguous_turn`。

诊断只含计数、结构标识和原因，不保存被过滤正文、工具参数、推理摘要或加密字段。必须能通过现有来源状态或处理进度查看“等待最终回答”与“不支持格式”的区别，不能只在服务端日志中可见。采用现有 `AgentProgressEvent` 与来源报告字段进行最小扩展，数据库和 API schema 随真实实现同步。

未知格式属于确定性跳过，不设置为模型故障或无限重试。文件锁、读失败等 I/O 错误沿用可恢复错误路径。尾部半行先等待下一 revision；中间损坏行若导致边界不可判定，受影响轮次不能继续强行配对。

## 5. 归一化、幂等与存储

保留原始 revision 用于溯源；过滤策略版本单独记录，不能塞入原始文件哈希或修改既有事件 ID。复用 `SourceRegistry.recordVersion()` 的归一化块无变化路径，使纯噪声追加在模型调用和入队之前结束。

仅策略版本或过滤计数变化，不得引发知识更新。标题、摘要、证据与正文都只依赖允许内容，不能因事件时间、模型统计或源日志中的提示词发生变化而生成新候选。

既有 `limitSessionContent()` 会对超过 10,000 字符的会话保留头尾。本次不建设无限长对话存档；必须先过滤，再执行既有预算，并记录截断。原文完整保存在 Codex 来源文件中，不把工具或推理事件作为“补全上下文”重新加入。

本次不按每条消息创建新的永久记忆 ID。继续按现有来源/会话稳定身份创建或更新候选，后续知识拆分仍由既有加工链负责。候选与正式知识的质量和审计边界保持不变。

## 6. 历史数据与发布

- 新部署后首次处理的来源版本必须使用新策略。已有 processed revision 继续作为 unchanged，不自动跳过幂等保护去重跑。
- 不自动删除、拒绝、改写旧候选，不重新生成已发布笔记；旧数据及其可能继续执行的队列事件不属于新策略保证范围。
- 不能因为一个旧会话在新策略下筛选为空，就将其已发布知识删除。
- 界面显示名更新不修改监听目录、已有 source 配置 ID、`toolType=codex` 或用户自定义名称。
- 发布报告记录支持的客户端格式、诊断字段、旧数据边界和过滤策略版本；不宣称“历史笔记已经全部清洗”。

## 7. 验证策略

1. Parser 单测使用手写合成 JSONL，覆盖 spec 的各类正反例；不要提交真实个人会话。
2. 镜像、跨轮重复、phase 缺失、注入块和未知格式必须既有应保留断言，也有应排除断言。
3. 集成测试使用真实临时 SQLite/Markdown 存储与模型 stub，捕获进入 LLM/Embedding 的参数；被排除事件放唯一哨兵，验证它不出现在模型输入、候选、证据、诊断与新发布文件。
4. watcher/agent 测试覆盖首次扫描、追加噪声、追加最终回答、重启、半行补全及原始 revision 与解析快照一致。
5. UI 验证仅覆盖来源名称、等待/不支持格式诊断和现有采集审核主流程，不扩大页面改版范围。
6. 门禁依次包含定向测试、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run audit:dead-code`、`npm run test:coverage`、`npm run eval`、`npm run build` 和相关 `npm run test:e2e`。通过后记录结果，不虚填旧报告数据。

无需真实远程 API Key 才能验证筛选正确性。真实会话可由用户本地人工验证，仓库只保留其结构的合成 fixture 和不含正文的统计证据。
