import { describe, it, expect, beforeEach } from "vitest";
import { AskLogService } from "../server/services/ask-log-service";
import { getDatabase } from "../lib/storage/database";
import { AskLogRecord } from "../types/ask";

function buildRecord(
  overrides: Partial<AskLogRecord> = {},
): Omit<AskLogRecord, "askId" | "createdAt"> {
  return {
    question: "项目用了什么向量索引？",
    answer: "项目使用 USearch HNSW ANN 索引。",
    refused: false,
    citations: [{ memoryId: "mem-1", quote: "USearch HNSW ANN 索引", verified: true }],
    toolTrace: [
      {
        tool: "search_memory",
        args: { query: "向量索引" },
        resultSummary: "3 条命中",
        durationMs: 42,
      },
    ],
    usage: { promptTokens: 120, completionTokens: 80 },
    model: "test-model",
    mode: "stream",
    durationMs: 1500,
    diagnostics: { failureReason: "no-citations", rawAnswer: "原始答案片段" },
    ...overrides,
  };
}

describe("AskLogService", () => {
  beforeEach(() => {
    // 同文件用例共享 getDatabase() 单例连接，先确保建表再清空数据
    new AskLogService();
    getDatabase().exec("DELETE FROM ask_logs");
  });

  it("首次实例化建表，空库统计返回默认值", () => {
    const service = new AskLogService();

    expect(service.getStats()).toEqual({
      totalAsks: 0,
      refusedAsks: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastAskedAt: null,
    });
    expect(service.listRecent()).toEqual([]);
  });

  it("记录一次问答并完整读回（citations/toolTrace JSON 往返）", () => {
    const service = new AskLogService();

    const record = service.recordAsk(buildRecord());

    expect(record.askId).toBeTruthy();
    expect(record.createdAt).toBeTruthy();

    const recent = service.listRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual(record);
  });

  it("统计累计提问数、拒答数与 token 消耗", () => {
    const service = new AskLogService();

    service.recordAsk(buildRecord({ refused: false }));
    service.recordAsk(
      buildRecord({ refused: true, usage: { promptTokens: 30, completionTokens: 10 } }),
    );

    const stats = service.getStats();
    expect(stats.totalAsks).toBe(2);
    expect(stats.refusedAsks).toBe(1);
    expect(stats.totalPromptTokens).toBe(150);
    expect(stats.totalCompletionTokens).toBe(90);
    expect(stats.lastAskedAt).toBeTruthy();
  });

  it("listRecent 按创建时间倒序并尊重 limit", () => {
    const service = new AskLogService();

    const first = service.recordAsk(buildRecord({ question: "第一问" }));
    const second = service.recordAsk(buildRecord({ question: "第二问" }));

    const recent = service.listRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].question).toBe("第二问");

    const all = service.listRecent(10);
    expect(all.map((r) => r.question)).toEqual(["第二问", "第一问"]);
    expect(all[0].createdAt >= all[1].createdAt).toBe(true);
    expect(second.createdAt >= first.createdAt).toBe(true);
  });

  it("损坏的 JSON 列读回时降级为空数组而非抛错", () => {
    const service = new AskLogService();
    service.recordAsk(buildRecord());

    // 直接写坏数据模拟历史损坏
    const db = (service as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("UPDATE ask_logs SET citations = '{bad json', toolTrace = 'not-json'");

    const record = service.listRecent(1)[0];
    expect(record.citations).toEqual([]);
    expect(record.toolTrace).toEqual([]);
  });
});
