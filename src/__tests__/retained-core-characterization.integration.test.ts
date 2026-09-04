import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDatabase } from "../lib/storage/database";
import { getNotePath, invalidatePathCache } from "../lib/storage/path-resolver";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import type { LlmResponse } from "../lib/ai/knowledge-model";
import { ingestMarkdownFile, scanMemoryRoot } from "../server/watchers/file-watcher";
import { MemoryService } from "../server/services/memory-service";
import { Orchestrator } from "../server/services/orchestrator";
import { AuditService } from "../server/services/audit-service";
import { parseMemoryFromText } from "../lib/storage/markdown-parser";
import { buildMemoryRecord, buildPendingEvent } from "../lib/memory/builder";

const memoryRoot = process.env.MEMORY_ROOT!;
const sourcePath = join(memoryRoot, "imports", "retained-source.md");
let qualityScore = 9;

function llmResponse(content: string, model = "characterization-model"): LlmResponse {
  return {
    content,
    finishReason: "stop",
    model,
    timestamp: "2026-09-03T00:00:00.000Z",
  };
}

function resetStorage(): void {
  closeDatabase();
  invalidatePathCache();
  rmSync(memoryRoot, { recursive: true, force: true });
  mkdirSync(memoryRoot, { recursive: true });
}

function installAcceptingModelBoundary(): void {
  vi.spyOn(KnowledgeModelAdapter, "isDegradedMode", "get").mockReturnValue(false);
  vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockResolvedValue({
    embedding: [1, 0, 0],
    model: "characterization-embedding",
    timestamp: "2026-09-03T00:00:00.000Z",
  });
  vi.spyOn(KnowledgeModelAdapter, "generate").mockImplementation(async (prompt) => {
    if (prompt.includes("知识库话题分类器")) {
      return llmResponse('{"topic":"learning","confidence":0.95,"reason":"技术学习资料"}');
    }
    if (prompt.includes("记忆入库质量闸门")) {
      return llmResponse(
        JSON.stringify({
          score: qualityScore,
          kind: "fact",
          reason: qualityScore >= 8 ? "包含可复用的具体经验" : "信息仍需人工确认",
        }),
      );
    }
    if (prompt.includes("记忆库的编辑")) {
      return llmResponse(
        '{"memories":[{"title":"TypeScript 构建缓存","summary":"通过增量缓存缩短重复构建时间。","content":"开启 TypeScript 增量构建并保存缓存，可以减少未变更模块的重复编译。","tags":["TypeScript","构建优化"]}]}',
      );
    }
    throw new Error(`未覆盖的模型提示: ${prompt.slice(0, 40)}`);
  });
}

beforeEach(() => {
  resetStorage();
  qualityScore = 9;
  installAcceptingModelBoundary();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
});

