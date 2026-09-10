import type { ModelSlot } from "./config";
import type { DependencyReason } from "../lib/ai/dependency-error";

export type ModelFailure = {
  slot: ModelSlot;
  model: string;
  reason: DependencyReason;
  failedAt?: string;
  retryAt?: string;
  durationMs?: number;
  purpose?: "processing" | "health-check";
};

export type ModelHealth = {
  degraded: boolean;
  degradedCapabilities: Array<"llm" | "embedding">;
  failures: ModelFailure[];
  timestamp: number;
};
