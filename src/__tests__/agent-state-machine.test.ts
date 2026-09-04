import { describe, expect, it } from "vitest";
import {
  assertAgentStageTransition,
  assertPendingEventStatusTransition,
  canTransitionAgentStage,
  canTransitionPendingEventStatus,
} from "../features/agent/state-machine";

describe("knowledge agent state transitions", () => {
  it("accepts the publish path and recovery paths", () => {
    const publishPath = [
      "discovered",
      "parsing",
      "normalizing",
      "staged",
      "processing",
      "accepted",
      "publishing",
      "indexed",
      "done",
    ] as const;

    for (let index = 1; index < publishPath.length; index++) {
      expect(canTransitionAgentStage(publishPath[index - 1], publishPath[index])).toBe(true);
    }
    expect(canTransitionAgentStage("processing", "review")).toBe(true);
    expect(canTransitionAgentStage("review", "accepted")).toBe(true);
    expect(canTransitionAgentStage("review", "rejected")).toBe(true);
    expect(canTransitionAgentStage("processing", "failed_retryable")).toBe(true);
    expect(canTransitionAgentStage("failed_retryable", "processing")).toBe(true);
  });

  it("rejects skipped stages and transitions out of terminal states", () => {
    expect(() => assertAgentStageTransition("discovered", "publishing")).toThrow(
      "非法 Agent 状态迁移",
    );
    expect(canTransitionAgentStage("done", "processing")).toBe(false);
    expect(canTransitionAgentStage("rejected", "processing")).toBe(false);
  });

  it("keeps persisted queue terminal states terminal", () => {
    expect(canTransitionPendingEventStatus("pending", "processing")).toBe(true);
    expect(canTransitionPendingEventStatus("processing", "review")).toBe(true);
    expect(canTransitionPendingEventStatus("review", "processing")).toBe(true);
    expect(canTransitionPendingEventStatus("failed", "pending")).toBe(true);
    expect(() => assertPendingEventStatusTransition("done", "pending")).toThrow("非法队列状态迁移");
    expect(canTransitionPendingEventStatus("rejected", "pending")).toBe(false);
  });
});
