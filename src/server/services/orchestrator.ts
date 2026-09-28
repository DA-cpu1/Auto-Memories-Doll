import { MemoryService } from "./memory-service";
import { AuditReportWriter } from "./audit-report-writer";
import { Auditor } from "../../features/audit/auditor";
import { AuditReporter } from "../../features/audit/reporter";
import { MemoryExtractionService, ExtractedCard } from "./memory-extraction-service";
import { MemoryCardHygieneService } from "./memory-card-hygiene-service";
import { TopicClassificationService } from "./topic-classification-service";
import { KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import { createHash } from "crypto";
import { MemoryRecord, MemoryKind, MemoryEvidence, PendingEvent } from "../../types/memory";
import { buildMemoryRecord, buildPendingEvent } from "../../lib/memory/builder";
import { validateMemoryRecord } from "../../lib/memory/validator";
import { generateZhFields } from "../../lib/memory/translator";
import { buildVectorRecord } from "../../lib/vector/generator";
import { VectorIndex } from "../../lib/vector/index";
import { updateIndexMap } from "../../lib/storage/index-writer";
import { writeMemoryMarkdown, updateAgentMarkdown } from "../../lib/storage/memory-writer";
import { createFailureRecord, deleteFile } from "../../lib/storage/file-manager";
import { getNotePath } from "../../lib/storage/path-resolver";
import { processJsonPipeline } from "../pipelines/json-pipeline";
import { formatMemoryContent } from "../pipelines/formatter";
import { MemoryValidationError } from "../../lib/errors";
import { generateId } from "../../lib/utils/id";
import { logger } from "../../lib/logger";
import { VersionManager } from "../../features/audit/version-manager";
import { StudyGuideBuilder } from "./study-guide-builder";
import { ModelDependencyError } from "../../lib/ai/dependency-error";
import { dependencyConfig } from "../../config/dependency.config";
import { ProcessingCheckpoints } from "./processing-checkpoints";

const LIST_LIMIT = 500;
const QUEUE_BATCH_SIZE = dependencyConfig.batchSize;
/** Explicit rebuild command tag. */
export const FULL_REBUILD_TAG = "全量重建";

/** 来源原文的 sha256：抽取型记忆用它做变更检测与重复入库跳过 */
function sourceHashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class Orchestrator {
  private memoryService: MemoryService;
  private auditor: Auditor;
  private extraction: MemoryExtractionService;
  private memoryCardHygiene: MemoryCardHygieneService;
  private topicClassification: TopicClassificationService;
  private reporter: AuditReporter;
  private auditReportWriter: AuditReportWriter;
  /** 本批已发生变更的 topic 集合：聚合文件重写延后到批末 flushDerivedStores */
  private deferredTopics = new Set<string>();

  constructor() {
    this.memoryService = new MemoryService();
    this.extraction = new MemoryExtractionService();
    this.memoryCardHygiene = new MemoryCardHygieneService();
    this.topicClassification = new TopicClassificationService();
    this.reporter = new AuditReporter();
    this.auditReportWriter = new AuditReportWriter(this.reporter);
    this.auditor = new Auditor({
      getMemory: (id) => this.memoryService.getMemory(id),
      dequeueEvent: (memoryId) => this.memoryService.dequeueEvent(memoryId),
      dequeueEventById: (eventId) => this.memoryService.dequeueEventById(eventId),
      updateEvent: (event) => this.memoryService.updateEvent(event),
    });
  }

  /** 归一化、分块并入队；不按质量或相似度过滤内容。 */
  async processIngest(
    source: string,
    sourceType: "chat" | "ingest" | "manual" | "mcp" | "skill",
    content: string,
    title: string,
    summary: string,
    tags: string[] = [],
    meta?: { kind?: MemoryKind; evidence?: MemoryEvidence },
  ): Promise<string> {
    // 1. 预处理：清洗 + 去重 + 拆包
    const formattedContent = formatMemoryContent(content);
    const pipelineResult = await processJsonPipeline(formattedContent);

    if (pipelineResult.chunks.length === 0) {
      throw new MemoryValidationError("content", "内容为空或经清洗后无效");
    }

    // 多 chunk 合并为 markdown 分段正文（保留全部内容，避免长文截断丢失）
    const finalContent =
      pipelineResult.chunks.length > 1
        ? pipelineResult.chunks.map((c, i) => `## 部分 ${i + 1}\n\n${c.content}`).join("\n\n")
        : pipelineResult.chunks[0].content;

    // pipeline 自动生成的 summary 优先级低于调用方传入的 summary
    const finalSummary = summary || pipelineResult.chunks[0].summary;
    // 合并调用方 tags 与 pipeline 自动提取的 tags
    const finalTags = [...new Set([...tags, ...pipelineResult.chunks.flatMap((c) => c.tags)])];

    // 2. 构建记忆记录并校验
    const id = generateId();
    const memory = buildMemoryRecord(
      source,
      sourceType,
      title,
      finalContent,
      finalSummary,
      finalTags,
      "uncategorized",
      id,
      undefined,
      meta,
    );

    if (!validateMemoryRecord(memory)) {
      throw new MemoryValidationError("record", "记忆数据不完整");
    }

    // 3. 入待审计队列（实际落盘由 processQueue 消费时完成）
    const pendingEvent = buildPendingEvent(id, sourceType, memory, Object.keys(memory) as string[]);

    this.memoryService.enqueueEvent(pendingEvent);
    return pendingEvent.eventId;
  }

  /** 僵尸事件恢复：进程上次退出时卡在 processing 的事件拉回 pending（启动时由 AuditWorker 调用） */
  recoverStuckEvents(): number {
    const recovered = this.memoryService.resetProcessingEvents();
    if (recovered > 0) {
      logger.audit.info(`恢复 ${recovered} 个僵尸事件（processing → pending）`);
    }
    return recovered;
  }

  async processQueue(): Promise<void> {
    const pendingEvents = this.getPendingEvents({ limit: QUEUE_BATCH_SIZE });
    // 轻量事件优先：巨型会话候选（几百 KB 的 JSON）单独一个就要 LLM 处理几分钟，
    // 排在队头会阻塞整批；按候选体积升序处理，让去重/小事件快速消化

    for (const event of pendingEvents) {
      await this.processEvent(event);
    }
    // topic 聚合文件延后到批末统一重写（见 syncDerivedStores）
    await this.flushDerivedStores();

    if (pendingEvents.length > 0) {
      const updatedMemories = this.memoryService.listMemories({ limit: LIST_LIMIT });
      await updateIndexMap(updatedMemories).catch((err) =>
        logger.audit.error("Index map update failed", { error: (err as Error).message }),
      );

      // 队列处理完成后生成可读 Markdown 审计报告，对应《架构检查文档.md》4.7
      await this.auditReportWriter.write().catch((err) =>
        logger.audit.error("Markdown audit report generation failed", {
          error: (err as Error).message,
        }),
      );
    }
  }

  private async processEvent(event: PendingEvent): Promise<string | void> {
    try {
      let candidate = this.parseCandidate(event);
      const checkpoints = new ProcessingCheckpoints();
      if (checkpoints.isSuperseded(event)) {
        event.status = "rejected";
        event.decisionReasonCode = "SUPERSEDED";
        event.decisionReason = "已有更新的候选版本";
        this.memoryService.updateEvent(event);
        return;
      }

      // 删除事件：直接删除记忆，不经过审计差异比对
      if (event.eventType === "delete") {
        event.status = "processing";
        this.memoryService.updateEvent(event);
        const existing = this.memoryService.getMemory(event.memoryId);
        if (existing) {
          this.deferredTopics.add(existing.topic);
          await deleteFile(getNotePath(existing.topic, existing.id));
        }
        this.memoryService.deleteMemory(event.memoryId);

        event.status = "done";
        this.memoryService.updateEvent(event);
        return;
      }

      if (event.decisionReasonCode !== "AUTO_PUBLISH_SOURCE") {
        candidate = await this.reviewCandidateTopic(event, candidate);
      }

      const existing = this.memoryService.getMemory(event.memoryId);

      if (!existing) {
        // 新建路径：声明 processing 占位，避免并发重复创建
        event.status = "processing";
        this.memoryService.updateEvent(event);

        const newId = this.memoryCardHygiene.isOptimizationCandidate(candidate)
          ? await this.commitOptimizedNewMemory(event, candidate)
          : await this.ingestByExtraction(event, candidate);
        // ingestByExtraction 仅在事件终态 done 时返回锚点 ID，其余终态（review/rejected）返回 undefined
        return newId;
      }

      if (candidate.tags.includes(FULL_REBUILD_TAG)) {
        if (KnowledgeModelAdapter.isDegradedMode) return;
        const staged = await this.stageExistingMemoryOptimization(existing, false);
        if (!staged) return;
        event.status = "processing";
        this.memoryService.updateEvent(event);
        event.status = "done";
        this.memoryService.updateEvent(event);
        return;
      }

      // 抽取型记忆（evidence 带 sourceHash）不走 Auditor diff：
      // existing.content 是中文重写卡、candidate 是采集原文，逐字段比对没有意义。
      // 原文哈希未变 → 无实质变更直接完成；变了 → 删除旧分卡后重跑抽取消费链
      if (existing.evidence?.sourceHash && event.changedFields.includes("content")) {
        if (existing.evidence.sourceHash === sourceHashOf(candidate.content)) {
          event.status = "processing";
          this.memoryService.updateEvent(event);
          await this.syncDerivedStores(existing);
          event.status = "done";
          this.memoryService.updateEvent(event);
          return;
        }
        event.status = "processing";
        this.memoryService.updateEvent(event);
        await this.ingestByExtraction(event, candidate);
        return;
      }

      // 更新路径：由 Auditor.process → dequeueEvent 原子声明（pending → processing）。
      // 此处不能再提前置为 processing，否则 dequeueEvent 查不到 pending 事件会返回 null。
      const auditResult = await this.auditor.process(event.memoryId, event.eventId);

      if (!auditResult) {
        event.status = "failed";
        event.retryCount++;
        this.memoryService.updateEvent(event);
        return;
      }

      if (auditResult.status === "done") {
        const resolution = auditResult.resolution;
        if (resolution && resolution.action === "auto_merge") {
          const merged = resolution.merged;
          if (Object.keys(merged).length) this.memoryService.updateMemory(event.memoryId, merged);

          // 内容发生变更时重新生成向量
          if (event.changedFields.includes("content") && merged.content) {
            await this.refreshVector(event.memoryId, merged.content);
          }

          // SQLite 已更新（真源）；派生物同步失败不阻塞事件完成
          const updated = this.memoryService.getMemory(event.memoryId);
          if (updated) {
            if (event.changedFields.includes("content")) {
              try {
                this.memoryService.classifyMemory(event.memoryId, updated.content);
              } catch (err) {
                logger.ingest.error("记忆分类失败（不阻塞更新）", {
                  memoryId: event.memoryId,
                  error: (err as Error).message,
                });
              }
            }
            await this.syncDerivedStores(updated);
            if (existing.topic !== updated.topic) {
              this.deferredTopics.add(existing.topic);
              await deleteFile(getNotePath(existing.topic, existing.id));
            }
          } else {
            logger.ingest.error("auto_merge 后读取记忆为空，跳过派生同步", {
              memoryId: event.memoryId,
            });
          }
        }
        event.status = "done";
        this.memoryService.updateEvent(event);
      } else {
        event.status = "failed";
        event.retryCount++;
        this.memoryService.updateEvent(event);
      }
    } catch (error) {
      if (error instanceof ModelDependencyError) {
        const attempts = (event.dependency?.attempts ?? 0) + 1;
        const delay = dependencyConfig.retryDelaysMs[attempts - 1];
        const paused =
          delay === undefined ||
          ["NOT_CONFIGURED", "DISABLED", "AUTH_FAILED"].includes(error.reason);
        event.status = "waiting_dependency";
        event.decisionReasonCode = error.reason;
        event.decisionReason = error.message;
        event.dependency = {
          slot: error.slot,
          stage: error.stage,
          reason: error.reason,
          attempts,
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: paused ? undefined : new Date(Date.now() + delay).toISOString(),
          paused,
          configFingerprint: KnowledgeModelAdapter.configurationFingerprint(error.slot),
        };
        this.memoryService.updateEvent(event);
        return;
      }
      event.status = "failed";
      event.retryCount++;
      event.decisionReasonCode = "PROCESSING_FAILED";
      event.decisionReason = (error as Error).message;
      this.memoryService.updateEvent(event);
      await createFailureRecord(event.memoryId, "orchestrator-process", error as Error).catch(
        (err) =>
          logger.audit.error("Failure record creation failed", { error: (err as Error).message }),
      );
    }
  }

  private async reviewCandidateTopic(
    event: PendingEvent,
    candidate: MemoryRecord,
  ): Promise<MemoryRecord> {
    const suggestedTopic = candidate.topic || "uncategorized";
    const checkpoints = new ProcessingCheckpoints();
    const result =
      checkpoints.read<Awaited<ReturnType<TopicClassificationService["classify"]>>>(
        event,
        candidate,
        "topic",
      ) ??
      (await this.topicClassification.classify({
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        suggestedTopic,
      }));
    if (candidate.topic === result.topic) {
      if (result.source === "model") checkpoints.write(event, candidate, "topic", result);
      return candidate;
    }

    const zhFields = generateZhFields(
      candidate.title,
      candidate.summary,
      candidate.tags,
      result.topic,
    );
    const reviewed: MemoryRecord = {
      ...candidate,
      topic: result.topic,
      topicZh: zhFields.topicZh,
    };
    const changedFields = [...new Set([...event.changedFields, "topic", "topicZh"] as string[])];
    event.candidate = JSON.stringify(reviewed);
    event.changedFields = changedFields;
    this.memoryService.updateEventCandidate(event.eventId, reviewed, changedFields);
    if (result.source === "model") checkpoints.write(event, reviewed, "topic", result);
    return reviewed;
  }

  private async stageExistingMemoryOptimization(
    existing: MemoryRecord,
    allowFallback = true,
  ): Promise<boolean> {
    const hygiene = this.memoryCardHygiene.inspect(existing);
    if (!hygiene.needsOptimization) return true;

    const optimized = await this.buildExistingMemoryOptimizationCandidates(
      existing,
      hygiene.issues,
      allowFallback,
    );
    if (!optimized) return false;
    for (const [index, candidate] of optimized.entries()) {
      const eventType = index === 0 ? "update" : "create";
      const changedFields =
        eventType === "update"
          ? this.getOptimizationChangedFields(existing, candidate)
          : Object.keys(candidate);
      if (eventType === "update" && changedFields.length === 0) continue;
      this.memoryService.enqueueEvent(
        buildPendingEvent(candidate.id, candidate.sourceType, candidate, changedFields, eventType),
      );
    }
    return true;
  }

  async enqueueFullMemoryRebuild(): Promise<number> {
    const memories = this.memoryService.listMemories({ limit: -1 });
    let queued = 0;
    for (const memory of memories) {
      if (memory.tags.includes(FULL_REBUILD_TAG)) continue;
      if (this.memoryService.hasPendingEventWithTag(memory.id, FULL_REBUILD_TAG)) continue;
      const candidate = { ...memory, tags: [...memory.tags, FULL_REBUILD_TAG] };
      this.memoryService.enqueueEvent(
        buildPendingEvent(memory.id, memory.sourceType, candidate, ["content", "tags"], "update"),
      );
      queued += 1;
    }
    return queued;
  }

  private async buildExistingMemoryOptimizationCandidates(
    existing: MemoryRecord,
    issues: ReturnType<MemoryCardHygieneService["inspect"]>["issues"],
    allowFallback: boolean,
  ): Promise<MemoryRecord[] | null> {
    try {
      const cards = await this.extraction.extract(existing);
      if (cards?.length)
        return cards.map((card, index) =>
          this.buildOptimizationCandidate(existing, card, issues, index),
        );
    } catch (error) {
      logger.audit.warn("旧记忆卡片模型优化失败，改用保守清理候选", {
        memoryId: existing.id,
        error: (error as Error).message,
      });
      if (!allowFallback) return null;
    }

    return allowFallback
      ? [this.memoryCardHygiene.buildFallbackOptimization(existing, issues)]
      : null;
  }

  private buildOptimizationCandidate(
    existing: MemoryRecord,
    card: ExtractedCard,
    issues: ReturnType<MemoryCardHygieneService["inspect"]>["issues"],
    index: number,
  ): MemoryRecord {
    const tags = [
      ...new Set([
        ...existing.tags,
        ...card.tags,
        MemoryCardHygieneService.optimizationTag,
        ...issues.map((issue) => `修复-${issue}`),
      ]),
    ];
    return {
      ...existing,
      id: index === 0 ? existing.id : `${existing.id}-p${index + 1}`,
      title: card.title,
      titleZh: card.title,
      summary: card.summary,
      summaryZh: card.summary,
      content: card.content,
      tags,
      tagsZh: tags,
    };
  }

  private getOptimizationChangedFields(existing: MemoryRecord, candidate: MemoryRecord): string[] {
    return (
      ["title", "titleZh", "summary", "summaryZh", "content", "tags", "tagsZh"] as const
    ).filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(candidate[field]));
  }

  /**
   * 派生存储同步（Markdown / 话题 Agent.md / 索引）。
   *
   * SQLite 是真源：主存储提交成功后，派生物属于可重建的镜像/加速层，
   * 任一派生任务失败只记日志 + 归档失败记录，不向上抛 ——
   * 避免已入库记忆的事件被整条打成 failed，重试时错误地改走更新+审计路径。
   * 向量本就由 vector-worker 异步补偿，与此策略一致。
   */
  private async syncDerivedStores(memory: MemoryRecord | null): Promise<void> {
    if (!memory) {
      logger.ingest.error("派生存储同步跳过：主存储读取为空");
      return;
    }
    // 单条 Markdown 立即写（廉价）；topic 聚合文件与 index-map 是全量重写，
    // 一批几十条事件每条都重写一次会拖垮消费速度 → 延后到批末 flushDerivedStores
    await writeMemoryMarkdown(memory);
    this.deferredTopics.add(memory.topic);
  }

  /** 批末统一重写本批涉及 topic 的聚合文件与 index-map（processQueue 末尾调用） */
  private async flushDerivedStores(): Promise<void> {
    if (this.deferredTopics.size === 0) return;
    const topics = [...this.deferredTopics];
    this.deferredTopics.clear();
    const all = this.memoryService.listMemories({ limit: LIST_LIMIT });
    const guard = (stage: string, topic: string) => (err: unknown) => {
      logger.ingest.error(`派生存储批量同步失败（不阻塞入库）: ${stage}`, {
        topic,
        error: (err as Error).message,
      });
    };
    await Promise.all([
      ...topics.map((topic) =>
        updateAgentMarkdown(topic, all).catch(guard("update-agent-markdown", topic)),
      ),
      this.refreshStudyGuides(topics).catch(guard("refresh-study-guides", topics.join(","))),
      updateIndexMap(all).catch(guard("update-index-map", topics.join(","))),
    ]);
  }

  /**
   * 采集内容的统一消费链：中文抽取拆卡 → 多卡片提交。
   * 新建路径与抽取型记忆的更新路径共用。
   * 事件终态（done/failed/waiting_dependency）与失败归档在本方法内落库；done 时返回首卡 ID。
   */
  private async ingestByExtraction(
    event: PendingEvent,
    candidate: MemoryRecord,
  ): Promise<string | undefined> {
    const baseline = this.memoryService.getMemory(event.memoryId);
    if (baseline && Date.parse(baseline.updatedAt) > Date.parse(candidate.updatedAt)) {
      await this.syncDerivedStores(baseline);
      event.status = "done";
      this.memoryService.updateEvent(event);
      return baseline.id;
    }
    const checkpoints = new ProcessingCheckpoints();

    // Model processing improves presentation but is never a prerequisite for saving valid text.
    let cards =
      event.decisionReasonCode === "AUTO_PUBLISH_SOURCE"
        ? null
        : checkpoints.read<ExtractedCard[]>(event, candidate, "extraction");
    if (!cards && event.decisionReasonCode !== "AUTO_PUBLISH_SOURCE") {
      try {
        cards = await this.extraction.extract(candidate);
      } catch {
        cards = null;
      }
    }
    if (!cards || cards.length === 0) {
      cards = [
        {
          title: candidate.title,
          summary: candidate.summary,
          content: candidate.content,
          tags: candidate.tags,
        },
      ];
      event.decisionReasonCode = "PUBLISHED_SOURCE_FALLBACK";
      event.decisionReason = "AI 整理不可用，已保留完整原文供检索";
      event.dependency = undefined;
    }

    checkpoints.write(event, candidate, "extraction", cards);
    const latest = this.memoryService.getMemory(event.memoryId);
    if (
      checkpoints.isSuperseded(event) ||
      latest?.updatedAt !== baseline?.updatedAt ||
      latest?.version !== baseline?.version
    ) {
      event.status = "pending";
      event.decisionReasonCode = "STALE_CONTENT_VERSION";
      event.decisionReason = "加工期间已有内容变更，重新处理最新内容";
      this.memoryService.updateEvent(event);
      return;
    }
    const anchorId = await this.commitExtractedCards(event, candidate, cards);
    if (baseline?.evidence?.sourceHash)
      await this.deleteExtractedCards(event.memoryId, cards.length + 1);

    event.status = "done";
    this.memoryService.updateEvent(event);
    return anchorId;
  }

  private async commitOptimizedNewMemory(
    event: PendingEvent,
    candidate: MemoryRecord,
  ): Promise<string> {
    const newId = await this.commitNewMemory(event, candidate);
    event.status = "done";
    this.memoryService.updateEvent(event);
    return newId;
  }

  /**
   * 提交一次抽取产出的多张中文卡片：
   * 首卡沿用队列稳定 ID（作为来源锚点，维持跳过/去重语义），后续卡片用 -p2、-p3… 后缀。
   * 每张卡片独立生成向量、分类并同步派生存储。
   */
  private async commitExtractedCards(
    event: PendingEvent,
    candidate: MemoryRecord,
    cards: ExtractedCard[],
  ): Promise<string> {
    const hash = sourceHashOf(candidate.content);
    let anchorId = "";
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const id = i === 0 ? event.memoryId : `${event.memoryId}-p${i + 1}`;
      const record: MemoryRecord = {
        ...candidate,
        id,
        title: card.title,
        titleZh: card.title,
        summary: card.summary,
        summaryZh: card.summary,
        content:
          i === 0 && card.content.trim() !== candidate.content.trim()
            ? `${card.content}\n\n## 来源原文\n\n${candidate.content}`
            : card.content,
        tags: card.tags.length > 0 ? card.tags : candidate.tags,
        tagsZh: card.tags.length > 0 ? card.tags : candidate.tagsZh,
        evidence: {
          ...candidate.evidence,
          text: candidate.evidence?.text ?? candidate.content.slice(0, 500),
          location: candidate.evidence?.location,
          sourceHash: hash,
        },
      };
      const previous = this.memoryService.getMemory(id);
      if (previous && Date.parse(previous.updatedAt) > Date.parse(candidate.updatedAt)) {
        await this.syncDerivedStores(previous);
        if (i === 0) anchorId = id;
        continue;
      }
      if (previous) {
        const versions = new VersionManager();
        try {
          if (!versions.getSnapshot(id, previous.version))
            versions.createSnapshot(previous, previous.version);
        } finally {
          versions.close();
        }
        this.memoryService.updateMemory(id, { ...record, version: previous.version + 1 });
        await this.refreshVector(id, record.content);
      } else {
        await this.memoryService.createMemoryRecord(record);
      }
      // 分类是派生信息：失败只记日志，不影响已入库的记忆
      try {
        this.memoryService.classifyMemory(id, card.content);
      } catch (err) {
        logger.ingest.error("记忆分类失败（不阻塞入库）", {
          memoryId: id,
          error: (err as Error).message,
        });
      }
      await this.syncDerivedStores(this.memoryService.getMemory(id) ?? record);
      if (previous && previous.topic !== record.topic) {
        this.deferredTopics.add(previous.topic);
        await deleteFile(getNotePath(previous.topic, previous.id));
      }
      if (i === 0) anchorId = id;
    }
    return anchorId;
  }

  /**
   * 重建采集卡片：删除所有 sourceType=ingest 的文件采集记忆（SQLite + 向量 + 派生 Markdown），
   * 由调用方随后全量重扫重新入队。用于清理旧入库链路（原文直存、英文/乱码大杂烩）留下的历史卡片——
   * 这些卡片 content 与原文一致，重扫会被内容跳过；不删则向量去重也会把重采事件拒掉，永远无法重生成。
   * 对话/手动/MCP 创建的记忆不受影响。返回删除的卡片数。
   */
  async rebuildCollectedMemories(): Promise<number> {
    const collected = this.memoryService.listCollectedMemories();
    for (const memory of collected) {
      // 派生 Markdown 必须先删：残留文件会被重扫重新入队，把旧卡原样捞回来
      await deleteFile(getNotePath(memory.topic, memory.id)).catch(() => {
        // 文件可能不存在（同步失败或从未写出），忽略
      });
      this.memoryService.deleteMemory(memory.id);
    }
    await this.refreshStudyGuides(new Set(collected.map((memory) => memory.topic)));
    if (collected.length > 0) {
      logger.ingest.info(`[Orchestrator] 重建：已删除 ${collected.length} 张采集卡片，待重扫重采`);
    }
    return collected.length;
  }

  /** 删除一次抽取的全部历史卡片（首卡 + -p 后缀分卡），用于来源内容变更后的整体重建 */
  private async deleteExtractedCards(anchorId: string, startIndex = 1): Promise<void> {
    const ids = startIndex === 1 ? [anchorId] : [];
    for (let i = Math.max(startIndex, 2); i <= 32; i++) {
      const id = `${anchorId}-p${i}`;
      if (!this.memoryService.getMemory(id)) break;
      ids.push(id);
    }
    for (const id of ids) {
      const memory = this.memoryService.getMemory(id);
      if (memory) {
        const versions = new VersionManager();
        try {
          versions.createSnapshot(memory, memory.version);
        } finally {
          versions.close();
        }
        this.deferredTopics.add(memory.topic);
        // 派生 Markdown 一并删除：残留文件会被重扫重新入队，与重建出的新分卡重复
        await deleteFile(getNotePath(memory.topic, memory.id)).catch(() => {
          // 文件可能不存在，忽略
        });
      }
      this.memoryService.deleteMemory(id);
    }
  }

  /** 新建落盘：建 SQLite 记录（真源）+ 分类 + 派生同步。自动发布流程共用。 */
  private async commitNewMemory(event: PendingEvent, candidate: MemoryRecord): Promise<string> {
    if (candidate.id !== event.memoryId) {
      throw new MemoryValidationError(
        "id",
        `候选记忆 ID (${candidate.id}) 与队列 memoryId (${event.memoryId}) 不一致`,
      );
    }

    const newId = await this.memoryService.createMemoryRecord(candidate);
    // 分类是派生信息：失败只记日志，不影响已入库的记忆
    try {
      this.memoryService.classifyMemory(newId, candidate.content);
    } catch (err) {
      logger.ingest.error("记忆分类失败（不阻塞入库）", {
        memoryId: newId,
        error: (err as Error).message,
      });
    }
    await this.syncDerivedStores(this.memoryService.getMemory(newId) ?? candidate);
    return newId;
  }

  private async refreshVector(memoryId: string, content: string): Promise<void> {
    const vectorIndex = new VectorIndex();
    try {
      const vectorRecord = await buildVectorRecord(memoryId, content);
      vectorIndex.create(vectorRecord);
      this.memoryService.setVectorId(memoryId, memoryId);
    } catch (vectorError) {
      logger.vector.warn("更新向量失败，记忆仍会继续保存:", {
        error: (vectorError as Error).message,
      });
    } finally {
      vectorIndex.close();
    }
  }

  getPendingEvents(opts?: { limit?: number }): PendingEvent[] {
    return this.memoryService.getPendingEvents(opts);
  }

  private async refreshStudyGuides(topics: Iterable<string>): Promise<void> {
    const builder = new StudyGuideBuilder();
    try {
      await builder.refreshTopics(topics);
    } finally {
      builder.close();
    }
  }

  private parseCandidate(event: PendingEvent): MemoryRecord {
    try {
      const candidate = JSON.parse(event.candidate) as MemoryRecord;
      if (
        !validateMemoryRecord(candidate) ||
        !candidate.content.trim() ||
        candidate.id !== event.memoryId
      ) {
        throw new Error("候选数据格式无效或身份不一致");
      }
      return candidate;
    } catch (error) {
      throw new MemoryValidationError(
        "candidate",
        `PendingEvent ${event.eventId} for memory ${event.memoryId} contains invalid candidate JSON: ${
          (error as Error).message
        }`,
      );
    }
  }

  /** 重试失败事件：将 retryCount < 3 的失败事件重置为 pending。供 AuditWorker 调用。 */
  retryFailedEvents(): number {
    const memory = this.memoryService;
    const pending = memory.getRetryableFailedEvents(
      dependencyConfig.batchSize,
      dependencyConfig.retryDelaysMs.length,
    );
    let retried = 0;

    for (const event of pending) {
      memory.updateEvent({ ...event, status: "pending" });
      retried++;
    }
    return retried;
  }

  close(): void {
    this.memoryService.close();
    this.auditor.close();
    this.reporter.close();
  }
}
