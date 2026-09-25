import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_TOOL_NAMES, AskToolkit, summarizeToolResult } from "../server/services/ask-tools";
import { MemoryRecord } from "../types/memory";
import { StudyGuide } from "../types/study-guide";

function buildMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    version: 2,
    source: "codex-session",
    sourceType: "listen",
    title: "Vector backend",
    titleZh: "向量后端",
    content: "项目默认使用 USearch HNSW ANN，JS 精确扫描仅作降级。",
    summary: "USearch HNSW with JS fallback",
    summaryZh: "USearch HNSW 索引与 JS 降级",
    tags: ["vector"],
    topic: "ai-coding",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    accessedAt: "2026-09-02T00:00:00.000Z",
    accessCount: 0,
    heatScore: 0,
    graphLinks: [],
    ...overrides,
  };
}

function buildToolkit(
  overrides: {
    searchResults?: { memoryId: string; similarity: number }[];
    mode?: "vector" | "keyword";
    memories?: MemoryRecord[];
    guide?: StudyGuide | null;
    source?: { sourceId: string; sourceType: string; sourcePath?: string } | null;
  } = {},
) {
  const memories = overrides.memories ?? [buildMemory()];
  return new AskToolkit({
    retriever: {
      searchDetailed: async () => ({
        results: overrides.searchResults ?? [{ memoryId: "mem-1", similarity: 0.87654 }],
        mode: overrides.mode ?? "vector",
      }),
    },
    memoryService: {
      getMemoriesByIds: (ids: string[]) => memories.filter((m) => ids.includes(m.id)),
      getMemory: (id: string) => memories.find((m) => m.id === id) ?? null,
    },
    sourceRegistry: {
      getSource: (id: string) =>
        overrides.source && overrides.source.sourceId === id ? overrides.source : null,
    },
    guideReader: {
      getGuide: async () => overrides.guide ?? null,
    },
  });
}

