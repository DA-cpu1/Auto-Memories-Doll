import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock knowledge model boundary ──
vi.mock("../lib/ai/knowledge-model-adapter", () => ({
  KnowledgeModelAdapter: {
    suppressInvalidOutput: vi.fn(),
    generate: vi.fn(),
    isDegradedMode: false,
  },
}));

import { QualityFilterService } from "../server/services/quality-filter-service";
import { MemoryRecord } from "../types/memory";
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { MemoryExtractionService } from "../server/services/memory-extraction-service";
const ModelAdapter = KnowledgeModelAdapter;

const makeCandidate = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "mem-1",
  version: 2,
  source: "test",
  sourceType: "manual",
  title: "Test Memory",
  content: "This is a valuable insight about software architecture.",
  summary: "Valuable insight",
  tags: ["architecture"],
  topic: "tech",
  graphLinks: [],
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  accessedAt: "2026-01-01",
  accessCount: 0,
  heatScore: 0,
  ...overrides,
});

const llmReply = (json: unknown) => ({
  content: typeof json === "string" ? json : JSON.stringify(json),
  finishReason: "stop",
  model: "test",
  timestamp: Date.now(),
});

describe("QualityFilterService", () => {
  let service: QualityFilterService;

  beforeEach(() => {
    vi.clearAllMocks();
    (KnowledgeModelAdapter as any).isDegradedMode = false;
    service = new QualityFilterService();
  });

  it("Embedding 降级不阻止可用的质量模型", async () => {
    (KnowledgeModelAdapter as any).isDegradedMode = true;
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9 }));

    const result = await service.filter(makeCandidate());

    expect(result.verdict).toBe("accept");
    expect(ModelAdapter.generate).toHaveBeenCalled();
  });

  it("ignores a high score in thinking and uses the final lower score", async () => {
    vi.mocked(ModelAdapter.generate).mockResolvedValue(
      llmReply(
        '<think>Example {"score":9}, Record<T, { title: string }></think>\n{"score":2,"kind":"fact","reason":"缺少知识"}',
      ) as any,
    );
    await expect(service.filter(makeCandidate())).resolves.toMatchObject({
      verdict: "reject",
      score: 2,
    });
  });

  it("does not accept valid-looking JSON from a truncated completion", async () => {
    vi.mocked(ModelAdapter.generate).mockResolvedValue({
      ...llmReply({ score: 9 }),
      finishReason: "length",
    } as any);
    await expect(service.filter(makeCandidate())).rejects.toMatchObject({
      reason: "OUTPUT_TRUNCATED",
    });
  });

  it("extracts final cards rather than thinking examples", async () => {
    vi.mocked(ModelAdapter.generate).mockResolvedValue(
      llmReply(
        '<think>{"memories":[{"title":"错误示例","content":"推理内容"}]}</think>\n{"memories":[{"title":"正式卡片","summary":"最终摘要","content":"有来源的最终知识","tags":["知识"]}]}',
      ) as any,
    );
    const cards = await new MemoryExtractionService().extract(makeCandidate());
    expect(cards).toEqual([
      { title: "正式卡片", summary: "最终摘要", content: "有来源的最终知识", tags: ["知识"] },
    ]);
  });

  it("score ≥ 7 → accept", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9, reason: "含具体决策" }));

    const result = await service.filter(makeCandidate());

    expect(result).toMatchObject({ verdict: "accept", score: 9 });
  });

  it("score = 7 → review（严格筛选，避免把边缘内容误放行）", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 7, reason: "还不够扎实" }));

    const result = await service.filter(makeCandidate());

    expect(result).toMatchObject({ verdict: "review", score: 7 });
  });

  it("4 ≤ score < 7 → review（灰区转人工）", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 5, reason: "信息量一般" }));

    const result = await service.filter(makeCandidate());

    expect(result).toMatchObject({ verdict: "review", score: 5 });
  });

  it("score < 4 → reject，返回原因", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 2, reason: "空泛无实质" }));

    const result = await service.filter(makeCandidate());

    expect(result).toMatchObject({ verdict: "reject", score: 2, reason: "空泛无实质" });
  });

  it("score 越界 → clamp 到 0-10", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 42 }));

    const result = await service.filter(makeCandidate());

    expect(result).toMatchObject({ verdict: "accept", score: 10 });
  });

  it("markdown 代码块包裹的 JSON 也能解析", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(
      llmReply('```json\n{"score": 8, "reason": "有价值"}\n```'),
    );

    const result = await service.filter(makeCandidate());

    expect(result.verdict).toBe("accept");
  });

  it("非标准输出有限重试后返回依赖故障", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply("这是一个好记忆"));

    await expect(service.filter(makeCandidate())).rejects.toMatchObject({
      reason: "INVALID_OUTPUT",
      stage: "quality",
    });
    expect(ModelAdapter.generate).toHaveBeenCalledTimes(2);
  });

  it("第一次输出异常、第二次正常 → 返回正常判定", async () => {
    (ModelAdapter.generate as any)
      .mockResolvedValueOnce(llmReply("抱歉我无法判断"))
      .mockResolvedValueOnce(llmReply({ score: 8, reason: "ok" }));

    const result = await service.filter(makeCandidate());

    expect(result.verdict).toBe("accept");
  });

  it("API 调用异常返回服务依赖故障", async () => {
    (ModelAdapter.generate as any).mockRejectedValue(new Error("Network error"));

    await expect(service.filter(makeCandidate())).rejects.toMatchObject({
      reason: "REQUEST_FAILED",
    });
  });

  it("相似记忆提示注入 prompt（新颖性判断上下文）", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 8 }));

    await service.filter(makeCandidate(), [
      { title: "已有记忆", summary: "已有摘要", similarity: 0.8 },
    ]);

    const prompt = (ModelAdapter.generate as any).mock.calls[0][0] as string;
    expect(prompt).toContain("已有记忆");
    expect(prompt).toContain("80%");
  });

  // ═══════════════════════════════════════════════════════════════
  // kind 分类与证据约束
  // ═══════════════════════════════════════════════════════════════

  it("kind=inference 且评分达标 → 仍转 review（非事实只能进待验证区）", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(
      llmReply({ score: 9, kind: "inference", reason: "推导结论" }),
    );

    const result = await service.filter(makeCandidate({ evidence: { text: "原文片段" } }));

    expect(result.verdict).toBe("review");
    expect(result).toMatchObject({ kind: "inference" });
  });

  it("kind=hypothesis / insight 同样强制 review", async () => {
    for (const kind of ["hypothesis", "insight"] as const) {
      (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9, kind }));

      const result = await service.filter(makeCandidate({ evidence: { text: "原文片段" } }));

      expect(result.verdict).toBe("review");
    }
  });

  it("kind 输出非法值 → 视为 fact", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(
      llmReply({ score: 9, kind: "rumor", reason: "ok" }),
    );

    const result = await service.filter(makeCandidate({ evidence: { text: "原文片段" } }));

    expect(result.verdict).toBe("accept");
    expect(result).toMatchObject({ kind: "fact" });
  });

  it("采集类入口（ingest）fact 无证据 → review，不得自动入库", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9, kind: "fact" }));

    const result = await service.filter(makeCandidate({ sourceType: "ingest" }));

    expect(result.verdict).toBe("review");
    expect(result.reason).toContain("证据");
  });

  it("采集类入口（listen）fact 带证据 → 正常 accept", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9, kind: "fact" }));

    const result = await service.filter(
      makeCandidate({
        sourceType: "listen",
        evidence: { text: "对话原文片段", location: "https://x" },
      }),
    );

    expect(result.verdict).toBe("accept");
  });

  it("白名单外入口（manual/chat）无证据不强制 review", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 9, kind: "fact" }));

    const result = await service.filter(makeCandidate({ sourceType: "manual" }));

    expect(result.verdict).toBe("accept");
  });

  it("证据片段注入 prompt", async () => {
    (ModelAdapter.generate as any).mockResolvedValue(llmReply({ score: 8 }));

    await service.filter(
      makeCandidate({ evidence: { text: "关键原文片段", location: "docs/a.md" } }),
    );

    const prompt = (ModelAdapter.generate as any).mock.calls[0][0] as string;
    expect(prompt).toContain("关键原文片段");
    expect(prompt).toContain("docs/a.md");
  });
});
