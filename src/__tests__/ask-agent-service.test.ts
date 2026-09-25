import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AskAgentService,
  splitAnswerAndCitations,
  verifyCitations,
} from "../server/services/ask-agent-service";
import { AskToolkit } from "../server/services/ask-tools";
import { getDatabase } from "../lib/storage/database";
import { AskLogService } from "../server/services/ask-log-service";
import { MemoryRecord } from "../types/memory";

// ── mock: ai SDK（streamText/generateText 只在受控桩内运行） ──
const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  generateText: aiMocks.generateText,
  stepCountIs: (n: number) => n,
  tool: (definition: unknown) => definition,
}));

function makeStreamResult(
  parts: Array<Record<string, unknown>>,
  usage = { inputTokens: 100, outputTokens: 40 },
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        if (part.__throw) throw part.__throw;
        yield part;
      }
    })(),
    usage: Promise.resolve(usage),
    finishReason: Promise.resolve("stop"),
  };
}

function makeTextResult(text: string, usage = { inputTokens: 80, outputTokens: 30 }) {
  return { text, usage, finishReason: "stop" };
}

// ── 测试记忆库 ──
const MEMORY_CONTENT = "项目默认使用 USearch HNSW ANN 索引，JS 精确扫描仅作降级备用。";

function memoryServiceStub(memories: MemoryRecord[]) {
  return {
    getMemoriesByIds: (ids: string[]) => memories.filter((m) => ids.includes(m.id)),
    getMemory: (id: string) => memories.find((m) => m.id === id) ?? null,
  };
}

function stubToolkit(memories: MemoryRecord[]) {
  const retriever = { searchDetailed: async () => ({ results: [], mode: "vector" as const }) };
  return new AskToolkit({
    retriever,
    memoryService: memoryServiceStub(memories),
    sourceRegistry: { getSource: () => null },
    guideReader: { getGuide: async () => null },
  });
}

function buildMem(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    version: 2,
    source: "codex",
    sourceType: "listen",
    title: "向量索引选型",
    content: MEMORY_CONTENT,
    summary: "USearch HNSW 为主，JS 精确为降级",
    tags: ["vector"],
    topic: "ai-coding",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    accessedAt: "2026-09-01T00:00:00.000Z",
    accessCount: 0,
    heatScore: 0,
    graphLinks: [],
    ...overrides,
  };
}

function buildService(memories: MemoryRecord[]) {
  return new AskAgentService({
    toolkit: {
      retriever: { searchDetailed: async () => ({ results: [], mode: "vector" as const }) },
      memoryService: memoryServiceStub(memories),
      sourceRegistry: { getSource: () => null },
      guideReader: { getGuide: async () => null },
    },
  });
}

const CITED_ANSWER =
  '项目使用 USearch HNSW ANN 作为向量索引。\n<citations>\n[{"memoryId": "mem-1", "quote": "USearch HNSW ANN 索引"}]\n</citations>';

describe("splitAnswerAndCitations", () => {
  it("拆分答案与引用区块并解析 JSON", () => {
    const { answer, citations, parseError } = splitAnswerAndCitations(CITED_ANSWER);

    expect(answer).toBe("项目使用 USearch HNSW ANN 作为向量索引。");
    expect(citations).toEqual([{ memoryId: "mem-1", quote: "USearch HNSW ANN 索引" }]);
    expect(parseError).toBeUndefined();
  });

  it("无引用区块时 citations 为空并标注 parseError", () => {
    const { answer, citations, parseError } = splitAnswerAndCitations("普通回答");
    expect(answer).toBe("普通回答");
    expect(citations).toEqual([]);
    expect(parseError).toBe("missing-citations-block");
  });

  it("JSON 损坏时标注 citations-invalid-json", () => {
    const { parseError } = splitAnswerAndCitations("答案\n<citations>[{bad json}]</citations>");
    expect(parseError).toBe("citations-invalid-json");
  });

  it("出现多个区块时只取最后一个", () => {
    const raw = `示例格式 <citations>[{"memoryId": "demo", "quote": "演示而已"}]</citations>
正式答案。
<citations>[{"memoryId": "mem-1", "quote": "USearch HNSW ANN 索引"}]</citations>`;
    const { answer, citations } = splitAnswerAndCitations(raw);

    expect(citations).toEqual([{ memoryId: "mem-1", quote: "USearch HNSW ANN 索引" }]);
    expect(answer).toContain("示例格式");
    expect(answer).not.toContain("mem-1");
  });

  it("过滤结构不完整的引用条目", () => {
    const { citations } = splitAnswerAndCitations(
      '答\n<citations>[{"memoryId": "mem-1", "quote": "USearch HNSW ANN 索引"}, {"foo": 1}]</citations>',
    );
    expect(citations).toHaveLength(1);
  });
});

