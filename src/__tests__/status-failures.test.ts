import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeDatabase } from "../lib/storage/database";
import { invalidatePathCache } from "../lib/storage/path-resolver";
import { MemoryService } from "../server/services/memory-service";
import { POST as retryFailedTaskRoute } from "../app/api/status/failures/retry/route";
import { NextRequest } from "next/server";
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

  it("selects retryable failures before applying the batch limit", () => {
    const service = new MemoryService();
    for (let index = 1; index <= 20; index++) {
      service.enqueueEvent(failedEvent(`event-${String(index).padStart(2, "0")}`, 3));
    }
    for (let index = 21; index <= 36; index++) {
      service.enqueueEvent(failedEvent(`event-${index}`, index === 36 ? 2 : 1));
    }

    const retryable = service.getRetryableFailedEvents(20, 3);
    expect(retryable).toHaveLength(16);
    expect(retryable.map((event) => event.eventId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `event-${index + 21}`),
    );
    service.close();
  });

  it("accepts the browser origin from Host when Next.js normalizes the URL hostname", async () => {
    const request = new NextRequest("http://localhost:3000/api/status/failures/retry", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await retryFailedTaskRoute(request);
    expect(response.status).toBe(400);
  });

  it("rejects a different browser origin", async () => {
    const request = new NextRequest("http://localhost:3000/api/status/failures/retry", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        Origin: "http://other.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await retryFailedTaskRoute(request);
    expect(response.status).toBe(403);
  });
});
