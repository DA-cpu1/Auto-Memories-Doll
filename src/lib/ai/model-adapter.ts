import type { ModelSlot } from "../../types/config";
import { logger } from "../logger";
import type { AiEvent, AiProvider, AiToolDef } from "./ai-events";
import { KnowledgeModelAdapter, getKnowledgeAiConfig } from "./knowledge-model-adapter";
import type { ModelType } from "./knowledge-model";
import { ConcurrencyTimeoutError } from "./model-pool";
import { OpenAIProvider } from "./openai-provider";

export type { EmbeddingResponse, LlmResponse, ModelType } from "./knowledge-model";

function getProvider(): AiProvider {
  return new OpenAIProvider(getKnowledgeAiConfig());
}

/** Chat streaming compatibility facade scheduled for removal in LKA-001 Phase 5. */
export class ModelAdapter extends KnowledgeModelAdapter {
  static generateStream(options: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    temperature?: number;
    tools?: AiToolDef[];
    readonly?: boolean;
    modelType?: ModelType;
  }): ReadableStream<AiEvent> {
    const config = getKnowledgeAiConfig();
    this.rememberApiKeyStatus(config.apiKey);
    const slot: ModelSlot = options.modelType || "standard";

    if (!config.apiKey?.trim()) {
      return this.createFallbackStream(
        "当前处于离线模式，请前往设置页面配置 AI API Key 和 baseURL。",
      );
    }

    return new ReadableStream<AiEvent>({
      start: async (controller) => {
        try {
          const stream = await this.pool.execute(slot, () =>
            Promise.resolve(getProvider().generateStream(options)),
          );
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          this.markLlmDegraded();
          if (error instanceof ConcurrencyTimeoutError) {
            const message = `[${slot}] 模型并发已满 (${error.timeoutMs}ms 超时)，请稍后重试。`;
            controller.enqueue({ type: "text_start" });
            controller.enqueue({ type: "text_delta", content: message });
            controller.enqueue({ type: "text_end" });
            controller.enqueue({ type: "done", finishReason: "error" });
          } else {
            logger.api.error("聊天流生成失败", { error: (error as Error).message });
            controller.enqueue({ type: "error", message: (error as Error).message });
          }
          controller.close();
        }
      },
    });
  }

  private static createFallbackStream(message: string): ReadableStream<AiEvent> {
    return new ReadableStream<AiEvent>({
      start(controller) {
        controller.enqueue({ type: "text_start" });
        controller.enqueue({ type: "text_delta", content: message });
        controller.enqueue({ type: "text_end" });
        controller.enqueue({ type: "done", finishReason: "error" });
        controller.close();
      },
    });
  }
}
