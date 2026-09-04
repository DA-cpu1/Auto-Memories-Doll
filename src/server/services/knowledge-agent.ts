import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { InputParser } from "../../features/ingest/parser";
import { InputNormalizer } from "../../features/ingest/normalizer";
import { IngestAdapter } from "../../features/ingest/adapter";
import { ConversationProcessor, KnowledgeCard } from "../../features/ingest/conversation-processor";
import { buildKnowledgeLogFromText } from "../../features/ingest/knowledge-log";
import { assertAgentStageTransition } from "../../features/agent/state-machine";
import { buildMemoryRecord } from "../../lib/memory/builder";
import { validateMemoryRecord } from "../../lib/memory/validator";
import { getDatabase } from "../../lib/storage/database";
import { parseMemoryFromText } from "../../lib/storage/markdown-parser";
import { parseSourceRevisionEvent } from "../../lib/source/source-revision";
import { parseSession, ParsedSession } from "../../lib/tools/session-parser";
import { logger } from "../../lib/logger";
import { KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import { normalizeTextWithReport } from "../../lib/utils/normalization";
import { splitSemanticText } from "../pipelines/splitter";
import type { AgentProgressEvent, AgentProgressOutcome, AgentStage } from "../../types/agent";
import type { ToolWatchSource } from "../../types/config";
import type {
  ConversationData,
  MemoryEvidence,
  MemoryKind,
  MemoryRecord,
  PendingEvent,
} from "../../types/memory";
import type { SourceDocument, SourceRevisionEvent } from "../../types/source";
import type { NormalizationReport, SourceChunk } from "../../types/normalization";
import { MemoryService } from "./memory-service";
import { Orchestrator } from "./orchestrator";
import { SourceRegistry } from "./source-registry";

export type SourceRevisionInput = {
  event: SourceRevisionEvent;
  content?: string;
  /** 保留来源原始路径作为证据 locator；sourceEvent.sourcePath 始终是规范路径。 */
  sourceLocator?: string;
  toolSource?: ToolWatchSource;
  conversation?: ConversationData;
};

export type SourceRevisionIngestResult = {
  status: "staged" | "unchanged" | "ignored";
  sourceEvent: SourceRevisionEvent;
  memoryIds: string[];
  topic?: string;
  knowledgeCard?: KnowledgeCard & { content: string };
  normalizationReport?: NormalizationReport;
};

type ParsedSource =
  | { kind: "delete"; locator?: string; source?: ToolWatchSource }
  | { kind: "document"; content: string; locator?: string }
  | {
      kind: "tool";
      content: string;
      locator: string;
      session: ParsedSession;
      source: ToolWatchSource;
    }
  | { kind: "listen"; conversation: ConversationData };

type NormalizedSource = {
  records: MemoryRecord[];
  chunks: SourceChunk[];
  normalizationReport: NormalizationReport;
  deleteMemoryIds?: string[];
  topic?: string;
  knowledgeCard?: KnowledgeCard & { content: string };
};

type NormalizedRecords = Omit<NormalizedSource, "chunks" | "normalizationReport">;

type ProgressRow = {
  progressId: string;
  eventId: string;
  sourceId: string;
  revision: string;
  memoryId: string | null;
  stage: string;
  attempt: number;
  timestamp: string;
  durationMs: number;
  outcome: string;
  errorCode: string | null;
  error: string | null;
  retryable: number;
  degradedCapabilities: string;
};

const inFlightSourceRevisions = new Map<string, Promise<SourceRevisionIngestResult>>();

export class KnowledgeAgent {
  private readonly db: Database.Database;
  private readonly memoryService: MemoryService;
  private readonly sourceRegistry: SourceRegistry;

  constructor(db: Database.Database = getDatabase()) {
    this.db = db;
    this.memoryService = new MemoryService();
    this.sourceRegistry = new SourceRegistry(db);
    this.initProgressStore();
  }

  ingestSourceRevision(input: SourceRevisionInput): Promise<SourceRevisionIngestResult> {
    const active = inFlightSourceRevisions.get(input.event.eventId);
    if (active) return active;
    const processing = this.ingestSourceRevisionOnce(input).finally(() => {
      inFlightSourceRevisions.delete(input.event.eventId);
    });
    inFlightSourceRevisions.set(input.event.eventId, processing);
    return processing;
  }

  private async ingestSourceRevisionOnce(
    input: SourceRevisionInput,
  ): Promise<SourceRevisionIngestResult> {
    const event = parseSourceRevisionEvent(input.event);
    const observation = this.sourceRegistry.beginObservation(event);
    if (observation.disposition === "unchanged") {
      return this.restoreUnchangedResult(event);
    }

    const startedAt = Date.now();
    const previousProgress = this.latestProgress(event.eventId);
    let stage: AgentStage = previousProgress?.stage ?? "discovered";
    if (!previousProgress) this.recordProgress(event, stage, "completed", startedAt);

    try {
      stage = this.transition(event, stage, "parsing", startedAt);
      const parsed = await this.parseInput(input);

      stage = this.transition(event, stage, "normalizing", startedAt);
      const normalized = this.normalizeInput(event, parsed);
      const records = normalized.records;
      const version = this.sourceRegistry.recordVersion(
        event,
        normalized.normalizationReport,
        normalized.chunks,
      );

      if (version.normalizedUnchanged && event.operation !== "delete") {
        this.sourceRegistry.markProcessed(event);
        this.transition(event, stage, "done", startedAt, records[0]?.id, "skipped");
        return {
          status: "unchanged",
          sourceEvent: event,
          memoryIds: records.map((record) => record.id),
          topic: normalized.topic,
          knowledgeCard: normalized.knowledgeCard,
          normalizationReport: normalized.normalizationReport,
        };
      }

      const cancelledMemoryIds = normalized.deleteMemoryIds
        ? this.memoryService.cancelUnpublishedSourceEvents(event.sourceId)
        : [];
      if (normalized.deleteMemoryIds && normalized.deleteMemoryIds.length > 0) {
        const sourceRevision = {
          sourceEventId: event.eventId,
          sourceId: event.sourceId,
          revision: event.revision,
        };
        for (const memoryId of normalized.deleteMemoryIds) {
          this.memoryService.stageDeleteMemory(memoryId, sourceRevision);
        }
        this.sourceRegistry.markProcessed(event);
        this.transition(event, stage, "staged", startedAt, normalized.deleteMemoryIds[0]);
        return {
          status: "staged",
          sourceEvent: event,
          memoryIds: normalized.deleteMemoryIds,
          normalizationReport: normalized.normalizationReport,
        };
      }

      if (cancelledMemoryIds.length > 0) {
        this.sourceRegistry.markProcessed(event);
        this.transition(event, stage, "done", startedAt, cancelledMemoryIds[0], "completed");
        return {
          status: "ignored",
          sourceEvent: event,
          memoryIds: cancelledMemoryIds,
          normalizationReport: normalized.normalizationReport,
        };
      }

      if (records.length === 0) {
        this.sourceRegistry.markProcessed(event);
        this.transition(event, stage, "done", startedAt, undefined, "skipped");
        return {
          status: "ignored",
          sourceEvent: event,
          memoryIds: [],
          topic: normalized.topic,
          knowledgeCard: normalized.knowledgeCard,
          normalizationReport: normalized.normalizationReport,
        };
      }

      const memoryIds = records.map((record) => this.stageRecord(event, record));
      this.sourceRegistry.markProcessed(event);
      this.transition(event, stage, "staged", startedAt, memoryIds[0]);
      return {
        status: "staged",
        sourceEvent: event,
        memoryIds,
        topic: normalized.topic,
        knowledgeCard: normalized.knowledgeCard,
        normalizationReport: normalized.normalizationReport,
      };
    } catch (error) {
      this.sourceRegistry.markFailed(event, error instanceof Error ? error.message : String(error));
      this.transition(event, stage, "failed_retryable", startedAt, undefined, "failed", error);
      throw error;
    }
  }

  getSource(sourceId: string): SourceDocument | null {
    return this.sourceRegistry.getSource(sourceId);
  }

  listSources(): SourceDocument[] {
    return this.sourceRegistry.listSources();
  }

  recoverInterruptedEvents(): number {
    const interrupted = this.memoryService.getEventsByStatus("processing");
    const recover = this.db.transaction(() => {
      for (const pendingEvent of interrupted) {
        if (!pendingEvent.sourceEventId || !pendingEvent.sourceId || !pendingEvent.sourceRevision) {
          continue;
        }
        const source = this.sourceRegistry.getSource(pendingEvent.sourceId);
        const sourceEvent: SourceRevisionEvent = {
          eventId: pendingEvent.sourceEventId,
          sourceId: pendingEvent.sourceId,
          sourceType:
            source?.sourceType ?? (pendingEvent.sourceType === "listen" ? "listen" : "markdown"),
          sourcePath: source?.sourcePath,
          revision: pendingEvent.sourceRevision,
          observedAt: source?.lastObservedAt ?? pendingEvent.createdAt,
          operation: "rescan",
        };
        const latest = this.listProgress({ eventId: sourceEvent.eventId }).at(-1);
        let current = latest?.stage ?? "staged";
        const startedAt = Date.now();
        if (current !== "processing") {
          current = this.transition(
            sourceEvent,
            current,
            "processing",
            startedAt,
            pendingEvent.memoryId,
          );
        }
        current = this.transition(
          sourceEvent,
          current,
          "failed_retryable",
          startedAt,
          pendingEvent.memoryId,
          "failed",
          new Error("进程在 processing 阶段中断"),
        );
        this.transition(sourceEvent, current, "staged", startedAt, pendingEvent.memoryId);
      }
      return this.memoryService.resetProcessingEvents();
    });
    return recover();
  }

  async processQueue(): Promise<void> {
    const pendingEvents = this.memoryService.getPendingEvents({ limit: 100 });
    const tracked: Array<{
      event: (typeof pendingEvents)[number];
      sourceEvent: SourceRevisionEvent;
    }> = [];
    for (const event of pendingEvents) {
      const sourceEvent = this.sourceEventForPending(event);
      if (sourceEvent) tracked.push({ event, sourceEvent });
    }

    for (const { event, sourceEvent } of tracked) {
      const current = this.listProgress({ eventId: sourceEvent.eventId }).at(-1)?.stage ?? "staged";
      this.transition(sourceEvent, current, "processing", Date.now(), event.memoryId);
    }

    const orchestrator = new Orchestrator();
    try {
      await orchestrator.processQueue();
    } finally {
      orchestrator.close();
    }

    for (const { event, sourceEvent } of tracked) {
      const persisted = this.memoryService.getEvent(event.eventId);
      if (!persisted) continue;
      const startedAt = Date.now();
      switch (persisted.status) {
        case "done": {
          if (event.eventType === "delete") {
            this.transition(sourceEvent, "processing", "done", startedAt, event.memoryId);
            break;
          }
          const waitingConflict = this.db
            .prepare(
              "SELECT 1 FROM conflict_records WHERE eventId = ? AND status = 'pending' LIMIT 1",
            )
            .get(event.eventId);
          if (waitingConflict) {
            this.transition(
              sourceEvent,
              "processing",
              "review",
              startedAt,
              event.memoryId,
              "waiting",
            );
            break;
          }
          this.linkPublishedMemory(sourceEvent, event.memoryId);
          let current: AgentStage = "processing";
          current = this.transition(sourceEvent, current, "accepted", startedAt, event.memoryId);
          current = this.transition(sourceEvent, current, "publishing", startedAt, event.memoryId);
          current = this.transition(sourceEvent, current, "indexed", startedAt, event.memoryId);
          this.transition(sourceEvent, current, "done", startedAt, event.memoryId);
          break;
        }
        case "review":
          this.transition(
            sourceEvent,
            "processing",
            "review",
            startedAt,
            event.memoryId,
            "waiting",
          );
          break;
        case "rejected":
          this.transition(sourceEvent, "processing", "rejected", startedAt, event.memoryId);
          break;
        case "failed":
          this.transition(
            sourceEvent,
            "processing",
            "failed_retryable",
            startedAt,
            event.memoryId,
            "failed",
            new Error("队列处理失败，可安全重试"),
          );
          break;
        case "pending": {
          const failed = this.transition(
            sourceEvent,
            "processing",
            "failed_retryable",
            startedAt,
            event.memoryId,
            "waiting",
          );
          this.transition(sourceEvent, failed, "staged", startedAt, event.memoryId, "waiting");
          break;
        }
      }
    }
  }

  retryFailedEvents(): number {
    const orchestrator = new Orchestrator();
    try {
      return orchestrator.retryFailedEvents();
    } finally {
      orchestrator.close();
    }
  }

  getPendingEvents() {
    return this.memoryService.getPendingEvents();
  }

  getReviewEvents(limit?: number): PendingEvent[] {
    return this.memoryService.getEventsByStatus("review", limit);
  }

  updateReviewCandidate(
    eventId: string,
    updates: Pick<MemoryRecord, "title" | "summary" | "content" | "tags" | "topic">,
  ): PendingEvent {
    const event = this.memoryService.getEvent(eventId);
    if (!event || event.status !== "review") {
      throw new Error("待审核事件不存在或状态已变化");
    }

    const candidate = JSON.parse(event.candidate) as MemoryRecord;
    const nextCandidate: MemoryRecord = {
      ...candidate,
      ...updates,
      title: updates.title.trim(),
      summary: updates.summary.trim(),
      content: updates.content.trim(),
      tags: updates.tags.map((tag) => tag.trim()).filter(Boolean),
      topic: updates.topic.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (!validateMemoryRecord(nextCandidate)) {
      throw new Error("编辑后的候选不符合记忆结构约束");
    }
    this.memoryService.updateEventCandidate(eventId, nextCandidate, [
      ...new Set([...event.changedFields, "title", "summary", "content", "tags", "topic"]),
    ]);
    return { ...event, candidate: JSON.stringify(nextCandidate) };
  }

  async processIngest(
    source: string,
    sourceType: "chat" | "ingest" | "manual" | "mcp" | "skill",
    content: string,
    title: string,
    summary: string,
    tags: string[] = [],
    meta?: { kind?: MemoryKind; evidence?: MemoryEvidence },
  ): Promise<string> {
    const orchestrator = new Orchestrator();
    try {
      return await orchestrator.processIngest(
        source,
        sourceType,
        content,
        title,
        summary,
        tags,
        meta,
      );
    } finally {
      orchestrator.close();
    }
  }

  async enqueueFullMemoryRebuild(): Promise<number> {
    const orchestrator = new Orchestrator();
    try {
      return await orchestrator.enqueueFullMemoryRebuild();
    } finally {
      orchestrator.close();
    }
  }

  async rebuildCollectedMemories(): Promise<number> {
    const orchestrator = new Orchestrator();
    try {
      return await orchestrator.rebuildCollectedMemories();
    } finally {
      orchestrator.close();
    }
  }

  async resolveReviewEvent(eventId: string, action: "accept" | "reject"): Promise<PendingEvent> {
    const before = this.memoryService.getEvent(eventId);
    const sourceEvent = before ? this.sourceEventForPending(before) : null;
    const orchestrator = new Orchestrator();
    try {
      const resolved = await orchestrator.resolveReviewEvent(eventId, action);
      if (action === "accept" && sourceEvent)
        this.linkPublishedMemory(sourceEvent, resolved.memoryId);
      if (sourceEvent && this.latestProgress(sourceEvent.eventId)?.stage === "review") {
        this.recordReviewResolution(sourceEvent, resolved.memoryId, action);
      }
      return resolved;
    } finally {
      orchestrator.close();
    }
  }

  async resolveConflict(
    conflictId: string,
    resolution: "accept" | "keep" | "manual",
    manualValue?: string,
  ): Promise<MemoryRecord> {
    const conflict = this.db
      .prepare("SELECT eventId FROM conflict_records WHERE conflictId = ?")
      .get(conflictId) as { eventId: string } | undefined;
    const pending = conflict ? this.memoryService.getEvent(conflict.eventId) : null;
    const sourceEvent = pending ? this.sourceEventForPending(pending) : null;
    const orchestrator = new Orchestrator();
    try {
      const memory = await orchestrator.resolveConflict(conflictId, resolution, manualValue);
      if (sourceEvent && resolution !== "keep") this.linkPublishedMemory(sourceEvent, memory.id);
      if (sourceEvent && this.latestProgress(sourceEvent.eventId)?.stage === "review") {
        this.recordReviewResolution(sourceEvent, memory.id, "accept");
      }
      return memory;
    } finally {
      orchestrator.close();
    }
  }

  listProgress(options?: { eventId?: string; limit?: number }): AgentProgressEvent[] {
    const params: Array<string | number> = [];
    const conditions: string[] = [];
    if (options?.eventId) {
      conditions.push("eventId = ?");
      params.push(options.eventId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options?.limit && options.limit > 0 ? " LIMIT ?" : "";
    if (limit) params.push(options!.limit!);
    const rows = this.db
      .prepare(`SELECT * FROM processing_attempts ${where} ORDER BY id ASC${limit}`)
      .all(...params) as ProgressRow[];
    return rows.map((row) => this.mapProgressRow(row));
  }

  listRecentProgress(limit = 50): AgentProgressEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM processing_attempts ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, limit)) as ProgressRow[];
    return rows.reverse().map((row) => this.mapProgressRow(row));
  }

  close(): void {
    this.memoryService.close();
    this.sourceRegistry.close();
  }

  private initProgressStore(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processing_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        progressId TEXT UNIQUE NOT NULL,
        eventId TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        memoryId TEXT,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        timestamp TEXT NOT NULL,
        durationMs INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        errorCode TEXT,
        error TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        degradedCapabilities TEXT NOT NULL DEFAULT '[]'
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_processing_attempts_event ON processing_attempts(eventId, id)",
    );
  }

  private restoreUnchangedResult(event: SourceRevisionEvent): SourceRevisionIngestResult {
    const memoryIds = [
      ...new Set(
        this.listProgress({ eventId: event.eventId })
          .map((item) => item.memoryId)
          .filter((memoryId): memoryId is string => Boolean(memoryId)),
      ),
    ];
    let memory = memoryIds.length > 0 ? this.memoryService.getMemory(memoryIds[0]) : null;
    if (!memory) {
      const row = this.db
        .prepare(
          "SELECT candidate FROM pending_events WHERE sourceEventId = ? ORDER BY createdAt ASC LIMIT 1",
        )
        .get(event.eventId) as { candidate: string } | undefined;
      if (row) {
        try {
          memory = JSON.parse(row.candidate) as MemoryRecord;
        } catch {
          memory = null;
        }
      }
    }

    return {
      status: "unchanged",
      sourceEvent: event,
      memoryIds,
      topic: memory?.topic,
      knowledgeCard:
        event.sourceType === "listen" && memory
          ? {
              title: memory.title,
              titleZh: memory.titleZh,
              summary: memory.summary,
              content: memory.content,
              tags: memory.tags,
              tagsZh: memory.tagsZh,
              topic: memory.topic,
              topicZh: memory.topicZh,
            }
          : undefined,
    };
  }

  private recordReviewResolution(
    sourceEvent: SourceRevisionEvent,
    memoryId: string,
    action: "accept" | "reject",
  ): void {
    const startedAt = Date.now();
    if (action === "reject") {
      this.transition(sourceEvent, "review", "rejected", startedAt, memoryId);
      return;
    }
    let current: AgentStage = "review";
    current = this.transition(sourceEvent, current, "accepted", startedAt, memoryId);
    current = this.transition(sourceEvent, current, "publishing", startedAt, memoryId);
    current = this.transition(sourceEvent, current, "indexed", startedAt, memoryId);
    this.transition(sourceEvent, current, "done", startedAt, memoryId);
  }

  private sourceEventForPending(
    event: import("../../types/memory").PendingEvent,
  ): SourceRevisionEvent | null {
    if (!event.sourceEventId || !event.sourceId || !event.sourceRevision) return null;
    const source = this.sourceRegistry.getSource(event.sourceId);
    return {
      eventId: event.sourceEventId,
      sourceId: event.sourceId,
      sourceType: source?.sourceType ?? (event.sourceType === "listen" ? "listen" : "markdown"),
      sourcePath: source?.sourcePath,
      revision: event.sourceRevision,
      observedAt: source?.lastObservedAt ?? event.createdAt,
      operation: "rescan" as const,
    } satisfies SourceRevisionEvent;
  }

  private async parseInput(input: SourceRevisionInput): Promise<ParsedSource> {
    const { event } = input;
    if (event.operation === "delete") {
      return {
        kind: "delete",
        locator: input.sourceLocator ?? event.sourcePath,
        source: input.toolSource,
      };
    }
    if (event.sourceType === "listen") {
      if (!input.conversation) throw new Error("listen 来源缺少 conversation payload");
      return { kind: "listen", conversation: input.conversation };
    }

    const sourcePath = input.sourceLocator ?? event.sourcePath;
    if (!sourcePath) throw new Error(`来源 ${event.sourceId} 缺少可读取路径`);
    if (!input.toolSource && (event.sourceType === "markdown" || event.sourceType === "text")) {
      return {
        kind: "document",
        content: input.content ?? (await readFile(sourcePath, "utf-8")),
        locator: sourcePath,
      };
    }
    if (!input.toolSource) throw new Error(`来源类型 ${event.sourceType} 缺少工具来源配置`);
    const session = await parseSession(sourcePath, input.toolSource.toolType);
    if (!session || session.messageCount === 0) {
      return {
        kind: "tool",
        content: "",
        locator: sourcePath,
        session: {
          title: "",
          content: "",
          source: input.toolSource.toolType,
          sourceFile: sourcePath,
          timestamp: new Date().toISOString(),
          messageCount: 0,
        },
        source: input.toolSource,
      };
    }
    return {
      kind: "tool",
      content: limitSessionContent(session.content),
      locator: sourcePath,
      session,
      source: input.toolSource,
    };
  }

  private normalizeInput(event: SourceRevisionEvent, parsed: ParsedSource): NormalizedSource {
    const emptyReport: NormalizationReport = {
      inputCharacters: 0,
      outputCharacters: 0,
      removedNoise: [],
    };
    if (parsed.kind === "delete") {
      const fallbackId = parsed.source
        ? stableToolMemoryId(parsed.source.id, parsed.locator ?? event.sourceId)
        : event.sourceType === "listen"
          ? stableListenMemoryId(event.sourceId)
          : stableFileMemoryId(parsed.locator ?? event.sourceId);
      const historicalIds = this.db
        .prepare(
          `SELECT DISTINCT memoryId FROM processing_attempts
           WHERE sourceId = ? AND memoryId IS NOT NULL
           ORDER BY id DESC`,
        )
        .all(event.sourceId) as Array<{ memoryId: string }>;
      const memoryIds = [
        ...new Set([...historicalIds.map((row) => row.memoryId), fallbackId]),
      ].filter((memoryId) => Boolean(this.memoryService.getMemory(memoryId)));
      return {
        records: [],
        chunks: [],
        normalizationReport: emptyReport,
        deleteMemoryIds: memoryIds,
      };
    }
    if (parsed.kind === "document") {
      const normalized = normalizeTextWithReport(parsed.content);
      const chunks = splitSemanticText(normalized.content, { sourceId: event.sourceId });
      return {
        records: this.normalizeDocument(event, normalized.content, parsed.locator, chunks),
        chunks,
        normalizationReport: normalized.report,
      };
    }
    if (parsed.kind === "tool") {
      const normalized = normalizeTextWithReport(parsed.content);
      const chunks = splitSemanticText(normalized.content, { sourceId: event.sourceId });
      const result = this.normalizeToolSession(
        event,
        { ...parsed, content: normalized.content },
        chunks,
      );
      return { ...result, chunks, normalizationReport: normalized.report };
    }
    const result = this.normalizeListenConversation(event, parsed.conversation);
    const normalized = normalizeTextWithReport(result.records[0]?.content ?? "");
    const chunks = splitSemanticText(normalized.content, { sourceId: event.sourceId });
    const records = result.records.map((record) => ({
      ...record,
      content: normalized.content,
      evidence: this.sourceEvidence(event, record.evidence, chunks),
    }));
    return {
      ...result,
      records,
      chunks,
      normalizationReport: normalized.report,
      knowledgeCard: result.knowledgeCard
        ? { ...result.knowledgeCard, content: normalized.content }
        : undefined,
    };
  }

  private normalizeDocument(
    event: SourceRevisionEvent,
    content: string,
    sourceLocator?: string,
    chunks: SourceChunk[] = [],
  ): MemoryRecord[] {
    const locator = sourceLocator ?? event.sourcePath;
    if (content.length < 10) return [];
    if (content.startsWith("---")) {
      const record = parseMemoryFromText(content);
      if (record) {
        return [
          {
            ...record,
            id: record.id || stableFileMemoryId(locator ?? event.sourceId),
            source: record.source || locator || event.sourceId,
            evidence: this.sourceEvidence(
              event,
              {
                text: record.evidence?.text ?? content.slice(0, 500),
                location: record.evidence?.location ?? locator,
                sourceHash: event.revision,
              },
              chunks,
            ),
          },
        ];
      }
    }

    const parser = new InputParser();
    const normalizer = new InputNormalizer();
    const adapter = new IngestAdapter();
    const records = adapter.adaptBatch(normalizer.normalize([parser.parseText(content)]));
    return records.map((record) => ({
      ...record,
      id: stableFileMemoryId(locator ?? event.sourceId),
      source: locator ?? event.sourceId,
      sourceType: "ingest",
      evidence: this.sourceEvidence(
        event,
        {
          ...(record.evidence ?? {
            text: content.slice(0, 500),
            location: locator,
          }),
          sourceHash: event.revision,
        },
        chunks,
      ),
    }));
  }

  private normalizeToolSession(
    event: SourceRevisionEvent,
    parsed: Extract<ParsedSource, { kind: "tool" }>,
    chunks: SourceChunk[] = [],
  ): NormalizedRecords {
    if (!parsed.content || parsed.session.messageCount === 0) return { records: [] };
    const topic = parsed.source.topic || defaultTopicForTool(parsed.source.toolType);
    const tags = [parsed.source.toolType, "tool-session"];
    if (parsed.source.topic) tags.push(parsed.source.topic);
    const knowledgeLog = buildKnowledgeLogFromText(parsed.content, {
      source: parsed.source.name,
    });
    const record = buildMemoryRecord(
      `${parsed.source.name}:${parsed.locator}`,
      "ingest",
      parsed.session.title,
      knowledgeLog.content,
      knowledgeLog.summary,
      tags,
      topic,
      stableToolMemoryId(parsed.source.id, parsed.locator),
      undefined,
      {
        evidence: this.sourceEvidence(
          event,
          {
            text: parsed.content.slice(0, 500),
            location: parsed.locator,
            sourceHash: event.revision,
          },
          chunks,
        ),
      },
    );
    return { records: [record], topic };
  }

  private normalizeListenConversation(
    event: SourceRevisionEvent,
    conversation: ConversationData,
  ): NormalizedRecords {
    const processor = new ConversationProcessor();
    const { title, content, topic } = processor.formatConversation(conversation);
    const generated = processor.generateKnowledgeCard(conversation);
    const memoryContent = generated.content || content;
    const knowledgeCard = { ...generated, content: memoryContent };
    const record = buildMemoryRecord(
      conversation.source,
      "listen",
      title,
      memoryContent,
      generated.summary,
      generated.tags,
      topic,
      stableListenMemoryId(event.sourceId),
      {
        titleZh: generated.titleZh,
        summaryZh: generated.summary,
        tagsZh: generated.tagsZh,
        topicZh: generated.topicZh,
      },
      {
        evidence: this.sourceEvidence(event, {
          text: memoryContent.slice(0, 500),
          location: conversation.metadata?.url,
          sourceHash: event.revision,
        }),
      },
    );
    return { records: [record], topic, knowledgeCard };
  }

  private stageRecord(event: SourceRevisionEvent, record: MemoryRecord): string {
    const sourceRevision = {
      sourceEventId: event.eventId,
      sourceId: event.sourceId,
      revision: event.revision,
    };
    const existing = this.memoryService.getMemory(record.id);
    if (!existing) {
      if (this.memoryService.hasEquivalentPendingEvent(record.id, record.content)) return record.id;
      return this.memoryService.stageCreateMemoryRecord(record, sourceRevision);
    }
    if (existing.evidence?.sourceHash === event.revision) return existing.id;
    this.memoryService.stageUpdateMemory(record.id, fileUpdates(record), sourceRevision);
    return record.id;
  }

  private sourceEvidence(
    event: SourceRevisionEvent,
    evidence: MemoryEvidence | undefined,
    chunks: SourceChunk[] = [],
  ): MemoryEvidence {
    return {
      text: evidence?.text ?? chunks[0]?.content.slice(0, 500) ?? "",
      location: evidence?.location ?? event.sourcePath,
      sourceHash: evidence?.sourceHash ?? event.revision,
      sourceId: event.sourceId,
      sourceRevision: event.revision,
      sourceEventId: event.eventId,
      chunkHash: chunks.length === 1 ? chunks[0].hash : undefined,
    };
  }

  private linkPublishedMemory(event: SourceRevisionEvent, memoryId: string): void {
    const ids = (
      this.db
        .prepare("SELECT id FROM memories WHERE id = ? OR id GLOB ? ORDER BY id ASC")
        .all(memoryId, `${memoryId}-p[0-9]*`) as Array<{ id: string }>
    ).map((row) => row.id);
    for (const id of ids) {
      const memory = this.memoryService.getMemory(id);
      if (!memory) continue;
      this.sourceRegistry.linkMemory({
        sourceId: event.sourceId,
        revision: event.revision,
        memoryId: id,
        sourceEventId: event.eventId,
        chunkHash: memory.evidence?.chunkHash,
        locator: memory.evidence?.location ?? event.sourcePath,
      });
    }
  }

  private transition(
    event: SourceRevisionEvent,
    current: AgentStage,
    next: AgentStage,
    startedAt: number,
    memoryId?: string,
    outcome: AgentProgressOutcome = "completed",
    error?: unknown,
  ): AgentStage {
    const persisted = this.latestProgress(event.eventId);
    if (persisted && persisted.stage !== current) {
      throw new Error(
        `Agent 状态已变化: 期望 ${current}，实际 ${persisted.stage} (${event.eventId})`,
      );
    }
    assertAgentStageTransition(current, next);
    this.recordProgress(event, next, outcome, startedAt, memoryId, error);
    return next;
  }

  private recordProgress(
    event: SourceRevisionEvent,
    stage: AgentStage,
    outcome: AgentProgressOutcome,
    startedAt: number,
    memoryId?: string,
    error?: unknown,
  ): void {
    const latest = this.latestProgress(event.eventId);
    const attempt = latest
      ? latest.stage === "failed_retryable" && stage !== "failed_retryable"
        ? latest.attempt + 1
        : latest.attempt
      : 1;
    const progress: AgentProgressEvent = {
      progressId: `progress-${randomUUID()}`,
      eventId: event.eventId,
      sourceId: event.sourceId,
      revision: event.revision,
      memoryId,
      stage,
      attempt,
      timestamp: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
      errorCode: error ? "SOURCE_PROCESSING_FAILED" : undefined,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
      retryable: stage === "failed_retryable",
      degradedCapabilities: KnowledgeModelAdapter.getDegradedCapabilities(),
    };
    this.db
      .prepare(
        `INSERT INTO processing_attempts (
           progressId, eventId, sourceId, revision, memoryId, stage, attempt,
           timestamp, durationMs, outcome, errorCode, error, retryable, degradedCapabilities
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        progress.progressId,
        progress.eventId,
        progress.sourceId,
        progress.revision,
        progress.memoryId ?? null,
        progress.stage,
        progress.attempt,
        progress.timestamp,
        progress.durationMs,
        progress.outcome,
        progress.errorCode ?? null,
        progress.error ?? null,
        progress.retryable ? 1 : 0,
        JSON.stringify(progress.degradedCapabilities),
      );
    logger.agent.info("KnowledgeAgent progress", {
      sourceId: progress.sourceId,
      revision: progress.revision,
      eventId: progress.eventId,
      memoryId: progress.memoryId,
      stage: progress.stage,
      attempt: progress.attempt,
      durationMs: progress.durationMs,
      outcome: progress.outcome,
      errorCode: progress.errorCode,
      retryable: progress.retryable,
      degradedCapabilities: progress.degradedCapabilities,
    });
  }

  private mapProgressRow(row: ProgressRow): AgentProgressEvent {
    return {
      progressId: row.progressId,
      eventId: row.eventId,
      sourceId: row.sourceId,
      revision: row.revision,
      memoryId: row.memoryId ?? undefined,
      stage: row.stage as AgentStage,
      attempt: row.attempt,
      timestamp: row.timestamp,
      durationMs: row.durationMs,
      outcome: row.outcome as AgentProgressOutcome,
      errorCode: row.errorCode ?? undefined,
      error: row.error ?? undefined,
      retryable: Boolean(row.retryable),
      degradedCapabilities: JSON.parse(row.degradedCapabilities) as Array<"llm" | "embedding">,
    };
  }

  private latestProgress(eventId: string): AgentProgressEvent | null {
    const row = this.db
      .prepare("SELECT * FROM processing_attempts WHERE eventId = ? ORDER BY id DESC LIMIT 1")
      .get(eventId) as ProgressRow | undefined;
    return row ? this.mapProgressRow(row) : null;
  }
}

function stableFileMemoryId(identity: string): string {
  return `file-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function stableToolMemoryId(sourceId: string, filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  return `tool-${createHash("sha256")
    .update(`${sourceId}:${normalizedPath}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function stableListenMemoryId(sourceId: string): string {
  return `listen-${sourceId.slice("source-".length)}`;
}

function limitSessionContent(content: string): string {
  const maximumCharacters = 10_000;
  if (content.length <= maximumCharacters) return content;
  const tailLength = 2_500;
  const headLength = maximumCharacters - tailLength;
  return `${content.slice(0, headLength)}\n\n<!-- 中间内容已截断，原文 ${content.length} 字符 -->\n\n${content.slice(-tailLength)}`;
}

function defaultTopicForTool(toolType: string): string {
  switch (toolType) {
    case "codex":
      return "codex-sessions";
    case "claude-code":
      return "claude-code-sessions";
    case "cursor":
      return "cursor-sessions";
    default:
      return "tool-sessions";
  }
}

function fileUpdates(record: MemoryRecord): Partial<MemoryRecord> {
  return {
    source: record.source,
    sourceType: record.sourceType,
    title: record.title,
    titleZh: record.titleZh,
    content: record.content,
    summary: record.summary,
    summaryZh: record.summaryZh,
    tags: record.tags,
    tagsZh: record.tagsZh,
    topic: record.topic,
    topicZh: record.topicZh,
    kind: record.kind,
    evidence: record.evidence,
    graphLinks: record.graphLinks,
  };
}
