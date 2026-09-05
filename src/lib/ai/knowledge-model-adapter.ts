import { embed, generateText } from "ai";
import { apiConfig } from "../../config/api.config";
import type { AiConfig, ModelSlot } from "../../types/config";
import { KnowledgeConfigService } from "../../server/services/knowledge-config-service";
import { logger } from "../logger";
import { getCurrentTime } from "../utils/date";
import { createEmbeddingModel, createLanguageModel } from "./provider";
import { ConcurrencyTimeoutError, ModelPool } from "./model-pool";
import { redactSecrets } from "../security/secret-redactor";
import type {
  DegradedCapability,
  EmbeddingResponse,
  KnowledgeModel,
  LlmResponse,
  ModelType,
} from "./knowledge-model";

export function getKnowledgeAiConfig(): AiConfig {
  const service = new KnowledgeConfigService();
  try {
    return service.getAiConfig() || service.getDefaultAiConfig();
  } finally {
    service.close();
  }
}

/** Non-streaming AI boundary for extraction, evaluation, rewriting, and embeddings. */
export class KnowledgeModelAdapter {
  protected static llmDegraded = false;
  protected static embeddingDegraded = false;
  protected static healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  protected static apiKeyConfiguredCache: boolean | null = (() => {
    try {
      return Boolean(getKnowledgeAiConfig().apiKey?.trim());
    } catch {
      return null;
    }
  })();
  protected static pool = new ModelPool(apiConfig.concurrency);

  static get isDegradedMode(): boolean {
    return this.llmDegraded || this.embeddingDegraded || !this.hasConfiguredApiKey();
  }

  static getDegradedCapabilities(): DegradedCapability[] {
    const config = getKnowledgeAiConfig();
    const degraded: DegradedCapability[] = [];
    if (this.llmDegraded || !config.apiKey?.trim()) degraded.push("llm");
    if (this.embeddingDegraded || !(config.embedding.apiKey || config.apiKey)?.trim()) {
      degraded.push("embedding");
    }
    return degraded;
  }

  static getPoolStats() {
    return this.pool.getStats();
  }

  static startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      const config = getKnowledgeAiConfig();
      const embeddingApiKey = config.embedding.apiKey || config.apiKey;
      if (!embeddingApiKey) return;

      try {
        await embed({ model: createEmbeddingModel(), value: "health-check" });
        this.embeddingDegraded = false;
        await generateText({
          model: createLanguageModel("budget"),
          messages: [{ role: "user", content: "health-check" }],
        });
        const wasDegraded = this.llmDegraded;
        this.llmDegraded = false;
        if (wasDegraded) logger.api.info("AI API 已恢复，退出降级模式");
      } catch {
        // Keep the last known degraded state until both probes succeed.
      }
    }, apiConfig.degradation.checkInterval);
  }

  static stopHealthCheck(): void {
    if (!this.healthCheckTimer) return;
    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
  }

  static async generate(prompt: string, modelType: ModelType): Promise<LlmResponse> {
    const config = getKnowledgeAiConfig();
    const slot: ModelSlot = modelType;
    const tier = config[slot] || config.standard;
    if (!this.rememberApiKeyStatus(config.apiKey)) {
      this.llmDegraded = true;
      return {
        content: this.getFallbackResponse(),
        finishReason: "degraded",
        model: tier.model,
        timestamp: getCurrentTime(),
      };
    }

    const safePrompt = redactSecrets(prompt).content;
    try {
      const result = await this.pool.execute(slot, () =>
        generateText({
          model: createLanguageModel(modelType),
          messages: [{ role: "user", content: safePrompt }],
        }),
      );
      this.llmDegraded = false;
      return {
        content: result.text,
        finishReason: result.finishReason || "unknown",
        model: tier.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.llmDegraded = true;
      if (error instanceof ConcurrencyTimeoutError) {
        logger.api.warn(`[generate] ${slot} 并发超时`, { timeoutMs: error.timeoutMs });
      } else {
        logger.api.error("LLM API 调用失败", { error: (error as Error).message });
      }
      return {
        content: this.getFallbackResponse(),
        finishReason: "degraded",
        model: tier.model,
        timestamp: getCurrentTime(),
      };
    }
  }

  static async generateEmbedding(text: string): Promise<EmbeddingResponse> {
    const config = getKnowledgeAiConfig();
    this.rememberApiKeyStatus(config.apiKey);
    const embeddingApiKey = config.embedding.apiKey || config.apiKey;

    if (!embeddingApiKey?.trim()) {
      logger.vector.warn("未配置 Embedding API Key，跳过向量生成");
      return {
        embedding: [],
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    }

    const safeText = redactSecrets(text).content;
    try {
      const result = await this.pool.execute("embedding", () =>
        embed({ model: createEmbeddingModel(), value: safeText }),
      );
      this.embeddingDegraded = false;
      return {
        embedding: result.embedding,
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.embeddingDegraded = true;
      if (error instanceof ConcurrencyTimeoutError) {
        logger.vector.warn("[generateEmbedding] 并发超时");
      } else {
        logger.vector.error("Embedding API 调用失败", { error: (error as Error).message });
      }
      return {
        embedding: [],
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    }
  }

  protected static markLlmDegraded(): void {
    this.llmDegraded = true;
  }

  protected static rememberApiKeyStatus(apiKey: string | undefined): boolean {
    const value = Boolean(apiKey?.trim());
    this.apiKeyConfiguredCache = value;
    return value;
  }

  private static hasConfiguredApiKey(): boolean {
    if (this.apiKeyConfiguredCache !== null) return this.apiKeyConfiguredCache;
    return this.rememberApiKeyStatus(getKnowledgeAiConfig().apiKey);
  }

  private static getFallbackResponse(): string {
    return "当前处于离线模式，无法执行 AI 知识加工。请检查 AI 和 Embedding 配置。";
  }
}

/** Typed singleton-style boundary for callers that prefer dependency injection over static access. */
export const knowledgeModel: KnowledgeModel = KnowledgeModelAdapter;
