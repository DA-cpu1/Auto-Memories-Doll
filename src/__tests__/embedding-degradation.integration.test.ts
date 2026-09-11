import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { closeDatabase, getDatabase } from "../lib/storage/database";
import { invalidatePathCache, getNotePath } from "../lib/storage/path-resolver";
import { MemoryService } from "../server/services/memory-service";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { ModelDependencyError } from "../lib/ai/dependency-error";
import { MemoryExtractionService } from "../server/services/memory-extraction-service";
import { buildMemoryRecord } from "../lib/memory/builder";
import { ProcessingCheckpoints } from "../server/services/processing-checkpoints";
import { VectorBackfill } from "../server/services/vector-backfill";
import { KnowledgeConfigService } from "../server/services/knowledge-config-service";

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
    const extraction = vi.spyOn(MemoryExtractionService.prototype, "extract").mockResolvedValue([
      {
        title: "可靠恢复",
        summary: "保留稳定身份",
        content: "使用持久化队列，重试沿用原事件身份。",
        tags: ["恢复"],
      },
    ]);
    return { extraction };
  }

  it("publishes accepted content without a vector and keeps Markdown readable", async () => {
    const memory = stage();
    const { extraction } = accept();
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const published = memory.getMemory("memory-one")!;
    expect(published).not.toBeNull();
    expect(readFileSync(getNotePath(published.topic, published.id), "utf8")).toContain(
      "持久化队列",
    );
    expect(extraction).toHaveBeenCalledOnce();
    expect(memory.getEventsByStatus("review")).toHaveLength(0);
  });

  it("publishes full source on extraction failure and stays done after restart", async () => {
    const memory = stage();
    const extraction = vi
      .spyOn(MemoryExtractionService.prototype, "extract")
      .mockRejectedValue(new ModelDependencyError("flagship", "extraction", "TIMEOUT"));
    await new KnowledgeAgent().processQueue();
    const event = memory.getEventsByStatus("done")[0];
    expect(memory.getMemory("memory-one")?.content).toContain("重试最多三次");
    expect(event.decisionReasonCode).toBe("PUBLISHED_SOURCE_FALLBACK");
    expect(memory.getEventsByStatus("waiting_dependency")).toHaveLength(0);
    closeDatabase();
    invalidatePathCache();
    await new KnowledgeAgent().processQueue();
    expect(extraction).toHaveBeenCalledOnce();
    expect(new MemoryService().getEvent(event.eventId)?.status).toBe("done");
  });

  it("publishes paused extraction backlog without another model request", async () => {
    const memory = stage();
    const pending = memory.getPendingEvents()[0];
    memory.updateEvent({
      ...pending,
      status: "waiting_dependency",
      dependency: {
        slot: "flagship",
        stage: "extraction",
        reason: "REQUEST_FAILED",
        attempts: 4,
        lastAttemptAt: "2000-01-01",
        paused: true,
        configFingerprint: "config-v1",
      },
    });
    const extraction = vi.spyOn(MemoryExtractionService.prototype, "extract");
    await new KnowledgeAgent().processQueue();
    expect(memory.getEvent(pending.eventId)?.status).toBe("done");
    expect(memory.getMemory("memory-one")?.content).toContain("重试最多三次");
    expect(extraction).not.toHaveBeenCalled();
    expect(memory.migrateReviewEventsToPending()).toBe(0);
  });

  it("publishes updated source even when model extraction is unavailable", async () => {
    const memory = stage();
    accept();
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    const previous = memory.getMemory("memory-one")!;
    memory.stageUpdateMemory(previous.id, { content: "新增简单命令：git status。" });
    vi.mocked(MemoryExtractionService.prototype.extract).mockResolvedValue(null);
    await agent.processQueue();
    expect(memory.getMemory(previous.id)?.content).toBe("新增简单命令：git status。");
    expect(memory.getEventsByStatus("waiting_dependency")).toHaveLength(0);
    expect(
      getDatabase()
        .prepare("SELECT count(*) AS n FROM memory_snapshots WHERE memoryId=?")
        .get(previous.id),
    ).toEqual({ n: 1 });
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

  it("backfills only vectors without republishing or rerunning quality", async () => {
    const memory = stage();
    const { extraction } = accept();
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
    expect(extraction).toHaveBeenCalledOnce();
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
