import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  config: {
    apiKey: "configured-test-key",
    budget: { model: "test-budget" },
    standard: { model: "test-standard" },
  },
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  embed: vi.fn(),
}));
vi.mock("../lib/ai/provider", () => ({
  createLanguageModel: vi.fn(() => ({ modelId: "test" })),
  createEmbeddingModel: vi.fn(() => ({ modelId: "test-embedding" })),
}));
vi.mock("../server/services/knowledge-config-service", () => ({
  KnowledgeConfigService: vi.fn(() => ({
    getAiConfig: () => mocks.config,
    getDefaultAiConfig: () => mocks.config,
    close: vi.fn(),
  })),
}));

import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";

describe("KnowledgeModelAdapter secret boundary", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValue({ text: "ok", finishReason: "stop" });
    mocks.config.apiKey = "configured-test-key";
  });

  it("redacts secrets immediately before an LLM request", async () => {
    await KnowledgeModelAdapter.generate(
      "Inspect Authorization: Bearer top-secret-token-123 and api_key=sk-proj-abcdefghijklmnop",
      "budget",
    );

    const request = mocks.generateText.mock.calls[0][0];
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("top-secret-token-123");
    expect(prompt).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("fails closed without making a network request when no LLM key is configured", async () => {
    mocks.config.apiKey = "";

    const response = await KnowledgeModelAdapter.generate("offline prompt", "budget");

    expect(response.finishReason).toBe("degraded");
    expect(response.content).toContain("离线模式");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
