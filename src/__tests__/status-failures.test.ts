import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeDatabase } from "../lib/storage/database";
import { invalidatePathCache } from "../lib/storage/path-resolver";
import { MemoryService } from "../server/services/memory-service";
import type { PendingEvent } from "../types/memory";

const root = process.env.MEMORY_ROOT!;

function failedEvent(eventId: string, retryCount: number): PendingEvent {
  return {
    eventId,
    memoryId: `memory-${eventId}`,
    sourceId: `source-${eventId}`,
    sourceType: "manual",
    candidate: "private candidate content",
    changedFields: [],
    createdAt: `2026-01-${eventId.slice(-2)}T00:00:00.000Z`,
    status: "failed",
    retryCount,
    decisionReasonCode: "PROCESSING_FAILED",
    decisionReason: `错误 ${eventId}`,
  };
}

describe.sequential("status failure tasks", () => {
  beforeEach(() => {
    closeDatabase();
    invalidatePathCache();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => closeDatabase());

  it("paginates all queue failures without exposing candidate data", () => {
    const service = new MemoryService();
    service.enqueueEvent(failedEvent("event-01", 1));
    service.enqueueEvent(failedEvent("event-02", 3));
    service.enqueueEvent(failedEvent("event-03", 3));
    const first = service.listFailedTasks(1, 2);
    const second = service.listFailedTasks(2, 2);
    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.eventId)).toEqual(["event-03", "event-02"]);
    expect(second.items.map((item) => item.eventId)).toEqual(["event-01"]);
    expect(JSON.stringify(first)).not.toContain("private candidate content");
    service.close();
  });

  it("only requeues exhausted failures once, resetting the retry budget", () => {
    const service = new MemoryService();
    service.enqueueEvent(failedEvent("event-01", 2));
    service.enqueueEvent(failedEvent("event-02", 3));
    expect(service.retryFailedTask("missing")).toBe("not_found");
    expect(service.retryFailedTask("event-01")).toBe("not_ready");
    expect(service.retryFailedTask("event-02")).toBe("queued");
    expect(service.retryFailedTask("event-02")).toBe("not_ready");
    expect(service.getEvent("event-02")).toMatchObject({ status: "pending", retryCount: 0 });
    service.close();
  });
});
