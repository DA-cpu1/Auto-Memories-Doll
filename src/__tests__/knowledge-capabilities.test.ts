import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
const api = vi.hoisted(() => ({ generateText: vi.fn(), embed: vi.fn() }));
vi.mock("ai", () => api);
vi.mock("../lib/ai/provider", () => ({
  createLanguageModel: (slot: string) => ({ slot }),
  createEmbeddingModel: () => ({ slot: "embedding" }),
}));
import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";
import { KnowledgeConfigService } from "../server/services/knowledge-config-service";
import { closeDatabase } from "../lib/storage/database";
import { invalidatePathCache } from "../lib/storage/path-resolver";
import { GET as getHealth } from "../app/api/health/route";
import { healthResponseSchema } from "../config/api-route-contracts";

describe.sequential("KA-003 independent capabilities", () => {
  beforeEach(() => {
    closeDatabase();
    invalidatePathCache();
    rmSync(process.env.MEMORY_ROOT!, { recursive: true, force: true });
    mkdirSync(process.env.MEMORY_ROOT!, { recursive: true });
    for (const slot of ["budget", "standard", "flagship", "embedding"] as const)
      KnowledgeModelAdapter.resetCapability(slot);
    const service = new KnowledgeConfigService();
    const config = service.getDefaultAiConfig();
    service.setAiConfig({
      ...config,
      apiKey: "test-only",
      embedding: { ...config.embedding, dimensions: 3 },
    });
    api.generateText.mockReset().mockResolvedValue({ text: "valid", finishReason: "stop" });
    api.embed.mockReset().mockResolvedValue({ embedding: [1, 0, 0] });
  });
  afterEach(() => {
    KnowledgeModelAdapter.stopHealthCheck();
    vi.useRealTimers();
    closeDatabase();
  });

  it("persists disabled embedding with a shared key and never probes it", async () => {
    const service = new KnowledgeConfigService();
    const config = service.getAiConfig()!;
    service.setAiConfig({ ...config, embedding: { ...config.embedding, enabled: false } });
    closeDatabase();
    invalidatePathCache();
    await KnowledgeModelAdapter.generateEmbedding("private content");
    await KnowledgeModelAdapter.generate("quality", "flagship");
    expect(api.embed).not.toHaveBeenCalled();
    expect(api.generateText).toHaveBeenCalledOnce();
    expect(KnowledgeModelAdapter.dependencyReason("embedding")).toBe("DISABLED");
  });

  it("backs off embedding failures without blocking LLM calls", async () => {
    api.embed.mockRejectedValue(new Error("network"));
    await KnowledgeModelAdapter.generateEmbedding("first");
    await KnowledgeModelAdapter.generateEmbedding("second");
    await KnowledgeModelAdapter.generate("quality", "flagship");
    expect(api.embed).toHaveBeenCalledOnce();
    expect(api.generateText).toHaveBeenCalledOnce();
  });

  it("passes the configured output budget to the SDK", async () => {
    await KnowledgeModelAdapter.generate("synthetic", "flagship");
    const tier = new KnowledgeConfigService().getAiConfig()!.flagship;
    expect(api.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: tier.maxTokens, temperature: tier.temperature }),
    );
  });

  it.each([
    { error: { name: "TimeoutError" }, reason: "TIMEOUT" },
    { error: { cause: { code: "ETIMEDOUT" } }, reason: "TIMEOUT" },
    { error: { statusCode: 429 }, reason: "RATE_LIMITED" },
    { error: { statusCode: 401 }, reason: "AUTH_FAILED" },
  ])("records $reason without using provider response bodies", async ({ error, reason }) => {
    api.generateText.mockRejectedValueOnce(error);
    await KnowledgeModelAdapter.generate("synthetic", "flagship");
    expect(KnowledgeModelAdapter.dependencyReason("flagship")).toBe(reason);
  });

  it("does not clear a flagship failure after budget success", async () => {
    api.generateText.mockRejectedValueOnce({ statusCode: 401 });
    await KnowledgeModelAdapter.generate("quality", "flagship");
    await KnowledgeModelAdapter.generate("probe", "budget");
    expect(KnowledgeModelAdapter.dependencyReason("flagship")).toBe("AUTH_FAILED");
    expect(KnowledgeModelAdapter.dependencyReason("budget")).toBeUndefined();
    await KnowledgeModelAdapter.generateEmbedding("query");
    expect(api.embed).toHaveBeenCalledOnce();
  });

  it.each([[], [0, 0, 0], [1, 2], [NaN, 1, 0]].map((embedding) => ({ embedding })))(
    "rejects invalid embedding %j",
    async ({ embedding }) => {
      api.embed.mockResolvedValue({ embedding });
      expect((await KnowledgeModelAdapter.generateEmbedding("query")).embedding).toEqual([]);
      expect(KnowledgeModelAdapter.dependencyReason("embedding")).toBe("REQUEST_FAILED");
    },
  );

  it("configuration changes release only the changed slot", async () => {
    api.generateText.mockRejectedValueOnce({ statusCode: 401 });
    await KnowledgeModelAdapter.generate("quality", "flagship");
    const service = new KnowledgeConfigService();
    const config = service.getAiConfig()!;
    service.setAiConfig({ ...config, budget: { ...config.budget, model: "new-budget" } });
    expect(KnowledgeModelAdapter.dependencyReason("flagship")).toBe("AUTH_FAILED");
    service.setAiConfig({ ...config, flagship: { ...config.flagship, model: "new-flagship" } });
    expect(KnowledgeModelAdapter.dependencyReason("flagship")).toBeUndefined();
  });

  it("does not send periodic probes to healthy models", async () => {
    await KnowledgeModelAdapter.checkHealth();
    expect(api.generateText).not.toHaveBeenCalled();
    expect(api.embed).not.toHaveBeenCalled();
  });

  it("reports a timed-out slot until a bounded recovery probe succeeds", async () => {
    vi.useFakeTimers();
    api.generateText.mockRejectedValueOnce({ name: "TimeoutError" });
    await KnowledgeModelAdapter.generate("synthetic", "flagship");
    const failed = await (await getHealth()).json();
    expect(healthResponseSchema.safeParse(failed).success).toBe(true);
    expect(failed.failures).toEqual([
      expect.objectContaining({
        slot: "flagship",
        reason: "TIMEOUT",
        purpose: "processing",
        durationMs: 0,
      }),
    ]);
    expect(JSON.stringify(failed)).not.toContain("test-only");
    await KnowledgeModelAdapter.checkHealth();
    expect(api.generateText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60001);
    expect(KnowledgeModelAdapter.getDegradedCapabilities()).toEqual(["llm"]);
    await KnowledgeModelAdapter.checkHealth();
    expect(api.generateText).toHaveBeenCalledTimes(2);
    expect(api.generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxOutputTokens: 128,
        maxRetries: 0,
        temperature: 0,
      }),
    );
    expect(api.embed).not.toHaveBeenCalled();
    expect((await (await getHealth()).json()).failures).toEqual([]);
    expect(KnowledgeModelAdapter.isDegradedMode).toBe(false);
  });

  it("labels failed recovery probes separately from processing failures", async () => {
    vi.useFakeTimers();
    api.generateText.mockRejectedValue({ name: "TimeoutError" });
    await KnowledgeModelAdapter.generate("synthetic", "standard");
    await vi.advanceTimersByTimeAsync(60001);
    await KnowledgeModelAdapter.checkHealth();
    expect(KnowledgeModelAdapter.getFailures()).toEqual([
      expect.objectContaining({
        slot: "standard",
        purpose: "health-check",
        reason: "TIMEOUT",
      }),
    ]);
  });

  it("does not let an old in-flight failure mark new configuration unhealthy", async () => {
    let rejectRequest!: (error: unknown) => void;
    api.generateText.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const request = KnowledgeModelAdapter.generate("synthetic", "flagship");
    await vi.waitFor(() => expect(api.generateText).toHaveBeenCalledOnce());
    const service = new KnowledgeConfigService();
    const config = service.getAiConfig()!;
    service.setAiConfig({ ...config, flagship: { ...config.flagship, model: "replacement" } });
    rejectRequest({ name: "TimeoutError" });
    await request;
    expect(KnowledgeModelAdapter.getFailures()).toEqual([]);
    expect(KnowledgeModelAdapter.isDegradedMode).toBe(false);
  });
});