describe("verifyCitations", () => {
  it("逐字引用（含空白差异）通过校验", () => {
    const toolkit = stubToolkit([buildMem()]);
    const result = verifyCitations(
      [{ memoryId: "mem-1", quote: "USearch  HNSW\nANN 索引" }],
      toolkit,
    );

    expect(result.valid).toBe(true);
    expect(result.citations[0].verified).toBe(true);
  });

  it("全半角标点变体的引用通过校验（编码变体不算改写）", () => {
    const toolkit = stubToolkit([
      buildMem({
        content: "时间：2026-09-08 18:30:52至18:31:15（实例ID：3ab6838），未收到回调。",
      }),
    ]);
    const result = verifyCitations(
      [
        {
          memoryId: "mem-1",
          quote: "时间:2026-09-08 18:30:52至18:31:15(实例ID:3ab6838),未收到回调.",
        },
      ],
      toolkit,
    );

    expect(result.valid).toBe(true);
    expect(result.citations[0].verified).toBe(true);
  });

  it("改写过的引用被拒绝", () => {
    const toolkit = stubToolkit([buildMem()]);
    const result = verifyCitations(
      [{ memoryId: "mem-1", quote: "项目使用 Milvus 作为主索引（模型改写）" }],
      toolkit,
    );

    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("quote-not-in-memory:mem-1");
  });

  it("memoryId 不存在 / 引用过短 / 空引用分别拒绝", () => {
    const toolkit = stubToolkit([buildMem()]);

    expect(verifyCitations([], toolkit).failureReason).toBe("no-citations");
    expect(
      verifyCitations([{ memoryId: "ghost", quote: "whatever long enough" }], toolkit)
        .failureReason,
    ).toBe("memory-not-found:ghost");
    expect(verifyCitations([{ memoryId: "mem-1", quote: "太短" }], toolkit).failureReason).toBe(
      "quote-too-short:mem-1",
    );
  });
});

