import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeDatabase, getDatabase } from "../lib/storage/database";
import { invalidatePathCache } from "../lib/storage/path-resolver";
import { normalizeTextWithReport } from "../lib/utils/normalization";
import { redactSecrets } from "../lib/security/secret-redactor";
import { splitSemanticText } from "../server/pipelines/splitter";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import { KnowledgeAgent } from "../server/services/knowledge-agent";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { MemoryService } from "../server/services/memory-service";
import { SourceRegistry } from "../server/services/source-registry";
import { buildMemoryRecord } from "../lib/memory/builder";

const memoryRoot = process.env.MEMORY_ROOT!;

function resetStorage(): void {
  closeDatabase();
  invalidatePathCache();
  rmSync(memoryRoot, { recursive: true, force: true });
  mkdirSync(memoryRoot, { recursive: true });
}

describe.sequential("Phase 3 normalization and provenance", () => {
  beforeEach(resetStorage);
  afterEach(() => vi.restoreAllMocks());

  it("reports every removed noise category and preserves readable markdown", () => {
    const result = normalizeTextWithReport(
      "# Note\r\n\r\nBody\u0000\r\n\r\nBody\r\n\r\n[tool result]\r\n\r\nERROR repeated\r\nERROR repeated\r\n\uFFFD",
    );

    expect(result.content).toBe("# Note\n\nBody\n\nERROR repeated");
    expect(result.report.removedNoise).toEqual(
      expect.arrayContaining([
        { kind: "control-character", count: 1 },
        { kind: "invalid-encoding", count: 1 },
        { kind: "duplicate-block", count: 1 },
        { kind: "tool-boilerplate", count: 1 },
        { kind: "duplicate-log", count: 1 },
      ]),
    );
  });

  it("splits markdown sections and conversation turns before using length fallback", () => {
    const chunks = splitSemanticText(
      "# Intro\n\nOverview\n\n## Details\n\nMore detail\n\n### 用户\n\nQuestion\n\n### AI\n\nAnswer",
      { sourceId: "source-test", maxChunkSize: 500 },
    );

    expect(chunks.map((chunk) => chunk.boundary)).toEqual([
      "markdown-section",
      "markdown-section",
      "conversation-turn",
      "conversation-turn",
    ]);
    expect(chunks.map((chunk) => chunk.locator)).toEqual([
      "heading:Intro",
      "heading:Details",
      "heading:用户",
      "heading:AI",
    ]);
    expect(new Set(chunks.map((chunk) => chunk.hash)).size).toBe(chunks.length);
  });

  it("redacts common credentials without removing surrounding context", () => {
    const result = redactSecrets(
      "Authorization: Bearer token-value-123456\napi_key=sk-proj-abcdefghijklmnopqrstuvwxyz\nAKIA1234567890ABCDEF",
    );

    expect(result.content).not.toContain("token-value-123456");
    expect(result.content).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(result.content).not.toContain("AKIA1234567890ABCDEF");
    expect(result.content).toContain("Authorization: Bearer [REDACTED]");
    expect(result.redactedCount).toBe(3);
  });

  it("persists normalization reports and treats noise-only source changes as no-ops", async () => {
    const sourcePath = `${memoryRoot}/phase-3.md`;
    const firstContent = "# Stable\n\nMeaningful content for the knowledge source.";
    const changedContent = `${firstContent}\n\n[tool result]`;
    const first = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content: firstContent,
      operation: "add",
    });
    const changed = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content: changedContent,
      operation: "change",
    });
    const agent = new KnowledgeAgent();

    const staged = await agent.ingestSourceRevision({ event: first, content: firstContent });
    const unchanged = await agent.ingestSourceRevision({ event: changed, content: changedContent });

    expect(staged.status).toBe("staged");
    expect(unchanged.status).toBe("unchanged");
    expect(unchanged.normalizationReport?.removedNoise).toContainEqual({
      kind: "tool-boilerplate",
      count: 1,
    });
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM pending_events").get()).toEqual({
      count: 1,
    });
    const version = getDatabase()
      .prepare(
        "SELECT normalizationReport FROM source_versions WHERE sourceId = ? AND revision = ?",
      )
      .get(changed.sourceId, changed.revision) as { normalizationReport: string };
    expect(JSON.parse(version.normalizationReport).removedNoise).toContainEqual({
      kind: "tool-boilerplate",
      count: 1,
    });
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM source_chunks WHERE sourceId = ?")
        .get(first.sourceId),
    ).toEqual({ count: 2 });
    agent.close();
  });

  it("links an accepted knowledge unit to its exact source version", async () => {
    vi.spyOn(KnowledgeModelAdapter, "isDegradedMode", "get").mockReturnValue(true);
    const sourcePath = `${memoryRoot}/linked.md`;
    const content = "# Linked\n\nThis accepted unit retains its exact local source revision.";
    const event = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath,
      content,
      operation: "add",
    });
    const agent = new KnowledgeAgent();
    const staged = await agent.ingestSourceRevision({ event, content });
    await agent.processQueue();
    const review = agent.getReviewEvents()[0];
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM source_memory_links WHERE memoryId = ?")
        .get(staged.memoryIds[0]),
    ).toEqual({ count: 0 });
    await agent.resolveReviewEvent(review.eventId, "accept");

    expect(
      getDatabase()
        .prepare("SELECT sourceId, revision, memoryId FROM source_memory_links WHERE memoryId = ?")
        .get(staged.memoryIds[0]),
    ).toEqual({
      sourceId: event.sourceId,
      revision: event.revision,
      memoryId: staged.memoryIds[0],
    });
    const evidence = getDatabase()
      .prepare("SELECT evidence FROM memories WHERE id = ?")
      .get(staged.memoryIds[0]) as { evidence: string };
    expect(JSON.parse(evidence.evidence)).toMatchObject({
      sourceId: event.sourceId,
      sourceRevision: event.revision,
      sourceEventId: event.eventId,
    });
    agent.close();
  });

  it("backfills provenance for legacy memories that have a source hash", async () => {
    const memoryService = new MemoryService();
    const legacy = buildMemoryRecord(
      `${memoryRoot}/legacy.md`,
      "ingest",
      "Legacy",
      "Legacy knowledge with enough source evidence to migrate.",
      "Legacy knowledge",
      [],
      "learning",
      "legacy-memory",
      undefined,
      {
        evidence: {
          text: "Legacy knowledge",
          location: `${memoryRoot}/legacy.md`,
          sourceHash: "legacy-revision-hash",
        },
      },
    );
    await memoryService.createMemoryRecord(legacy);
    const registry = new SourceRegistry();

    expect(registry.getMemoryLinks(legacy.id)).toEqual([
      expect.objectContaining({
        memoryId: legacy.id,
        revision: "legacy-revision-hash",
        locator: `${memoryRoot}/legacy.md`,
      }),
    ]);
    registry.close();
    memoryService.close();
  });
});
