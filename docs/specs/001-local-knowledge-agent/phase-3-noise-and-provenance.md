# LKA-001 Phase 3：去噪和来源追踪

## 1. 交付范围

Phase 3 完成 FR-004 至 FR-007、FR-012、FR-014 和 FR-015 所需的确定性去噪、语义分块与来源关系基础设施。

## 2. 去噪契约

- `NormalizationReport` 记录输入/输出字符数以及每种删除项的数量。
- 当前类别包括控制字符、无效编码、空消息、重复块、工具样板和重复日志。
- `KnowledgeAgent` 返回本次报告，并将其随来源版本写入 `source_versions.normalizationReport`。
- 去噪保留 Markdown 的段落和标题结构，不再把正文压缩成单行。

## 3. 模型安全边界

`KnowledgeModelAdapter` 在 LLM 与 Embedding 请求发出前统一调用密钥脱敏器。规则覆盖 Authorization Header、常见 API Key/Token 赋值、OpenAI/GitHub/Slack/AWS 凭据前缀以及 PEM 私钥块。脱敏只影响远程请求副本，不修改本地原始来源。

## 4. 语义分块与身份

- Markdown 标题和对话角色标题优先形成语义块。
- 无标题文本按段落形成语义块；超长块才按句子和长度兜底，并使用确定性的默认大小与重叠量。
- 每个块保存 SHA-256、稳定 `chunkId`、顺序、定位符和边界类型。
- `source_versions` 保存每个来源版本，`source_chunks` 保存块身份。
- 原始 revision 改变但归一化后的有序块哈希完全相同时，事件记为 `skipped`，不新增待审计事件。

## 5. 来源关系

- `source_memory_links` 保存来源 ID、revision、来源事件、知识单元、块哈希和定位符。
- 关系只在自动发布、人工接受或冲突接受后写入，不关联被拒绝或仍待审核的候选。
- 多卡抽取会关联锚点及其 `-pN` 派生卡片。
- 已发布 Markdown frontmatter 写出 `sourceId`、`sourceRevision`、`sourceEventId` 和可用的 `sourceChunkHash`。
- 启动迁移会为带 `sourceHash`/来源证据的旧 memory 尽可能补建来源版本和关系；无法确认 revision 的旧记录保持不变。

## 6. 验证

- Phase 3 专项与相邻回归：`41 passed`
- `npm run typecheck`
- 完整门禁结果以本次提交的最终验证为准。

## 7. 后续边界

Phase 6 可以直接使用 `source_memory_links` 校验主题学习资料引用。来源详情的完整页面信息架构仍由 Phase 7 统一收口。
