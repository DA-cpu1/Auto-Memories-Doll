/**
 * 统一错误类型 —— 替代裸 `new Error()`，支持错误码和上下文。
 *
 * 使用方式：
 *   throw new MemoryNotFoundError("abc123");
 *   throw new AppError("VALIDATION", "title 不能为空");
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

/** 记忆不存在 */
export class MemoryNotFoundError extends AppError {
  constructor(memoryId: string) {
    super("MEMORY_NOT_FOUND", `记忆不存在: ${memoryId}`, { memoryId });
    this.name = "MemoryNotFoundError";
  }
}

/** 记忆数据校验失败 */
export class MemoryValidationError extends AppError {
  constructor(field: string, reason: string) {
    super("MEMORY_INVALID", `记忆校验失败: ${field} - ${reason}`, { field, reason });
    this.name = "MemoryValidationError";
  }
}

/** AI 服务不可用 */
export class AiServiceError extends AppError {
  constructor(reason: string) {
    super("AI_SERVICE_UNAVAILABLE", `AI 服务不可用: ${reason}`, { reason });
    this.name = "AiServiceError";
  }
}

/** 并发锁冲突 */
export class LockError extends AppError {
  constructor() {
    super("LOCK_TIMEOUT", "获取文件锁超时，可能存在并发写冲突");
    this.name = "LockError";
  }
}
