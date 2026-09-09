import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { closeDatabase, getDatabase } from "../lib/storage/database";
import { invalidatePathCache, getNotePath } from "../lib/storage/path-resolver";
import { MemoryService } from "../server/services/memory-service";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { ModelDependencyError } from "../lib/ai/dependency-error";
import { QualityFilterService } from "../server/services/quality-filter-service";
import { MemoryExtractionService } from "../server/services/memory-extraction-service";
import { DependencyRecovery } from "../server/services/dependency-recovery";
import { buildMemoryRecord } from "../lib/memory/builder";
import { ProcessingCheckpoints } from "../server/services/processing-checkpoints";
import { VectorBackfill } from "../server/services/vector-backfill";
import { KnowledgeConfigService } from "../server/services/knowledge-config-service";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import { jsonl, meta, start, user, final } from "./fixtures/codex-dialogue";

const root = process.env.MEMORY_ROOT!;

describe.sequential("KA-003 durable processing", () => {
  beforeEach(() => {
    closeDatabase();
    invalidatePathCache();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockResolvedValue({
      embedding: [],
      model: "stub",
      timestamp: "now",
    });
    vi.spyOn(KnowledgeModelAdapter, "generate").mockResolvedValue({
      content: "{}",
      finishReason: "degraded",
      model: "stub",
      timestamp: "now",
    });
    vi.spyOn(KnowledgeModelAdapter, "dependencyReason").mockReturnValue(undefined);
    vi.spyOn(KnowledgeModelAdapter, "configurationFingerprint").mockReturnValue("config-v1");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
  });

  function stage(id = "memory-one", content = "中文知识：重试最多三次，保留原始事件身份。") {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(
      buildMemoryRecord(
        "test-source",
        "manual",
        "恢复知识",
        content,
        "可靠恢复",
        [],
        "learning",
        id,
      ),
    );
    return memory;
  }

  function accept() {
    const quality = vi
      .spyOn(QualityFilterService.prototype, "filter")
      .mockResolvedValue({ verdict: "accept", kind: "fact", score: 9 });
    const extraction = vi.spyOn(MemoryExtractionService.prototype, "extract").mockResolvedValue([
      {
        title: "可靠恢复",
        summary: "保留稳定身份",
        content: "使用持久化队列，重试沿用原事件身份。",
        tags: ["恢复"],
      },
    ]);
    return { quality, extraction };
  }

  it("publishes accepted content without a vector and keeps Markdown readable", async () => {
    const memory = stage();
    const { quality, extraction } = accept();
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const published = memory.getMemory("memory-one")!;
    expect(published).not.toBeNull();
    expect(readFileSync(getNotePath(published.topic, published.id), "utf8")).toContain(
      "持久化队列",
    );
    expect(quality).toHaveBeenCalledOnce();
    expect(extraction).toHaveBeenCalledOnce();
    expect(memory.getEventsByStatus("review")).toHaveLength(0);
  });

  it("persists service waiting across restart and does not retry before its deadline", async () => {
    const memory = stage();
    const quality = vi
      .spyOn(QualityFilterService.prototype, "filter")
      .mockRejectedValue(new ModelDependencyError("flagship", "quality", "REQUEST_FAILED"));
    await new KnowledgeAgent().processQueue();
    const waiting = memory.getEventsByStatus("waiting_dependency")[0];
    expect(waiting.dependency).toMatchObject({ attempts: 1, paused: false, stage: "quality" });
    expect(memory.getEventsByStatus("review")).toHaveLength(0);
    closeDatabase();
    invalidatePathCache();
    await new KnowledgeAgent().processQueue();
    expect(quality).toHaveBeenCalledOnce();
    expect(new MemoryService().getEvent(waiting.eventId)?.dependency).toEqual(waiting.dependency);
  });

  it("pauses after three automatic retries and retains the original event", async () => {
    const memory = stage();
    vi.spyOn(QualityFilterService.prototype, "filter").mockRejectedValue(
      new ModelDependencyError("flagship", "quality", "REQUEST_FAILED"),
    );
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const id = memory.getEventsByStatus("waiting_dependency")[0].eventId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const event = memory.getEvent(id)!;
      memory.updateEvent({
        ...event,
        dependency: { ...event.dependency!, nextAttemptAt: "2000-01-01T00:00:00.000Z" },
      });
      await agent.processQueue();
    }
    expect(memory.getEvent(id)?.dependency).toMatchObject({ attempts: 4, paused: true });
    expect(memory.getMemory("memory-one")).toBeNull();
    expect(memory.getEventsByStatus("waiting_dependency")).toHaveLength(1);
  });

  it("reuses a successful quality checkpoint after extraction recovers", async () => {
    const memory = stage();
    const { quality, extraction } = accept();
    extraction.mockResolvedValueOnce(null);
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const waiting = memory.getEventsByStatus("waiting_dependency")[0];
    expect(new DependencyRecovery().retry(waiting.eventId)).toBe(true);
    await agent.processQueue();
    expect(quality).toHaveBeenCalledOnce();
    expect(extraction).toHaveBeenCalledTimes(2);
    expect(memory.getEvent(waiting.eventId)?.status).toBe("done");
  });

  it("keeps the published version during a failed update", async () => {
    const memory = stage();
    accept();
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const previous = memory.getMemory("memory-one")!;
    memory.stageUpdateMemory(previous.id, { content: "新的中文内容，必须等待模型质量判断。" });
    vi.spyOn(QualityFilterService.prototype, "filter").mockRejectedValue(
      new ModelDependencyError("flagship", "quality", "NOT_CONFIGURED"),
    );
    await agent.processQueue();
    expect(memory.getMemory(previous.id)?.content).toBe(previous.content);
    expect(memory.getEventsByStatus("waiting_dependency")[0].dependency?.paused).toBe(true);
  });

  it.each(["允许删除", "不允许删除", "a+b", "a-b", "重试3次", "重试4次"])(
    "preserves exact content identity: %s",
    (content) => {
      const memory = stage("one", content);
      stage("two", `${content}!`);
      const event = memory.getPendingEvents().find((event) => event.memoryId === "two")!;
      expect(
        new ProcessingCheckpoints().exactDuplicate(event, JSON.parse(event.candidate)),
      ).toBeUndefined();
    },
  );

  it("records cross-source exact duplicate references without another model request", async () => {
    const memory = stage("one");
    const { quality } = accept();
    await new KnowledgeAgent().processQueue();
    stage("two");
    await new KnowledgeAgent().processQueue();
    expect(quality).toHaveBeenCalledOnce();
    expect(memory.getEventsByStatus("rejected")[0].decisionReasonCode).toBe("EXACT_DUPLICATE");
    expect(getDatabase().prepare("SELECT targetMemoryId FROM content_references").get()).toEqual({
      targetMemoryId: "one",
    });
  });

  it("does not migrate unrelated, completed, or unproven review events", () => {
    const memory = stage();
    const event = memory.getPendingEvents()[0];
    memory.updateEvent({
      ...event,
      status: "review",
      decisionReasonCode: "VECTOR_RECALL_UNAVAILABLE",
    });
    const recovery = new DependencyRecovery();
    const batch = recovery.preview();
    expect(batch.items[0]).toMatchObject({ status: "skipped", reason: "MISSING_SOURCE_EVIDENCE" });
    recovery.execute(batch.id);
    recovery.execute(batch.id);
    expect(memory.getEvent(event.eventId)?.status).toBe("review");
  });

  it("backfills only vectors without republishing or rerunning quality", async () => {
    const memory = stage();
    const { quality, extraction } = accept();
    await new KnowledgeAgent().processQueue();
    const previous = memory.getMemory("memory-one")!;
    const path = getNotePath(previous.topic, previous.id);
    const markdown = readFileSync(path, "utf8");
    const settings = new KnowledgeConfigService();
    const config = settings.getAiConfig()!;
    settings.setAiConfig({
      ...config,
      embedding: { ...config.embedding, enabled: true, model: "stub", dimensions: 3 },
    });
    vi.mocked(KnowledgeModelAdapter.generateEmbedding).mockResolvedValue({
      embedding: [1, 0, 0],
      model: "stub",
      timestamp: "now",
    });
    await new VectorBackfill().run();
    expect(
      getDatabase().prepare("SELECT status FROM vector_jobs WHERE memoryId = ?").get(previous.id),
    ).toEqual({ status: "ready" });
    expect(memory.getMemory(previous.id)?.version).toBe(previous.version);
    expect(readFileSync(path, "utf8")).toBe(markdown);
    expect(quality).toHaveBeenCalledOnce();
    expect(extraction).toHaveBeenCalledOnce();
  });

  it("previews a proven Codex candidate and revalidates concurrent edits", async () => {
    const content = jsonl(meta, start(), user("恢复来源候选"), final("保持稳定事件身份。"));
    const event = createSourceRevisionEvent({
      sourceType: "codex",
      sourcePath: `${root}/session.jsonl`,
      content,
      operation: "add",
    });
    const agent = new KnowledgeAgent();
    await agent.ingestSourceRevision({
      event,
      content,
      toolSource: {
        id: "test-codex",
        name: "Test",
        toolType: "codex",
        path: root,
        filePattern: "*.jsonl",
        enabled: true,
        createdAt: "now",
        updatedAt: "now",
      },
    });
    const memory = new MemoryService();
    const pending = memory.getPendingEvents()[0];
    memory.updateEvent({
      ...pending,
      status: "review",
      decisionReasonCode: "VECTOR_RECALL_UNAVAILABLE",
    });
    const recovery = new DependencyRecovery();
    const first = recovery.preview();
    expect(new DependencyRecovery().latestBatch()?.id).toBe(first.id);
    expect(first.items[0].reason).toBe("ELIGIBLE");
    recovery.execute(first.id);
    recovery.execute(first.id);
    expect(memory.getEvent(pending.eventId)?.status).toBe("pending");
    memory.updateEvent({ ...memory.getEvent(pending.eventId)!, status: "review" });
    const second = recovery.preview();
    agent.updateReviewCandidate(pending.eventId, {
      ...JSON.parse(pending.candidate),
      title: "人工改动",
    });
    expect(recovery.execute(second.id).items[0].reason).toBe("CHANGED_SINCE_PREVIEW");
    expect(recovery.preview().items[0].reason).toBe("EDITED_OR_UNPROVEN");
    expect(memory.getEvent(pending.eventId)?.status).toBe("review");
  });

  it("recovers a 325 item backlog in one bounded batch despite overlapping consumers", async () => {
    const memory = new MemoryService();
    for (let i = 0; i < 325; i++) stage(`batch-${i}`, `唯一来源编号 ${i}`);
    for (const event of memory.getPendingEvents())
      memory.updateEvent({
        ...event,
        status: "waiting_dependency",
        dependency: {
          slot: "flagship",
          stage: "quality",
          reason: "REQUEST_FAILED",
          attempts: 1,
          lastAttemptAt: "2000-01-01",
          nextAttemptAt: "2000-01-02",
          paused: false,
          configFingerprint: "config-v1",
        },
      });
    const quality = vi
      .spyOn(QualityFilterService.prototype, "filter")
      .mockResolvedValue({ verdict: "review", reason: "内容存疑" });
    await Promise.all([new KnowledgeAgent().processQueue(), new KnowledgeAgent().processQueue()]);
    expect(quality).toHaveBeenCalledTimes(20);
    expect(memory.getEventsByStatus("waiting_dependency")).toHaveLength(305);
    expect(memory.getEventsByStatus("review")).toHaveLength(20);
  });

  it.each(["delete", "update", "disable", "model"])(
    "discards an obsolete backfill after %s",
    async (action) => {
      const memory = stage();
      accept();
      await new KnowledgeAgent().processQueue();
      const settings = new KnowledgeConfigService();
      const original = settings.getAiConfig()!;
      const config = {
        ...original,
        embedding: { ...original.embedding, enabled: true, model: "stub", dimensions: 3 },
      };
      settings.setAiConfig(config);
      vi.mocked(KnowledgeModelAdapter.generateEmbedding).mockImplementationOnce(async () => {
        if (action === "delete") memory.deleteMemory("memory-one");
        if (action === "update") memory.updateMemory("memory-one", { content: "更新后的知识" });
        if (action === "disable")
          settings.setAiConfig({ ...config, embedding: { ...config.embedding, enabled: false } });
        if (action === "model")
          settings.setAiConfig({
            ...config,
            embedding: { ...config.embedding, model: "new-model" },
          });
        return { embedding: [1, 0, 0], model: "stub", timestamp: "now" };
      });
      await new VectorBackfill().run();
      expect(
        getDatabase().prepare("SELECT 1 FROM vector_records WHERE memoryId = 'memory-one'").get(),
      ).toBeUndefined();
    },
  );
});