describe("AskToolkit.searchMemory", () => {
  it("映射检索结果，中文标题回退与 score 保留 4 位小数", async () => {
    const toolkit = buildToolkit();
    const result = await toolkit.searchMemory({ query: "向量索引" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mode).toBe("vector");
    expect(result.data.results).toEqual([
      {
        memoryId: "mem-1",
        title: "向量后端",
        summary: "USearch HNSW 索引与 JS 降级",
        topic: "ai-coding",
        score: 0.8765,
      },
    ]);
  });

  it("检索命中的 id 在记忆库缺失时被过滤", async () => {
    const toolkit = buildToolkit({
      searchResults: [
        { memoryId: "mem-1", similarity: 0.9 },
        { memoryId: "ghost", similarity: 0.5 },
      ],
    });
    const result = await toolkit.searchMemory({ query: "x" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.map((r) => r.memoryId)).toEqual(["mem-1"]);
  });

  it("空命中与关键词降级模式都返回 ok", async () => {
    const empty = await buildToolkit({ searchResults: [] }).searchMemory({ query: "不存在" });
    expect(empty).toEqual({ ok: true, data: { mode: "vector", results: [] } });

    const keyword = await buildToolkit({ mode: "keyword" }).searchMemory({ query: "关键词" });
    expect(keyword.ok && keyword.data.mode).toBe("keyword");
  });

  it("检索器抛错时返回 ok:false 而非抛出", async () => {
    const toolkit = new AskToolkit({
      retriever: {
        searchDetailed: async () => {
          throw new Error("embedding 服务不可用");
        },
      },
      memoryService: { getMemoriesByIds: () => [], getMemory: () => null },
      sourceRegistry: { getSource: () => null },
      guideReader: { getGuide: async () => null },
    });

    const result = await toolkit.searchMemory({ query: "x" });
    expect(result).toEqual({ ok: false, error: "embedding 服务不可用" });
  });
});

describe("AskToolkit.readMemory", () => {
  it("读取存在的记忆返回完整内容", async () => {
    const result = await buildToolkit().readMemory({ memoryId: "mem-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.memoryId).toBe("mem-1");
    expect(result.data.title).toBe("向量后端");
    expect(result.data.content).toContain("USearch");
    expect(result.data.source).toBe("codex-session");
  });

  it("记忆不存在返回结构化错误", async () => {
    const result = await buildToolkit().readMemory({ memoryId: "nope" });
    expect(result).toEqual({ ok: false, error: "记忆不存在: nope" });
  });
});

describe("AskToolkit.readSourceDocument", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ask-tools-test-"));

  it("读取来源文件全文", async () => {
    const filePath = join(tempDir, "session-a.jsonl");
    writeFileSync(filePath, "line1\nline2\n", "utf-8");

    const result = await buildToolkit({
      source: { sourceId: "src-a", sourceType: "codex", sourcePath: filePath },
    }).readSourceDocument({ sourceId: "src-a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toBe("line1\nline2\n");
    expect(result.data.truncated).toBe(false);
    expect(result.data.sourceType).toBe("codex");
  });

  it("超长文件截断到上限并标注 truncated", async () => {
    const filePath = join(tempDir, "big.md");
    writeFileSync(filePath, "x".repeat(10000), "utf-8");

    const result = await buildToolkit({
      source: { sourceId: "src-big", sourceType: "markdown", sourcePath: filePath },
    }).readSourceDocument({ sourceId: "src-big" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.content.length).toBe(8000);
  });

  it("来源不存在、无路径、文件缺失都返回结构化错误", async () => {
    const missing = await buildToolkit().readSourceDocument({ sourceId: "nope" });
    expect(missing.ok).toBe(false);

    const noPath = await buildToolkit({
      source: { sourceId: "src-b", sourceType: "codex" },
    }).readSourceDocument({ sourceId: "src-b" });
    expect(noPath).toEqual({ ok: false, error: expect.stringContaining("未登记文件路径") });

    const gone = await buildToolkit({
      source: { sourceId: "src-c", sourceType: "codex", sourcePath: join(tempDir, "gone.md") },
    }).readSourceDocument({ sourceId: "src-c" });
    expect(gone.ok).toBe(false);
  });

  it("清理临时目录", () => {
    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("AskToolkit.readTopicGuide", () => {
  const guide: StudyGuide = {
    schemaVersion: 1,
    topic: "ai-coding",
    title: "AI 编码知识",
    outline: [{ sectionId: "s1", title: "架构" }],
    sections: [
      {
        id: "s1",
        title: "架构",
        content: "y".repeat(700),
        memoryIds: ["mem-1"],
      },
    ],
    memoryIds: ["mem-1"],
    sourceVersions: [],
    contentHash: "hash",
    generatedAt: "2026-09-01T00:00:00.000Z",
    modelAssisted: false,
  };

  it("返回大纲与章节，超长章节内容截断", async () => {
    const result = await buildToolkit({ guide }).readTopicGuide({ topic: "ai-coding" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outline).toEqual([{ sectionId: "s1", title: "架构" }]);
    expect(result.data.sections[0].memoryIds).toEqual(["mem-1"]);
    expect(result.data.sections[0].content.length).toBe(601); // 600 + 省略号
  });

  it("无学习资料与非法 topic 都返回结构化错误", async () => {
    const none = await buildToolkit({ guide: null }).readTopicGuide({ topic: "ai-coding" });
    expect(none).toEqual({ ok: false, error: "尚无主题「ai-coding」的学习资料" });

    const invalid = await new AskToolkit({
      retriever: { searchDetailed: async () => ({ results: [], mode: "vector" }) },
      memoryService: { getMemoriesByIds: () => [], getMemory: () => null },
      sourceRegistry: { getSource: () => null },
      guideReader: {
        getGuide: async () => {
          throw new Error("Invalid study guide topic: ../etc");
        },
      },
    }).readTopicGuide({ topic: "../etc" });
    expect(invalid.ok).toBe(false);
  });
});

describe("summarizeToolResult", () => {
  it("为每类结果生成短摘要", () => {
    expect(
      summarizeToolResult(ASK_TOOL_NAMES.searchMemory, {
        ok: true,
        data: { mode: "vector", results: [{}, {}] },
      }),
    ).toBe("命中 2 条（vector）");

    expect(
      summarizeToolResult(ASK_TOOL_NAMES.readMemory, {
        ok: true,
        data: { memoryId: "m1", content: "x".repeat(100) },
      }),
    ).toBe("读取 m1（100 字）");

    expect(summarizeToolResult(ASK_TOOL_NAMES.readMemory, { ok: false, error: "boom" })).toBe(
      "失败: boom",
    );

    expect(summarizeToolResult("unknown_tool", { ok: true, data: {} })).toBe("完成");
  });
});
