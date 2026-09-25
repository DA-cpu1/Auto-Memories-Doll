import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "../app/api/ask/route";
import { AskStreamEvent } from "../types/ask";

// ── mock: AskAgentService（不走真实模型循环） ──
const askMock = vi.hoisted(() => vi.fn());
const getStatsMock = vi.hoisted(() => vi.fn());

vi.mock("../server/services/ask-agent-service", () => ({
  AskAgentService: vi.fn().mockImplementation(() => ({
    ask: askMock,
    getStats: getStatsMock,
    listRecent: vi.fn(() => []),
  })),
}));

function request(body: unknown, validJson = true): Request {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: validJson ? JSON.stringify(body) : "not-json",
  });
}

async function readSseEvents(response: Response): Promise<AskStreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as AskStreamEvent);
}

describe("POST /api/ask", () => {
  beforeEach(() => {
    askMock.mockReset();
    getStatsMock.mockReset();
  });

  it("返回 text/event-stream 并按序输出事件帧", async () => {
    askMock.mockImplementation(async ({ onEvent }: { onEvent: (e: AskStreamEvent) => void }) => {
      onEvent({ type: "token", text: "答案" });
      onEvent({
        type: "citations",
        citations: [{ memoryId: "mem-1", quote: "原文", verified: true }],
      });
      onEvent({
        type: "done",
        usage: { promptTokens: 10, completionTokens: 5 },
        durationMs: 120,
        askId: "x",
        mode: "stream",
      });
    });

    const response = await POST(request({ question: "问题" }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSseEvents(response);
    expect(events.map((e) => e.type)).toEqual(["start", "token", "citations", "done"]);
    expect(events[0].type === "start" && events[0].askId).toBeTruthy();
  });

  it("服务抛错且未发 error 事件时补发 error 帧", async () => {
    askMock.mockRejectedValue(new Error("模型服务不可用"));

    const response = await POST(request({ question: "问题" }) as never);
    const events = await readSseEvents(response);

    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    if (events[1].type === "error") {
      expect(events[1].message).toContain("模型服务不可用");
    }
  });

  it("服务已发 error 事件时不重复补发", async () => {
    askMock.mockImplementation(async ({ onEvent }: { onEvent: (e: AskStreamEvent) => void }) => {
      onEvent({ type: "error", code: "ASK_LOOP_FAILED", message: "首轮失败" });
    });
    askMock.mockRejectedValue(new Error("首轮失败"));

    const response = await POST(request({ question: "问题" }) as never);
    const events = await readSseEvents(response);

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("非法 JSON 请求体返回 400 INVALID_JSON", async () => {
    const response = await POST(request({}, false) as never);
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("INVALID_JSON");
  });

  it("空问题 / 超长问题返回 400 VALIDATION_FAILED", async () => {
    const empty = await POST(request({ question: "   " }) as never);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );

    const tooLong = await POST(request({ question: "x".repeat(501) }) as never);
    expect(tooLong.status).toBe(400);
  });
});

describe("GET /api/ask", () => {
  beforeEach(() => {
    getStatsMock.mockReset();
  });

  it("返回统一契约的累计统计", async () => {
    getStatsMock.mockReturnValue({
      totalAsks: 4,
      refusedAsks: 1,
      totalPromptTokens: 400,
      totalCompletionTokens: 200,
      lastAskedAt: "2026-09-25T00:00:00.000Z",
    });

    const response = await GET();
    const payload = (await response.json()) as {
      success: boolean;
      data: { stats: { totalAsks: number; refusedAsks: number } };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.stats.totalAsks).toBe(4);
    expect(payload.data.stats.refusedAsks).toBe(1);
  });
});
