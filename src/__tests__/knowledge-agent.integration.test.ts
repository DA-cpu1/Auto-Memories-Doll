import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDatabase } from "../lib/storage/database";
import { invalidatePathCache } from "../lib/storage/path-resolver";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import { ModelAdapter } from "../lib/ai/model-adapter";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { MemoryService } from "../server/services/memory-service";

const memoryRoot = process.env.MEMORY_ROOT!;

function resetStorage(): void {
  closeDatabase();
  invalidatePathCache();
  rmSync(memoryRoot, { recursive: true, force: true });
  mkdirSync(memoryRoot, { recursive: true });
}

describe.sequential("KnowledgeAgent source orchestration", () => {
  beforeEach(resetStorage);
  afterEach(() => vi.restoreAllMocks());

  it("stages one source revision and exposes persisted phase progress", async () => {
    const sourcePath = join(memoryRoot, "imports", "phase-two.md");
    const content = "# Phase 2\n\n统一来源事件进入知识整理 Agent。";
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, content, "utf-8");

    const event = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content,
      operation: "add",
      observedAt: "2026-09-04T02:00:00.000Z",
    });
    const agent = new KnowledgeAgent();

    const [first, concurrent] = await Promise.all([
      agent.ingestSourceRevision({ event }),
      agent.ingestSourceRevision({ event }),
    ]);
    const repeated = await agent.ingestSourceRevision({ event });

    expect(first).toMatchObject({ status: "staged", sourceEvent: event });
    expect(concurrent).toEqual(first);
    expect(first.memoryIds).toHaveLength(1);
    expect(repeated).toMatchObject({ status: "unchanged", memoryIds: first.memoryIds });

    const queue = new MemoryService();
    expect(queue.getPendingEvents()).toEqual([
      expect.objectContaining({
        memoryId: first.memoryIds[0],
        sourceId: event.sourceId,
        sourceRevision: event.revision,
        sourceEventId: event.eventId,
        status: "pending",
      }),
    ]);
    queue.close();

    expect(agent.getSource(event.sourceId)).toMatchObject({
      latestRevision: event.revision,
      health: "healthy",
    });
    expect(agent.listProgress({ eventId: event.eventId }).map((item) => item.stage)).toEqual([
      "discovered",
      "parsing",
      "normalizing",
      "staged",
    ]);
    agent.close();
  });

  it("recovers interrupted processing without changing source identity", async () => {
    const sourcePath = join(memoryRoot, "imports", "interrupted.md");
    const content = "# Interrupted\n\n处理中断后必须保留来源版本并安全重试。";
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, content, "utf-8");
    const event = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content,
      operation: "add",
      observedAt: "2026-09-04T03:00:00.000Z",
    });

    const beforeRestart = new KnowledgeAgent();
    const staged = await beforeRestart.ingestSourceRevision({ event, sourceLocator: sourcePath });
    const queueBeforeRestart = new MemoryService();
    const claimed = queueBeforeRestart.dequeueEvent(staged.memoryIds[0]);
    expect(claimed).toMatchObject({
      status: "processing",
      sourceEventId: event.eventId,
      sourceId: event.sourceId,
      sourceRevision: event.revision,
    });
    queueBeforeRestart.close();
    beforeRestart.close();
    closeDatabase();

    const afterRestart = new KnowledgeAgent();
    expect(afterRestart.recoverInterruptedEvents()).toBe(1);

    const recoveredQueue = new MemoryService();
    expect(recoveredQueue.getEvent(claimed!.eventId)).toMatchObject({
      eventId: claimed!.eventId,
      status: "pending",
      sourceEventId: event.eventId,
      sourceId: event.sourceId,
      sourceRevision: event.revision,
    });
    recoveredQueue.close();
    expect(afterRestart.listProgress({ eventId: event.eventId }).map((item) => item.stage)).toEqual(
      [
        "discovered",
        "parsing",
        "normalizing",
        "staged",
        "processing",
        "failed_retryable",
        "staged",
      ],
    );
    afterRestart.close();
  });

  it("owns queue processing and emits a waiting review state when the model is degraded", async () => {
    vi.spyOn(ModelAdapter, "isDegradedMode", "get").mockReturnValue(true);
    const sourcePath = join(memoryRoot, "imports", "needs-review.md");
    const content = "# Needs review\n\n模型不可用时，这条候选不能默认发布。";
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, content, "utf-8");
    const event = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content,
      operation: "add",
    });
    const agent = new KnowledgeAgent();
    const staged = await agent.ingestSourceRevision({ event, sourceLocator: sourcePath });

    await agent.processQueue();

    const queue = new MemoryService();
    const [review] = queue.getEventsByStatus("review");
    expect(review).toMatchObject({
      memoryId: staged.memoryIds[0],
      sourceEventId: event.eventId,
      sourceRevision: event.revision,
    });
    expect(queue.getMemory(staged.memoryIds[0])).toBeNull();
    queue.close();
    expect(agent.listProgress({ eventId: event.eventId }).slice(-2)).toEqual([
      expect.objectContaining({ stage: "processing", outcome: "completed" }),
      expect.objectContaining({ stage: "review", outcome: "waiting" }),
    ]);
    agent.close();
  });

  it("routes tool sessions and listen payloads through the same source contract", async () => {
    const toolPath = join(memoryRoot, "sessions", "trae.jsonl");
    const toolContent = JSON.stringify({
      intent: "统一来源契约",
      actions: ["解析本地会话"],
      outcome: "进入待审计队列",
      learned: ["来源版本可追踪"],
    });
    mkdirSync(dirname(toolPath), { recursive: true });
    writeFileSync(toolPath, toolContent, "utf-8");
    const toolEvent = createSourceRevisionEvent({
      sourceType: "trae",
      sourcePath: toolPath,
      content: toolContent,
      operation: "add",
    });
    const agent = new KnowledgeAgent();
    const toolResult = await agent.ingestSourceRevision({
      event: toolEvent,
      sourceLocator: toolPath,
      toolSource: {
        id: "trae-source",
        name: "Trae sessions",
        toolType: "trae",
        path: dirname(toolPath),
        filePattern: "*.jsonl",
        enabled: true,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    });

    const listenConversation = {
      source: "browser",
      sourceType: "listen" as const,
      title: "Phase 2 listen",
      messages: [{ role: "user" as const, content: "把监听输入也交给 KnowledgeAgent。" }],
    };
    const listenRaw = JSON.stringify(listenConversation);
    const listenEvent = createSourceRevisionEvent({
      sourceType: "listen",
      sourceKey: "browser:phase-2-listen",
      content: listenRaw,
      operation: "add",
    });
    const listenResult = await agent.ingestSourceRevision({
      event: listenEvent,
      conversation: listenConversation,
    });
    const repeatedListen = await agent.ingestSourceRevision({
      event: listenEvent,
      conversation: listenConversation,
    });

    expect(toolResult.memoryIds[0]).toMatch(/^tool-/);
    expect(listenResult.memoryIds[0]).toMatch(/^listen-/);
    expect(listenResult.knowledgeCard?.content).toContain("KnowledgeAgent");
    expect(repeatedListen).toMatchObject({
      status: "unchanged",
      memoryIds: listenResult.memoryIds,
      topic: listenResult.topic,
      knowledgeCard: { content: listenResult.knowledgeCard?.content },
    });
    const queue = new MemoryService();
    expect(queue.getPendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceEventId: toolEvent.eventId }),
        expect.objectContaining({ sourceEventId: listenEvent.eventId }),
      ]),
    );
    queue.close();
    agent.close();
  });

  it("stages a source-linked delete event without rereading the removed file", async () => {
    const sourcePath = join(memoryRoot, "imports", "deleted-source.md");
    const content = "# Delete\n\n来源删除应进入同一个持久化队列。";
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, content, "utf-8");
    const added = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content,
      operation: "add",
    });
    const agent = new KnowledgeAgent();
    const staged = await agent.ingestSourceRevision({ event: added, sourceLocator: sourcePath });

    const storage = new MemoryService();
    const createEvent = storage.getPendingEvents()[0];
    await storage.createMemoryRecord(JSON.parse(createEvent.candidate));
    const claimed = storage.dequeueEvent(staged.memoryIds[0])!;
    claimed.status = "done";
    storage.updateEvent(claimed);

    const deleted = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content: `deleted:${sourcePath}`,
      operation: "delete",
    });
    const result = await agent.ingestSourceRevision({
      event: deleted,
      sourceLocator: sourcePath,
    });

    expect(result).toMatchObject({ status: "staged", memoryIds: staged.memoryIds });
    expect(storage.getPendingEvents()).toEqual([
      expect.objectContaining({
        memoryId: staged.memoryIds[0],
        eventType: "delete",
        sourceEventId: deleted.eventId,
        sourceRevision: deleted.revision,
      }),
    ]);
    storage.close();
    agent.close();
  });
});
