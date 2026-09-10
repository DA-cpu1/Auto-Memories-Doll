import type { ModelSlot } from "../../types/config";

export type DependencyReason =
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "AUTH_FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "REQUEST_FAILED"
  | "INVALID_OUTPUT"
  | "OUTPUT_TRUNCATED";

export class ModelDependencyError extends Error {
  constructor(
    readonly slot: ModelSlot,
    readonly stage: string,
    readonly reason: DependencyReason,
  ) {
    super(`模型服务等待: ${slot}/${stage}/${reason}`);
    this.name = "ModelDependencyError";
  }
}
