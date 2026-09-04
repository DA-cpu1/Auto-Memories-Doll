import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { closeDatabase } from "../lib/storage/database";
import { getNotePath, invalidatePathCache } from "../lib/storage/path-resolver";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { buildMemoryRecord } from "../lib/memory/builder";
import { MemoryService } from "../server/services/memory-service";
import { VectorRetriever } from "../lib/vector/retriever";
import { searchWithExpansion } from "../lib/vector/query-expansion";
import { formatMemoryAsMarkdown } from "../lib/storage/markdown-formatter";
import { WikiGraph } from "../lib/graph/wiki-graph";
import { Ranker } from "../lib/vector/ranker";
import { HnswVectorSearchBackend } from "../lib/vector/backend";

const memoryRoot = process.env.MEMORY_ROOT!;

function resetStorage(): void {
  closeDatabase();
  invalidatePathCache();
  rmSync(memoryRoot, { recursive: true, force: true });
  mkdirSync(memoryRoot, { recursive: true });
}

beforeEach(() => {
  resetStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
});

describe.sequential("retained retrieval characterization", () => {
  it("falls back to real keyword retrieval when embeddings are unavailable", async () => {
    vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockResolvedValue({
      embedding: [],
      model: "unavailable",
      timestamp: "2026-09-03T00:00:00.000Z",
    });

    const service = new MemoryService();
    await service.createMemoryRecord(
      buildMemoryRecord(
        "offline.md",
        "manual",
        "离线检索方案",
        "Embedding 不可用时使用本地关键词检索。",
        "关键词降级保证资料仍可查阅。",
        ["离线", "检索"],
        "learning",
        "keyword-target",
      ),
    );
    await service.createMemoryRecord(
      buildMemoryRecord(
        "travel.md",
        "manual",
        "周末计划",
        "准备户外徒步用品。",
        "与技术检索无关。",
        ["生活"],
        "daily-notes",
        "keyword-unrelated",
      ),
    );
    service.close();

    const retriever = new VectorRetriever();
    const response = await retriever.searchDetailed("离线检索", 5);
    retriever.close();

    expect(response.mode).toBe("keyword");
    expect(response.results.map((result) => result.memoryId)).toEqual(["keyword-target"]);
  });

  it("retrieves the closest knowledge unit through the real vector index", async () => {
    vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockImplementation(async (text) => ({
      embedding: text.includes("SQLite") ? [0, 1] : [1, 0],
      model: "characterization-embedding",
      timestamp: "2026-09-03T00:00:00.000Z",
    }));

    const service = new MemoryService();
    await service.createMemoryRecord(
      buildMemoryRecord(
        "react.md",
        "manual",
        "减少组件重绘",
        "React.memo 可以避免属性未变化组件的重复渲染。",
        "前端渲染性能经验。",
        ["React", "性能"],
        "ai-coding",
        "vector-target",
      ),
    );
    await service.createMemoryRecord(
      buildMemoryRecord(
        "sqlite.md",
        "manual",
        "SQLite 事务",
        "SQLite 写入应当放入事务中。",
        "数据库事务经验。",
        ["SQLite"],
        "ai-coding",
        "vector-unrelated",
      ),
    );
    service.close();

    const retriever = new VectorRetriever();
    const response = await retriever.searchDetailed("避免无效重绘", 2, 0);
    retriever.close();

    expect(response.mode).toBe("vector");
    expect(response.results[0]).toMatchObject({ memoryId: "vector-target", similarity: 1 });
    expect(response.results[1]?.memoryId).toBe("vector-unrelated");
  });

  it("merges the original query and a rewritten variant by each unit's best score", async () => {
    vi.spyOn(KnowledgeModelAdapter, "generateEmbedding").mockImplementation(async (text) => {
      let embedding = [1, 0];
      if (text === "前端性能方法") embedding = [0.2, 0.98];
      if (text.includes("SQLite")) embedding = [0, 1];
      return {
        embedding,
        model: "characterization-embedding",
        timestamp: "2026-09-03T00:00:00.000Z",
      };
    });
    vi.spyOn(KnowledgeModelAdapter, "generate").mockResolvedValue({
      content: '{"variants":["避免组件重绘"]}',
      finishReason: "stop",
      model: "characterization-model",
      timestamp: "2026-09-03T00:00:00.000Z",
    });

    const service = new MemoryService();
    await service.createMemoryRecord(
      buildMemoryRecord(
        "react.md",
        "manual",
        "减少组件重绘",
        "React.memo 可以避免属性未变化组件的重复渲染。",
        "前端渲染性能经验。",
        ["React", "性能"],
        "ai-coding",
        "expanded-target",
      ),
    );
    await service.createMemoryRecord(
      buildMemoryRecord(
        "sqlite.md",
        "manual",
        "SQLite 查询性能",
        "SQLite 索引能够减少全表扫描。",
        "数据库查询性能经验。",
        ["SQLite", "性能"],
        "ai-coding",
        "original-query-target",
      ),
    );
    service.close();

    const retriever = new VectorRetriever();
    const results = await searchWithExpansion(retriever, "前端性能方法", 2, {
      minSimilarity: 0,
    });
    retriever.close();

    expect(results).toEqual([
      { memoryId: "expanded-target", similarity: 1 },
      { memoryId: "original-query-target", similarity: expect.closeTo(0.98, 2) },
    ]);
  });

  it("rebuilds graph neighbors from relationships stored in canonical Markdown", async () => {
    const source = buildMemoryRecord(
      "graph-a.md",
      "manual",
      "React 性能",
      "组件渲染优化。",
      "前端性能知识。",
      ["React"],
      "ai-coding",
      "graph-a",
    );
    source.graphLinks = ["graph-b"];
    const target = buildMemoryRecord(
      "graph-b.md",
      "manual",
      "性能测量",
      "优化前后应当进行性能测量。",
      "性能验证知识。",
      ["性能"],
      "ai-coding",
      "graph-b",
    );

    for (const record of [source, target]) {
      const path = getNotePath(record.topic, record.id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, formatMemoryAsMarkdown(record), "utf-8");
    }

    const graph = new WikiGraph();
    expect(await graph.getNeighbors("graph-a")).toEqual(["graph-b"]);
    expect(await graph.getIncomingLinks("graph-b")).toEqual(["graph-a"]);
  });

  it("uses MMR to place a diverse result before a near-duplicate", () => {
    const updatedAt = "2026-09-03T00:00:00.000Z";
    const first = buildMemoryRecord(
      "first.md",
      "manual",
      "React 重绘优化",
      "React.memo 优化。",
      "React 性能。",
      ["React", "性能"],
      "ai-coding",
      "mmr-first",
    );
    const duplicate = {
      ...buildMemoryRecord(
        "duplicate.md",
        "manual",
        "组件重绘优化",
        "memo 优化。",
        "组件性能。",
        ["React", "性能"],
        "ai-coding",
        "mmr-duplicate",
      ),
      updatedAt,
    };
    const diverse = {
      ...buildMemoryRecord(
        "diverse.md",
        "manual",
        "SQLite 索引",
        "数据库索引优化。",
        "数据库性能。",
        ["SQLite", "数据库"],
        "ai-coding",
        "mmr-diverse",
      ),
      updatedAt,
    };
    first.updatedAt = updatedAt;
    const memories = new Map([
      [first.id, first],
      [duplicate.id, duplicate],
      [diverse.id, diverse],
    ]);

    const results = new Ranker().rankWithMMR(
      [
        { memoryId: first.id, similarity: 0.9 },
        { memoryId: duplicate.id, similarity: 0.89 },
        { memoryId: diverse.id, similarity: 0.75 },
      ],
      memories,
    );

    expect(results.map((result) => result.memoryId)).toEqual([
      "mmr-first",
      "mmr-diverse",
      "mmr-duplicate",
    ]);
  });

  it("rebuilds a deleted ANN sidecar without changing canonical Markdown", () => {
    const canonical = buildMemoryRecord(
      "canonical.md",
      "manual",
      "可重建索引",
      "向量索引损坏时应从 SQLite 真源重建。",
      "Markdown 正文不参与索引重建写入。",
      ["向量", "重建"],
      "ai-coding",
      "rebuild-target",
    );
    const canonicalPath = getNotePath(canonical.topic, canonical.id);
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(canonicalPath, formatMemoryAsMarkdown(canonical), "utf-8");
    const markdownBefore = readFileSync(canonicalPath, "utf-8");

    const dbPath = join(memoryRoot, "rebuild-vector.db");
    const indexBasePath = join(memoryRoot, "derived", "vector-index");
    mkdirSync(dirname(indexBasePath), { recursive: true });
    const firstDb = new Database(dbPath);
    firstDb.exec(`
      CREATE TABLE vector_records (
        memoryId TEXT PRIMARY KEY,
        embedding BLOB,
        model TEXT,
        dimensions INTEGER,
        updatedAt TEXT
      )
    `);
    firstDb
      .prepare(
        `INSERT INTO vector_records
          (memoryId, embedding, model, dimensions, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(canonical.id, JSON.stringify([1, 0, 0]), "characterization", 3, canonical.updatedAt);

    const firstBackend = new HnswVectorSearchBackend(firstDb, indexBasePath);
    expect(firstBackend.search([1, 0, 0], 1)[0]?.memoryId).toBe(canonical.id);
    firstBackend.close();
    firstDb.close();

    const sidecarPath = `${indexBasePath}-3.usearch`;
    expect(existsSync(sidecarPath)).toBe(true);
    rmSync(sidecarPath);

    const secondDb = new Database(dbPath);
    const rebuiltBackend = new HnswVectorSearchBackend(secondDb, indexBasePath);
    expect(rebuiltBackend.search([1, 0, 0], 1)[0]?.memoryId).toBe(canonical.id);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(readFileSync(canonicalPath, "utf-8")).toBe(markdownBefore);
    rebuiltBackend.close();
    secondDb.close();
  });
});
