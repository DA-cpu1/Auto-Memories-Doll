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
import type { ModelFailure } from "../../types/model-health";
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
    {
      fingerprint: string;
      reason: DependencyReason;
      retryAt: number;
      failedAt: string;
      durationMs?: number;
      purpose?: "processing" | "health-check";
    }
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
      failedAt: new Date().toISOString(),
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

  private static recordFailure(
    slot: ModelSlot,
    error: unknown,
    context: { durationMs: number; purpose: "processing" | "health-check" },
    fingerprint: string,
  ): void {
    // An old in-flight request must not mark a newly saved configuration unhealthy.
    if (fingerprint !== this.configurationFingerprint(slot)) return;
    const status = (error as { statusCode?: number })?.statusCode;
    const name = (error as { name?: string })?.name;
    const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
    const reason: DependencyReason =
      status === 401 || status === 403
        ? "AUTH_FAILED"
        : status === 429
          ? "RATE_LIMITED"
          : name === "TimeoutError" ||
              name === "AbortError" ||
              error instanceof ConcurrencyTimeoutError ||
              causeCode === "ETIMEDOUT" ||
              causeCode === "UND_ERR_CONNECT_TIMEOUT"
            ? "TIMEOUT"
            : "REQUEST_FAILED";
    // Log only structural diagnostics; provider error bodies may contain keys or source text.
    logger.api.warn("模型调用故障", {
      slot,
      reason,
      statusCode: status,
      errorName: name,
      causeCode,
      ...context,
    });
    this.failures.set(slot, {
      fingerprint,
      reason,
      failedAt: new Date().toISOString(),
      ...context,
      retryAt:
        reason === "AUTH_FAILED" ? Infinity : Date.now() + dependencyConfig.capabilityBackoffMs,
    });
  }
  protected static healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  protected static pool = new ModelPool(apiConfig.concurrency);

  static get isDegradedMode(): boolean {
    return this.getDegradedCapabilities().length > 0;
  }

  static getDegradedCapabilities(): DegradedCapability[] {
    return [
      ...new Set(
        this.getFailures().map((failure): DegradedCapability =>
          failure.slot === "embedding" ? "embedding" : "llm",
        ),
      ),
    ];
  }

  static getFailures(): ModelFailure[] {
    const config = getKnowledgeAiConfig();
    return (["budget", "standard", "flagship", "embedding"] as const).flatMap((slot) => {
      const recorded = this.failures.get(slot);
      const failure =
        recorded?.fingerprint === this.configurationFingerprint(slot) ? recorded : undefined;
      const reason = this.dependencyReason(slot) ?? failure?.reason;
      if (!reason) return [];
      return [
        {
          slot,
          model: config[slot].model,
          reason,
          failedAt: failure?.failedAt,
          retryAt:
            failure && Number.isFinite(failure.retryAt)
              ? new Date(failure.retryAt).toISOString()
              : undefined,
          durationMs: failure?.durationMs,
          purpose: failure?.purpose,
        },
      ];
    });
  }

  static getPoolStats() {
    return this.pool.getStats();
  }

  static startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      void this.checkHealth();
    }, apiConfig.degradation.checkInterval);
  }

  /** Recover failed capabilities only; healthy services need no recurring paid requests. */
  static async checkHealth(): Promise<void> {
    if (this.checkingHealth) return;
    this.checkingHealth = true;
    try {
      for (const slot of ["embedding", "budget", "standard", "flagship"] as const) {
        const failure = this.failures.get(slot);
        if (!failure || failure.fingerprint !== this.configurationFingerprint(slot)) continue;
        if (this.dependencyReason(slot)) continue;
        // Recovery probes must not queue behind or compete with real work in this slot.
        const stats = this.pool.getStats()[slot];
        if (stats.activeCount || stats.waitingCount) continue;
        try {
          if (slot === "embedding") await this.generateEmbedding("health-check", "health-check");
          else await this.generate("Reply with only the word OK.", slot, true);
        } catch {
          // Configuration may change between the eligibility check and the request.
        }
      }
    } finally {
      this.checkingHealth = false;
    }
  }

  static stopHealthCheck(): void {
    if (!this.healthCheckTimer) return;
    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
  }

  static async generate(
    prompt: string,
    modelType: ModelType,
    healthCheck = false,
  ): Promise<LlmResponse> {
    const config = getKnowledgeAiConfig();
    const slot: ModelSlot = modelType;
    const tier = config[slot] || config.standard;
    const dependency = this.dependencyReason(slot);
    if (dependency) throw new ModelDependencyError(slot, "generate", dependency);

    const safePrompt = redactSecrets(prompt).content;
    const fingerprint = this.configurationFingerprint(slot);
    const startedAt = Date.now();
    try {
      const result = await this.pool.execute(slot, () =>
        generateText({
          model: createLanguageModel(modelType),
          messages: [{ role: "user", content: safePrompt }],
          maxOutputTokens: healthCheck ? Math.min(tier.maxTokens, 128) : tier.maxTokens,
          temperature: healthCheck ? 0 : tier.temperature,
          abortSignal: AbortSignal.timeout(tier.timeout || 30_000),
          maxRetries: healthCheck ? 0 : (tier.maxRetries ?? 0),
        }),
      );
      if (fingerprint === this.configurationFingerprint(slot)) this.failures.delete(slot);
      return {
        content: result.text,
        finishReason: result.finishReason || "unknown",
        model: tier.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.recordFailure(
        slot,
        error,
        {
          durationMs: Date.now() - startedAt,
          purpose: healthCheck ? "health-check" : "processing",
        },
        fingerprint,
      );
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

  static async generateEmbedding(
    text: string,
    purpose: "processing" | "health-check" = "processing",
  ): Promise<EmbeddingResponse> {
    const config = getKnowledgeAiConfig();
    const embeddingApiKey = config.embedding.apiKey || config.apiKey;

    if (this.dependencyReason("embedding") || !embeddingApiKey?.trim()) {
      return {
        embedding: [],
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    }

    const safeText = redactSecrets(text).content;
    const fingerprint = this.configurationFingerprint("embedding");
    const startedAt = Date.now();
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
      if (fingerprint === this.configurationFingerprint("embedding"))
        this.failures.delete("embedding");
      return {
        embedding: result.embedding,
        model: config.embedding.model,
        timestamp: getCurrentTime(),
      };
    } catch (error) {
      this.recordFailure(
        "embedding",
        error,
        {
          durationMs: Date.now() - startedAt,
          purpose,
        },
        fingerprint,
      );
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

  private static getFallbackResponse(): string {
    return "当前处于离线模式，无法执行 AI 知识加工。请检查 AI 和 Embedding 配置。";
  }
}

/** Typed singleton-style boundary for callers that prefer dependency injection over static access. */
export const knowledgeModel: KnowledgeModel = KnowledgeModelAdapter;
