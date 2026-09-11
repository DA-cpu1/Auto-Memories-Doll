import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../lib/storage/database";
import { getArchivePath, getNotePath, invalidatePathCache } from "../lib/storage/path-resolver";
import { MemoryService } from "../server/services/memory-service";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { MemoryExtractionService } from "../server/services/memory-extraction-service";
import { TopicClassificationService } from "../server/services/topic-classification-service";
import { buildMemoryRecord, buildPendingEvent } from "../lib/memory/builder";
import { resolveConflicts } from "../features/audit/conflict-resolver";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import * as writer from "../lib/storage/memory-writer";

const root = process.env.MEMORY_ROOT!;
const record = (id: string, content = "git status") =>
  buildMemoryRecord("auto-test", "manual", id, content, content, [], "learning", id);

describe.sequential("automatic publishing without selection", () => {
  beforeEach(() => {
    closeDatabase();
    invalidatePathCache();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockResolvedValue({
      embedding: [],
      model: "test",
      timestamp: "now",
    });
    vi.spyOn(TopicClassificationService.prototype, "classify").mockResolvedValue({
      topic: "learning",
      confidence: 1,
      source: "model",
    });
    vi.spyOn(MemoryExtractionService.prototype, "extract").mockImplementation(async (c) => [
      { title: c.title, summary: c.summary, content: c.content, tags: c.tags },
    ]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
  });

  it.each(["fact", "inference", "hypothesis", "insight"] as const)(
    "publishes short %s without evidence, retaining source text",
    async (kind) => {
      const memory = new MemoryService();
      memory.stageCreateMemoryRecord({ ...record(kind, "好"), kind });
      await new KnowledgeAgent().processQueue();
      const published = memory.getMemory(kind)!;
      expect(published.kind).toBe(kind);
      expect(readFileSync(getNotePath(published.topic, kind), "utf8")).toContain("好");
      expect(memory.getEventsByStatus("done")).toHaveLength(1);
      expect(memory.getEventsByStatus("review")).toHaveLength(0);
    },
  );

  it("imports a one-character file and makes unchanged rescans a no-op", async () => {
    const agent = new KnowledgeAgent();
    const event = createSourceRevisionEvent({
      sourceType: "text",
      sourcePath: join(root, "short.txt"),
      content: "好",
      operation: "add",
    });
    const staged = await agent.ingestSourceRevision({ event, content: "好" });
    expect(staged.memoryIds).toHaveLength(1);
    await agent.processQueue();
    expect(new MemoryService().getMemory(staged.memoryIds[0])).not.toBeNull();
    expect((await agent.ingestSourceRevision({ event, content: "好" })).status).toBe("unchanged");
  });

  it("keeps identical content from distinct sources", async () => {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(record("one"));
    memory.stageCreateMemoryRecord(record("two"));
    await new KnowledgeAgent().processQueue();
    expect(memory.count()).toBe(2);
    expect(memory.getEventsByStatus("done")).toHaveLength(2);
  });

  it("retains simple original details even when the model only returns an abstract", async () => {
    const memory = new MemoryService();
    vi.mocked(MemoryExtractionService.prototype.extract).mockResolvedValue([
      { title: "工具说明", summary: "日常工具", content: "一些工具命令。", tags: [] },
    ]);
    memory.stageCreateMemoryRecord(
      record("details", "查看工作区状态用 git status。临时端口是 7319。"),
    );
    await new KnowledgeAgent().processQueue();
    expect(memory.getMemory("details")?.content).toContain("7319");
    expect(memory.getMemory("details")?.content).toContain("git status");
  });

  it("resumes old quality dependency waits but keeps unrelated terminal history", async () => {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(record("quality-wait"));
    memory.stageCreateMemoryRecord(record("old-rejected"));
    getDatabase()
      .prepare(
        "UPDATE pending_events SET status='waiting_dependency', dependency=? WHERE memoryId='quality-wait'",
      )
      .run(JSON.stringify({ stage: "quality", slot: "flagship", paused: true }));
    getDatabase()
      .prepare("UPDATE pending_events SET status='rejected' WHERE memoryId='old-rejected'")
      .run();
    await new KnowledgeAgent().processQueue();
    expect(memory.getMemory("quality-wait")).not.toBeNull();
    expect(memory.getEventsByStatus("waiting_dependency")).toHaveLength(0);
    expect(memory.getEventsByStatus("rejected")).toHaveLength(1);
    expect(memory.migrateReviewEventsToPending()).toBe(0);
  });

  it("migrates old review and conflict events once and archives the overwritten version", async () => {
    const memory = new MemoryService();
    const existing = { ...record("conflict", "旧内容"), updatedAt: "2020-01-01T00:00:00Z" };
    await memory.createMemoryRecord(existing);
    const candidate = {
      ...existing,
      title: "自动更新",
      content: "新内容",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const event = buildPendingEvent(
      existing.id,
      "manual",
      candidate,
      ["title", "content"],
      "update",
    );
    memory.enqueueEvent(event);
    getDatabase()
      .prepare("UPDATE pending_events SET status = 'done' WHERE eventId = ?")
      .run(event.eventId);
    getDatabase()
      .prepare(
        "INSERT INTO conflict_records (conflictId,memoryId,eventId,field,status) VALUES ('legacy',?,?, 'content','pending')",
      )
      .run(existing.id, event.eventId);
    memory.stageCreateMemoryRecord(record("review"));
    getDatabase()
      .prepare("UPDATE pending_events SET status='review' WHERE memoryId='review'")
      .run();
    await new KnowledgeAgent().processQueue();
    expect(memory.getMemory(existing.id)?.content).toBe("新内容");
    expect(memory.getMemory("review")).not.toBeNull();
    expect(
      getDatabase().prepare("SELECT status FROM conflict_records WHERE conflictId='legacy'").get(),
    ).toEqual({ status: "resolved_accept" });
    const files = readdirSync(join(getArchivePath(), "versions"));
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(getArchivePath(), "versions", files[0]), "utf8")).toContain("旧内容");
    expect(memory.migrateReviewEventsToPending()).toBe(0);
    const version = memory.getMemory(existing.id)?.version;
    await new KnowledgeAgent().processQueue();
    expect(memory.getMemory(existing.id)?.version).toBe(version);
  });

  it("chooses updatedAt rather than stale schema version and changes only declared fields", () => {
    const existing = { ...record("one"), version: 10, updatedAt: "2025-01-01" };
    const newer = {
      ...existing,
      version: 1,
      title: "新标题",
      content: "未声明的变化",
      updatedAt: "2026-01-01",
    };
    expect(resolveConflicts(existing, newer, ["title"])).toEqual({
      action: "auto_merge",
      merged: { title: "新标题", updatedAt: "2026-01-01" },
    });
    expect(resolveConflicts(newer, existing, ["title"])).toEqual({
      action: "auto_merge",
      merged: {},
    });
  });

  it("does not call a failed Markdown write done and repairs it on retry", async () => {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(record("disk"));
    const failure = vi
      .spyOn(writer, "writeMemoryMarkdown")
      .mockRejectedValueOnce(new Error("disk full"));
    const agent = new KnowledgeAgent();
    await agent.processQueue();
    expect(memory.getEventsByStatus("failed")).toHaveLength(1);
    expect(memory.getEventsByStatus("done")).toHaveLength(0);
    failure.mockRestore();
    agent.retryFailedEvents();
    await agent.processQueue();
    const published = memory.getMemory("disk")!;
    expect(readFileSync(getNotePath(published.topic, published.id), "utf8")).toContain(
      "git status",
    );
    expect(memory.getEventsByStatus("done")).toHaveLength(1);
  });

  it("does not delete newer split cards when an older candidate is replayed", async () => {
    const memory = new MemoryService();
    const newer = {
      ...record("split", "新原文"),
      updatedAt: "2026-01-01",
      evidence: { text: "新原文", sourceHash: "newer" },
    };
    await memory.createMemoryRecord(newer);
    await memory.createMemoryRecord({ ...newer, id: "split-p2", content: "较新分卡" });
    const old = { ...record("split", "旧原文"), updatedAt: "2020-01-01" };
    memory.enqueueEvent(buildPendingEvent("split", "manual", old, ["content"], "update"));
    await new KnowledgeAgent().processQueue();
    expect(memory.getMemory("split")?.content).toBe("新原文");
    expect(memory.getMemory("split-p2")?.content).toBe("较新分卡");
    expect(MemoryExtractionService.prototype.extract).not.toHaveBeenCalled();
    expect(memory.getEventsByStatus("done")).toHaveLength(1);
  });

  it("does not publish malformed or empty candidates", async () => {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(record("bad"));
    getDatabase().prepare("UPDATE pending_events SET candidate='{' WHERE memoryId='bad'").run();
    memory.stageCreateMemoryRecord(record("empty", " "));
    await new KnowledgeAgent().processQueue();
    expect(memory.count()).toBe(0);
    expect(memory.getEventsByStatus("failed")).toHaveLength(2);
  });

  it("gives valid legacy failures one recovery attempt without looping on a real storage error", async () => {
    const memory = new MemoryService();
    memory.stageCreateMemoryRecord(record("legacy-failed"));
    getDatabase()
      .prepare(
        "UPDATE pending_events SET status='failed',retryCount=3 WHERE memoryId='legacy-failed'",
      )
      .run();
    vi.spyOn(writer, "writeMemoryMarkdown").mockRejectedValue(new Error("disk full"));
    await new KnowledgeAgent().processQueue();
    const failed = memory.getEventsByStatus("failed")[0];
    expect(failed.decisionReasonCode).toBe("PROCESSING_FAILED");
    expect(failed.retryCount).toBe(1);
    expect(memory.migrateReviewEventsToPending()).toBe(0);
    expect(memory.getEventsByStatus("done")).toHaveLength(0);
  });
});
