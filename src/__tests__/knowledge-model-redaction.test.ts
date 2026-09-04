import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  embed: vi.fn(),
}));
vi.mock("../lib/ai/provider", () => ({
  createLanguageModel: vi.fn(() => ({ modelId: "test" })),
  createEmbeddingModel: vi.fn(() => ({ modelId: "test-embedding" })),
}));

import { KnowledgeModelAdapter } from "../lib/ai/knowledge-model-adapter";

describe("KnowledgeModelAdapter secret boundary", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValue({ text: "ok", finishReason: "stop" });
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
});
