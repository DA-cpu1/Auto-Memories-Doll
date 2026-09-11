import { MemoryExtractionService } from "../server/services/memory-extraction-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../lib/storage/database";
import { getNotePath, invalidatePathCache } from "../lib/storage/path-resolver";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { MemoryService } from "../server/services/memory-service";
import { SourceRegistry } from "../server/services/source-registry";
import { listenStatusAgentSchema } from "../config/api-route-contracts";
import type { ToolWatchSource } from "../types/config";
import {
  complete,
  event,
  final,
  jsonl,
  meta,
  noise,
  sentinel,
  start,
  user,
} from "./fixtures/codex-dialogue";

const root = process.env.MEMORY_ROOT!;
const path = join(root, "session.jsonl");
const source: ToolWatchSource = {
  id: "codex-test",
  name: "My custom Codex",
  toolType: "codex",
  path: root,
  filePattern: "*.jsonl",
  enabled: true,
  createdAt: "2026-09-05",
  updatedAt: "2026-09-05",
};
const input = (content: string) => ({
  event: createSourceRevisionEvent({
    sourceType: "codex",
    sourcePath: path,
    content,
    operation: "rescan",
  }),
  sourceLocator: path,
  toolSource: source,
  content,
});

describe.sequential("Codex storage and model boundary", () => {
  beforeEach(() => {
    closeDatabase();
    invalidatePathCache();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
  });

  it("publishes only allowed content; noise and restart produce no model calls or writes", async () => {
    const generate = vi.spyOn(KnowledgeModelAdapter, "generate").mockResolvedValue({
      content: "{}",
      finishReason: "degraded",
      model: "stub",
      timestamp: new Date().toISOString(),
    });
    const embed = vi
      .spyOn(KnowledgeModelAdapter, "generateEmbedding")
      .mockResolvedValue({ embedding: [], model: "stub", timestamp: new Date().toISOString() });
    const raw = jsonl(
      meta,
      start(),
      user("Review the TypeScript parser"),
      ...noise,
      final("Keep final dialogue and quoted commands.\n```\ntool result\n```"),
      complete(),
    );
    writeFileSync(path, raw);
    const agent = new KnowledgeAgent();
    const staged = await agent.ingestSourceRevision(input(raw));
    expect(staged.status).toBe("staged");
    const service = new MemoryService();
    const queued = service.getPendingEvents()[0];
    expect(queued.candidate).not.toContain(sentinel);
    expect(JSON.parse(queued.candidate).content).toContain("tool result");
    vi.spyOn(MemoryExtractionService.prototype, "extract").mockImplementation(async (candidate) => [
      {
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
      },
    ]);
    await agent.processQueue();
    expect(service.getEventsByStatus("review")).toHaveLength(0);
    const memory = service.getMemory(staged.memoryIds[0])!;
    const notePath = getNotePath(memory.topic, memory.id);
    const before = readFileSync(notePath, "utf-8");
    expect(before).not.toContain(sentinel);
    expect(JSON.stringify(generate.mock.calls)).not.toContain(sentinel);
    expect(embed).toHaveBeenCalled();
    expect(JSON.stringify(embed.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(agent.listSources())).not.toContain(sentinel);
    const count = getDatabase().prepare("SELECT count(*) AS n FROM pending_events").get();
    generate.mockClear();
    embed.mockClear();
    agent.close();
    service.close();
    closeDatabase();
    const restarted = new KnowledgeAgent();
    const appended =
      raw +
      jsonl(...noise, complete("Keep final dialogue and quoted commands.\n```\ntool result\n```"));
    expect((await restarted.ingestSourceRevision(input(appended))).status).toBe("unchanged");
    expect((await restarted.ingestSourceRevision(input(appended))).status).toBe("unchanged");
    expect(getDatabase().prepare("SELECT count(*) AS n FROM pending_events").get()).toEqual(count);
    expect(readFileSync(notePath, "utf-8")).toBe(before);
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    const status = listenStatusAgentSchema.parse({
      sources: restarted.listSources(),
      progress: restarted.listRecentProgress(),
    });
    expect(status.sources[0].dialogue?.completedTurns).toBe(1);
    expect((await restarted.ingestSourceRevision(input(jsonl(meta)))).status).toBe("ignored");
    expect(readFileSync(notePath, "utf-8")).toBe(before);
    for (const name of readdirSync(root, { recursive: true })) {
      if (typeof name === "string" && name.endsWith(".md"))
        expect(readFileSync(join(root, name), "utf-8")).not.toContain(sentinel);
    }
    restarted.close();
  });

  it("waits through half a final event, then stages once with the original snapshot revision", async () => {
    const generate = vi.spyOn(KnowledgeModelAdapter, "generate");
    const embed = vi.spyOn(KnowledgeModelAdapter, "generateEmbedding");
    const agent = new KnowledgeAgent();
    const prefix = jsonl(meta, start(), user());
    const tail = JSON.stringify(final());
    const half = input(prefix + tail.slice(0, -4));
    expect((await agent.ingestSourceRevision(half)).status).toBe("ignored");
    expect(agent.listSources()[0].dialogue?.reasons).toContain("no_final_answer");
    expect(new MemoryService().getPendingEvents()).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    writeFileSync(path, jsonl(meta, start(), user(sentinel), final(sentinel)));
    const full = input(prefix + tail);
    const staged = await agent.ingestSourceRevision(full);
    expect(staged.status).toBe("staged");
    const queue = new MemoryService();
    expect(queue.getPendingEvents()).toHaveLength(1);
    expect(queue.getPendingEvents()[0].sourceRevision).toBe(full.event.revision);
    expect(queue.getPendingEvents()[0].candidate).not.toContain(sentinel);
    expect((await agent.ingestSourceRevision(full)).status).toBe("unchanged");
    queue.close();
    agent.close();
  });

  it("keeps stable memory identity when another completed turn arrives and exposes truncation", async () => {
    const agent = new KnowledgeAgent();
    const first = jsonl(meta, start(), user(), final(), complete());
    const a = await agent.ingestSourceRevision(input(first));
    const second =
      first +
      jsonl(
        start("turn-2"),
        user("Again", "turn-2"),
        final("Allowed ".repeat(1600), "final", "turn-2"),
      );
    const b = await agent.ingestSourceRevision(input(second));
    expect(b.memoryIds).toEqual(a.memoryIds);
    expect(b.normalizationReport?.dialogue?.truncated).toBe(true);
    expect(b.normalizationReport?.dialogue?.completedTurns).toBe(2);
    agent.close();
  });

  it("does not reprocess old revisions or delete historical candidates when filtering becomes empty", async () => {
    const raw = jsonl({ role: "user", content: "Old unsupported source" });
    const old = input(raw);
    const registry = new SourceRegistry();
    registry.beginObservation(old.event);
    registry.markProcessed(old.event);
    const agent = new KnowledgeAgent();
    expect((await agent.ingestSourceRevision(old)).status).toBe("unchanged");
    expect(agent.listSources()[0].dialogue).toBeUndefined();
    const valid = jsonl(meta, start(), user(), final());
    await agent.ingestSourceRevision(input(valid));
    const queue = new MemoryService();
    const before = queue.getPendingEvents();
    const empty = await agent.ingestSourceRevision(
      input(jsonl(meta, event("event_msg", { type: "token_count" }))),
    );
    expect(empty.status).toBe("ignored");
    expect(queue.getPendingEvents()).toEqual(before);
    queue.close();
    agent.close();
    registry.close();
  });

  it("reports unsupported formats without retrying, but read failures remain recoverable", async () => {
    const agent = new KnowledgeAgent();
    const unknown = input(jsonl({ unknown: sentinel }));
    expect((await agent.ingestSourceRevision(unknown)).status).toBe("ignored");
    expect(agent.listSources()[0].dialogue?.reasons).toContain("unsupported_format");
    const missing = input(jsonl(meta, start(), user()));
    await expect(agent.ingestSourceRevision({ ...missing, content: undefined })).rejects.toThrow();
    expect(agent.listProgress({ eventId: missing.event.eventId }).at(-1)?.retryable).toBe(true);
    writeFileSync(path, "Changed after observation");
    await expect(agent.ingestSourceRevision({ ...missing, content: undefined })).rejects.toThrow(
      "来源文件版本已变化",
    );
    agent.close();
  });

  it("filters before nonempty LLM and embedding requests even when the model fails", async () => {
    vi.spyOn(KnowledgeModelAdapter, "isDegradedMode", "get").mockReturnValue(false);
    const generate = vi.spyOn(KnowledgeModelAdapter, "generate").mockResolvedValue({
      content: "{}",
      finishReason: "degraded",
      model: "stub",
      timestamp: new Date().toISOString(),
    });
    const embed = vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockResolvedValue({
      embedding: [1, 0, 0],
      model: "stub",
      timestamp: new Date().toISOString(),
    });
    const agent = new KnowledgeAgent();
    await agent.ingestSourceRevision(
      input(jsonl(meta, start(), user("Explain the parser architecture"), ...noise, final())),
    );
    await agent.processQueue();
    expect(generate).toHaveBeenCalled();
    expect(embed).toHaveBeenCalled();
    expect(JSON.stringify(generate.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(embed.mock.calls)).not.toContain(sentinel);
    expect(new MemoryService().getEventsByStatus("waiting_dependency")).toHaveLength(0);
    expect(new MemoryService().getEventsByStatus("done")).toHaveLength(1);
    agent.close();
  });
});
