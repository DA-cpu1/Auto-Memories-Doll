import { embed, generateText } from "ai";
import { apiConfig } from "../../config/api.config";
import type { AiConfig, ModelSlot } from "../../types/config";
import { KnowledgeConfigService } from "../../server/services/knowledge-config-service";
import { logger } from "../logger";
import { getCurrentTime } from "../utils/date";
import { createEmbeddingModel, createLanguageModel } from "./provider";
import { ConcurrencyTimeoutError, ModelPool } from "./model-pool";
import { redactSecrets } from "../security/secret-redactor";
import { createHash } from "crypto";
import { dependencyConfig } from "../../config/dependency.config";
import { ModelDependencyError, type DependencyReason } from "./dependency-error";
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
  private static failures = new Map<
    ModelSlot,
    { fingerprint: string; reason: DependencyReason; retryAt: number }
  >();
  private static checkingHealth = false;

  static configurationFingerprint(slot: ModelSlot): string {
    const config = getKnowledgeAiConfig();
    return createHash("sha256")
      .update(JSON.stringify([config.provider, config.baseURL, config.apiKey, config[slot]]))
      .digest("hex");
  }

  static resetCapability(slot: ModelSlot): void {
    this.failures.delete(slot);
  }

  static suppressInvalidOutput(slot: ModelSlot): void {
    this.failures.set(slot, {
      fingerprint: this.configurationFingerprint(slot),
      reason: "INVALID_OUTPUT",
      retryAt: Date.now() + dependencyConfig.capabilityBackoffMs,
    });
  }

  static dependencyReason(slot: ModelSlot): DependencyReason | undefined {
    const config = getKnowledgeAiConfig();
    if (slot === "embedding" && config.embedding.enabled === false) return "DISABLED";
    const key = slot === "embedding" ? config.embedding.apiKey || config.apiKey : config.apiKey;
    if (!key?.trim() || !config[slot].model?.trim()) return "NOT_CONFIGURED";
    const failure = this.failures.get(slot);
    if (
      failure &&
      failure.fingerprint === this.configurationFingerprint(slot) &&
      failure.retryAt > Date.now()
    )
      return failure.reason;
    return undefined;
  }

  private static recordFailure(slot: ModelSlot, error: unknown): void {
    const status = (error as { statusCode?: number })?.statusCode;
    const reason = status === 401 || status === 403 ? "AUTH_FAILED" : "REQUEST_FAILED";
    this.failures.set(slot, {
      fingerprint: this.configurationFingerprint(slot),
      reason,
      retryAt:
        reason === "AUTH_FAILED" ? Infinity : Date.now() + dependencyConfig.capabilityBackoffMs,
    });
  }
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
    if (
      !config.apiKey?.trim() ||
      (["budget", "standard", "flagship"] as const).some(
        (slot) =>
          this.dependencyReason(slot) ||
          this.failures.get(slot)?.fingerprint === this.configurationFingerprint(slot),
      )
    )
      degraded.push("llm");
    if (this.embeddingDegraded || this.dependencyReason("embedding")) {
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
      if (this.checkingHealth) return;
      this.checkingHealth = true;
      try {
        await Promise.allSettled([
          this.generateEmbedding("health-check"),
          ...(["budget", "standard", "flagship"] as const).map((slot) =>
            this.generate("health-check", slot),
          ),
        ]);
      } finally {
        this.checkingHealth = false;
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
    const dependency = this.dependencyReason(slot);
    if (dependency) throw new ModelDependencyError(slot, "generate", dependency);
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
          maxOutputTokens: tier.maxTokens,
          temperature: tier.temperature,
          abortSignal: AbortSignal.timeout(tier.timeout || 30_000),
          maxRetries: tier.maxRetries ?? 0,
        }),
      );
      this.llmDegraded = false;
      this.failures.delete(slot);
      return {
        content: result.text,
        finishReason: result.finishReason || "unknown",
        model: tier.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.recordFailure(slot, error);
      this.llmDegraded = true;
      if (error instanceof ConcurrencyTimeoutError) {
        logger.api.warn(`[generate] ${slot} 并发超时`, { timeoutMs: error.timeoutMs });
      } else {
        logger.api.error("LLM API 调用失败", { slot });
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

    if (this.dependencyReason("embedding") || !embeddingApiKey?.trim()) {
      return {
        embedding: [],
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    }

    const safeText = redactSecrets(text).content;
    try {
      const result = await this.pool.execute("embedding", () =>
        embed({
          model: createEmbeddingModel(),
          value: safeText,
          abortSignal: AbortSignal.timeout(30_000),
          maxRetries: 0,
        }),
      );
      if (
        result.embedding.length !== config.embedding.dimensions ||
        !result.embedding.every(Number.isFinite) ||
        result.embedding.every((value) => value === 0)
      )
        throw new Error("Invalid embedding");
      this.embeddingDegraded = false;
      this.failures.delete("embedding");
      return {
        embedding: result.embedding,
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.recordFailure("embedding", error);
      this.embeddingDegraded = true;
      if (error instanceof ConcurrencyTimeoutError) {
        logger.vector.warn("[generateEmbedding] 并发超时");
      } else {
        logger.vector.error("Embedding API 调用失败");
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
