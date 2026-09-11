import { MemoryRecord, PendingEvent } from "../../types/memory";
import { compareMemories, extractChangedFields, DiffResult } from "./differ";
import { resolveConflicts, ConflictResolution } from "./conflict-resolver";
import { VersionManager } from "./version-manager";

export type AuditResult = {
  eventId: string;
  memoryId: string;
  status: "done" | "failed";
  diffs: DiffResult[];
  resolution?: ConflictResolution;
  error?: string;
};

export type MemoryStoreReader = {
  getMemory: (id: string) => MemoryRecord | null;
  dequeueEvent: (memoryId: string) => PendingEvent | null;
  dequeueEventById?: (eventId: string) => PendingEvent | null;
  updateEvent: (event: PendingEvent) => void;
};

export class Auditor {
  private store: MemoryStoreReader;
  private versionManager: VersionManager;

  constructor(store: MemoryStoreReader) {
    this.store = store;
    this.versionManager = new VersionManager();
  }

  async process(memoryId: string, eventId?: string): Promise<AuditResult | null> {
    const event = eventId
      ? (this.store.dequeueEventById?.(eventId) ?? null)
      : this.store.dequeueEvent(memoryId);
    if (!event) return null;

    try {
      const candidate: MemoryRecord = JSON.parse(event.candidate);
      const existing = this.store.getMemory(event.memoryId);

      const result: AuditResult = {
        eventId: event.eventId,
        memoryId: event.memoryId,
        status: "done",
        diffs: [],
      };

      if (!existing) {
        result.status = "done";
        return result;
      }

      const diffs = compareMemories(existing, candidate);
      result.diffs = diffs;

      if (diffs.length === 0) {
        result.status = "done";
        return result;
      }

      // 以入队时声明的变更字段为准，避免 updatedAt/version 等系统字段
      // 被误识别为内容修改；兼容旧事件时才从 diff 推导。
      const changedFields =
        event.changedFields.length > 0 ? event.changedFields : extractChangedFields(diffs);
      const resolution = resolveConflicts(existing, candidate, changedFields);
      result.resolution = resolution;

      if (resolution.action === "auto_merge") {
        result.status = "done";
      } else {
        // reject 路径：schema 不兼容 / 数据损坏 / 格式校验失败
        // 格式错误进入失败重试，不生成待审核记录。
        result.status = "failed";
        result.error = resolution.reason;
      }

      if (resolution.action === "auto_merge" && Object.keys(resolution.merged).length > 0) {
        this.versionManager.createSnapshot(existing, existing.version);
      }

      return result;
    } catch (error) {
      return {
        eventId: event.eventId,
        memoryId: event.memoryId,
        status: "failed",
        diffs: [],
        error: (error as Error).message,
      };
    }
  }

  close(): void {
    this.versionManager.close();
  }
}
