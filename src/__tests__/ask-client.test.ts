import { describe, it, expect, vi, afterEach } from "vitest";
import { askQuestionStream, fetchAskStats } from "../lib/ask-client";
import { AskStreamEvent } from "../types/ask";

function sseResponse(frames: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("askQuestionStream", () => {
  it("按空行分帧解析 data: 事件并保持顺序", async () => {
    const events: AskStreamEvent[] = [];
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"start","askId":"a1"}\n\n',
        'data: {"type":"tool_call","tool":"search_memory","args":{"query":"x"}}\n\ndata: {"type":"token","text":"答案"}\n\n',
        'data: {"type":"citations","citations":[]}\n\n',
        'data: {"type":"done","usage":{"promptTokens":1,"completionTokens":2},"durationMs":10,"askId":"a1","mode":"stream"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await askQuestionStream("问题", { onEvent: (event) => events.push(event) });

    expect(events.map((e) => e.type)).toEqual(["start", "tool_call", "token", "citations", "done"]);
    expect(events[2]).toEqual({ type: "token", text: "答案" });
  });

  it("跨 chunk 的事件帧正确拼接，缺少终态时报告断流", async () => {
    const events: AskStreamEvent[] = [];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"to'));
        controller.enqueue(encoder.encode('ken","text":"分段"}'));
        controller.enqueue(encoder.encode("\n\n"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      askQuestionStream("q", { onEvent: (event) => events.push(event) }),
    ).rejects.toThrow("问答连接提前结束");

    expect(events).toEqual([{ type: "token", text: "分段" }]);
  });

  it("无法解析的帧被跳过，不中断流", async () => {
    const events: AskStreamEvent[] = [];
    fetchMock.mockResolvedValue(
      sseResponse(["data: not-json\n\n", 'data: {"type":"token","text":"ok"}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      askQuestionStream("q", { onEvent: (event) => events.push(event) }),
    ).rejects.toThrow("问答连接提前结束");

    expect(events).toEqual([{ type: "token", text: "ok" }]);
  });

  it("非 2xx 响应抛出服务端错误消息", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "VALIDATION_FAILED", message: "question 必须是 1-500 字符的字符串" },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(askQuestionStream("", { onEvent: () => undefined })).rejects.toThrow(
      "question 必须是 1-500 字符的字符串",
    );
  });
});

describe("fetchAskStats", () => {
  it("读取统一契约中的 stats", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            stats: {
              totalAsks: 3,
              refusedAsks: 1,
              totalPromptTokens: 300,
              totalCompletionTokens: 150,
              lastAskedAt: "2026-09-25T00:00:00.000Z",
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stats = await fetchAskStats();
    expect(stats.totalAsks).toBe(3);
    expect(stats.refusedAsks).toBe(1);
  });

  it("失败响应抛错", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAskStats()).rejects.toThrow("HTTP 500");
  });
});