describe("AskAgentService.ask", () => {
  beforeEach(() => {
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
    new AskLogService();
    getDatabase().exec("DELETE FROM ask_logs");
  });

  it("带校验通过的引用回答并落库 ask_logs", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([
        { type: "text-delta", text: "项目使用 USearch HNSW ANN 作为向量索引。\n" },
        {
          type: "text-delta",
          text: '<citations>\n[{"memoryId": "mem-1", "quote": "USearch HNSW ANN 索引"}]\n</citations>',
        },
      ]),
    );

    const events: string[] = [];
    const outcome = await buildService([buildMem()]).ask({
      question: "项目用什么向量索引？",
      onEvent: (event) => events.push(event.type),
    });

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") return;
    expect(outcome.citations[0].memoryId).toBe("mem-1");
    expect(outcome.mode).toBe("stream");
    expect(events).toEqual(["token", "token", "citations", "done"]);

    const log = new AskLogService().listRecent(1)[0];
    expect(log.refused).toBe(false);
    expect(log.citations[0].verified).toBe(true);
    expect(log.usage.promptTokens).toBe(100);
    expect(log.model).toBeTruthy();
  });

  it("伪造引用片段时严格拒答并落库 refused", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([
        {
          type: "text-delta",
          text: '项目使用 Milvus。\n<citations>\n[{"memoryId": "mem-1", "quote": "项目使用 Milvus 作为主索引"}]\n</citations>',
        },
      ]),
    );

    const events: string[] = [];
    const outcome = await buildService([buildMem()]).ask({
      question: "项目用什么向量索引？",
      onEvent: (event) => events.push(event.type),
    });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toBe("库内未找到可验证的依据");
    expect(events).toEqual(["token", "refusal", "done"]);

    const log = new AskLogService().listRecent(1)[0];
    expect(log.refused).toBe(true);
    expect(log.citations).toEqual([]);
    expect(log.diagnostics?.failureReason).toBe("quote-not-in-memory:mem-1");
    expect(log.diagnostics?.rawAnswer).toContain("Milvus");
    expect(log.diagnostics?.rawCitations?.[0].memoryId).toBe("mem-1");
  });

  it("零引用（模型明确说没依据）拒答并使用模型描述作为建议", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([
        {
          type: "text-delta",
          text: "库内未找到依据：没有关于部署流程的记录，可尝试导入相关会话。\n<citations>[]</citations>",
        },
      ]),
    );

    const outcome = await buildService([buildMem()]).ask({ question: "怎么部署？" });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.suggestion).toContain("没有关于部署流程的记录");
  });

  it("缺引用区块同样拒答，不把未验证答案当建议", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([{ type: "text-delta", text: "我猜答案是 Foo。" }]),
    );

    const outcome = await buildService([buildMem()]).ask({ question: "X 是什么？" });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.suggestion).toContain("知识库中没有支撑该问题的记录");
  });

  it("流式启动即失败时降级到非流式缓冲循环", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([{ __throw: new Error("stream unsupported") }]),
    );
    aiMocks.generateText.mockResolvedValue(makeTextResult(CITED_ANSWER));

    const outcome = await buildService([buildMem()]).ask({ question: "项目用什么向量索引？" });

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") return;
    expect(outcome.mode).toBe("buffered");
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("流式与缓冲都失败时降级到 JSON 手工循环（action → final）", async () => {
    aiMocks.streamText.mockReturnValue(makeStreamResult([{ __throw: new Error("stream down") }]));
    aiMocks.generateText
      .mockRejectedValueOnce(new Error("tools not supported by endpoint"))
      .mockResolvedValueOnce(
        makeTextResult('{"action": {"tool": "search_memory", "args": {"query": "向量索引"}}}'),
      )
      .mockResolvedValueOnce(makeTextResult(`{"final": ${JSON.stringify(CITED_ANSWER)}}`));

    const events: string[] = [];
    const outcome = await buildService([buildMem()]).ask({
      question: "项目用什么向量索引？",
      onEvent: (event) => events.push(event.type),
    });

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") return;
    expect(outcome.mode).toBe("json-loop");
    expect(aiMocks.generateText).toHaveBeenCalledTimes(3);

    // JSON 循环内工具指令被执行并产生轨迹
    expect(outcome.toolTrace).toHaveLength(1);
    expect(outcome.toolTrace[0].tool).toBe("search_memory");
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
    expect(events).toContain("citations");
  });

  it("所有循环模式都失败时抛错并发 error 事件，不写入 ask_logs", async () => {
    aiMocks.streamText.mockReturnValue(makeStreamResult([{ __throw: new Error("stream down") }]));
    aiMocks.generateText.mockRejectedValue(new Error("endpoint fully down"));

    const events: string[] = [];
    await expect(
      buildService([buildMem()]).ask({
        question: "任意问题",
        onEvent: (event) => events.push(event.type),
      }),
    ).rejects.toThrow("endpoint fully down");

    expect(events).toEqual(["error"]);
    expect(new AskLogService().getStats().totalAsks).toBe(0);
  });

  it("流式失败但已有 token 输出时不降级，直接报错", async () => {
    aiMocks.streamText.mockReturnValue(
      makeStreamResult([
        { type: "text-delta", text: "部分答案" },
        { __throw: new Error("mid-stream failure") },
      ]),
    );

    await expect(buildService([buildMem()]).ask({ question: "任意问题" })).rejects.toThrow(
      "mid-stream failure",
    );
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });
});