describe.sequential("retained local knowledge pipeline characterization", () => {
  it("publishes one source-linked knowledge unit and makes an unchanged rescan a no-op", async () => {
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      "# TypeScript 构建缓存\n\n开启 incremental 后，重复构建只编译发生变化的模块。",
      "utf-8",
    );

    await ingestMarkdownFile(sourcePath, "add");

    const stagedReader = new MemoryService();
    const stagedEvents = stagedReader.getPendingEvents();
    expect(stagedEvents).toHaveLength(1);
    const { eventId, memoryId } = stagedEvents[0];
    stagedReader.close();

    const orchestrator = new Orchestrator();
    await orchestrator.processQueue();
    orchestrator.close();

    const publishedReader = new MemoryService();
    const published = publishedReader.getMemory(memoryId);
    const completedEvent = publishedReader.getEvent(eventId);
    expect(completedEvent?.status).toBe("done");
    expect(published).toMatchObject({
      id: memoryId,
      title: "TypeScript 构建缓存",
      topic: "learning",
      vectorId: memoryId,
    });
    expect(published?.evidence?.location).toBe(sourcePath);
    publishedReader.close();

    const notePath = getNotePath("learning", memoryId);
    expect(existsSync(notePath)).toBe(true);
    const markdownRecord = parseMemoryFromText(readFileSync(notePath, "utf-8"));
    expect(markdownRecord).toMatchObject({ id: memoryId, title: "TypeScript 构建缓存" });

    expect(await scanMemoryRoot()).toBe(1);

    const rescanReader = new MemoryService();
    expect(rescanReader.getPendingEvents()).toHaveLength(0);
    expect(rescanReader.count()).toBe(1);
    rescanReader.close();

    writeFileSync(
      sourcePath,
      "# TypeScript 构建缓存\n\n开启 incremental，并将 tsbuildinfo 保存在稳定路径中。",
      "utf-8",
    );
    await ingestMarkdownFile(sourcePath, "change");

    const updateReader = new MemoryService();
    expect(updateReader.getPendingEvents()).toEqual([
      expect.objectContaining({ memoryId, eventType: "update", status: "pending" }),
    ]);
    expect(updateReader.count()).toBe(1);
    updateReader.close();
  });

  it("coalesces concurrent add and change observations into one real queue event", async () => {
    const rapidPath = join(memoryRoot, "imports", "rapid-source.md");
    mkdirSync(dirname(rapidPath), { recursive: true });
    writeFileSync(
      rapidPath,
      "# 快速写入\n\n同一个文件事件必须串行合并，避免生成重复候选。",
      "utf-8",
    );

    await Promise.all([
      ingestMarkdownFile(rapidPath, "add"),
      ingestMarkdownFile(rapidPath, "change"),
    ]);

    const reader = new MemoryService();
    const events = reader.getPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "create", status: "pending" });
    expect(events[0].memoryId).toMatch(/^file-[a-f0-9]{32}$/);
    reader.close();
  });

  it("keeps an uncertain candidate in review without publishing it", async () => {
    qualityScore = 6;
    const candidate = buildMemoryRecord(
      "local-review-source.md",
      "ingest",
      "需要确认的缓存结论",
      "这段材料提出缓存可能改善构建速度，但没有给出可复现数据。",
      "效果缺少验证。",
      ["构建"],
      "learning",
      "review-candidate",
      undefined,
      { evidence: { text: "缓存可能改善构建速度", location: "local-review-source.md" } },
    );

    const staging = new MemoryService();
    staging.stageCreateMemoryRecord(candidate);
    const [event] = staging.getPendingEvents();
    staging.close();

    const orchestrator = new Orchestrator();
    await orchestrator.processQueue();
    orchestrator.close();

    const reader = new MemoryService();
    expect(reader.getEvent(event.eventId)?.status).toBe("review");
    expect(reader.getMemory(candidate.id)).toBeNull();
    reader.close();
    expect(existsSync(getNotePath("learning", candidate.id))).toBe(false);
  });

  it("terminally rejects a low-quality candidate without publishing it", async () => {
    qualityScore = 2;
    const candidate = buildMemoryRecord(
      "local-noise-source.md",
      "ingest",
      "临时寒暄",
      "你好，谢谢，再见。",
      "没有可复用信息。",
      ["噪声"],
      "uncategorized",
      "rejected-candidate",
      undefined,
      { evidence: { text: "你好，谢谢，再见。", location: "local-noise-source.md" } },
    );

    const staging = new MemoryService();
    staging.stageCreateMemoryRecord(candidate);
    const [event] = staging.getPendingEvents();
    staging.close();

    const orchestrator = new Orchestrator();
    await orchestrator.processQueue();
    orchestrator.close();

    const reader = new MemoryService();
    expect(reader.getEvent(event.eventId)).toMatchObject({ status: "rejected", retryCount: 0 });
    expect(reader.getMemory(candidate.id)).toBeNull();
    expect(reader.getPendingEvents()).toHaveLength(0);
    reader.close();
  });

  it("recovers an interrupted processing event after reopening storage", () => {
    const candidate = buildMemoryRecord(
      "restart-source.md",
      "ingest",
      "进程恢复",
      "处理中断后应当重新进入待处理队列。",
      "验证持久化恢复。",
      ["可靠性"],
      "learning",
      "restart-candidate",
      undefined,
      { evidence: { text: "处理中断后应当重新进入待处理队列。" } },
    );

    const beforeRestart = new MemoryService();
    beforeRestart.stageCreateMemoryRecord(candidate);
    const claimed = beforeRestart.dequeueEvent(candidate.id);
    expect(claimed?.status).toBe("processing");
    beforeRestart.close();
    closeDatabase();

    const afterRestart = new Orchestrator();
    expect(afterRestart.recoverStuckEvents()).toBe(1);
    afterRestart.close();

    const reader = new MemoryService();
    expect(reader.getEvent(claimed!.eventId)).toMatchObject({
      eventId: claimed!.eventId,
      memoryId: candidate.id,
      status: "pending",
      retryCount: 0,
    });
    reader.close();
  });

  it("marks a malformed queued candidate as retryable failure", async () => {
    const candidate = buildMemoryRecord(
      "broken-source.md",
      "ingest",
      "损坏候选",
      "原始候选内容。",
      "用于验证失败状态。",
      [],
      "learning",
      "broken-candidate",
    );
    const event = buildPendingEvent(
      candidate.id,
      candidate.sourceType,
      candidate,
      ["content"],
      "create",
    );
    event.candidate = "{not-json";

    const staging = new MemoryService();
    staging.enqueueEvent(event);
    staging.close();

    const orchestrator = new Orchestrator();
    await orchestrator.processQueue();
    orchestrator.close();

    const reader = new MemoryService();
    expect(reader.getEvent(event.eventId)).toMatchObject({ status: "failed", retryCount: 1 });
    expect(reader.getMemory(candidate.id)).toBeNull();
    reader.close();
  });

  it("records a scalar update conflict without overwriting the accepted value", async () => {
    const existing = buildMemoryRecord(
      "accepted-source.md",
      "manual",
      "原始标题",
      "已经接受的知识正文。",
      "已经接受的摘要。",
      ["稳定知识"],
      "learning",
      "conflict-candidate",
    );

    const staging = new MemoryService();
    await staging.createMemoryRecord(existing);
    const eventId = staging.stageUpdateMemory(existing.id, { title: "候选新标题" });
    staging.close();

    const orchestrator = new Orchestrator();
    await orchestrator.processQueue();
    orchestrator.close();

    const reader = new MemoryService();
    expect(reader.getEvent(eventId)?.status).toBe("done");
    expect(reader.getMemory(existing.id)?.title).toBe("原始标题");
    reader.close();

    const audit = new AuditService();
    expect(audit.listConflicts("pending")).toEqual([
      expect.objectContaining({
        memoryId: existing.id,
        eventId,
        field: "title",
        existingValue: JSON.stringify("原始标题"),
        candidateValue: JSON.stringify("候选新标题"),
      }),
    ]);
    audit.close();
  });
});
