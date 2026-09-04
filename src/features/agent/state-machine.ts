import type { AgentStage } from "../../types/agent";
import type { PendingEvent } from "../../types/memory";

const ALLOWED_TRANSITIONS: Readonly<Record<AgentStage, readonly AgentStage[]>> = {
  discovered: ["parsing", "done", "failed_retryable"],
  parsing: ["normalizing", "rejected", "failed_retryable"],
  normalizing: ["staged", "done", "rejected", "failed_retryable"],
  staged: ["processing", "failed_retryable"],
  processing: ["accepted", "done", "review", "rejected", "failed_retryable"],
  accepted: ["publishing", "failed_retryable"],
  publishing: ["indexed", "failed_retryable"],
  indexed: ["done", "failed_retryable"],
  done: [],
  review: ["accepted", "rejected"],
  rejected: [],
  failed_retryable: ["parsing", "staged", "processing", "publishing"],
};

export function canTransitionAgentStage(current: AgentStage, next: AgentStage): boolean {
  return current === next || ALLOWED_TRANSITIONS[current].includes(next);
}

export function assertAgentStageTransition(current: AgentStage, next: AgentStage): void {
  if (!canTransitionAgentStage(current, next)) {
    throw new Error(`非法 Agent 状态迁移: ${current} -> ${next}`);
  }
}

type PendingEventStatus = PendingEvent["status"];

const ALLOWED_PENDING_EVENT_TRANSITIONS: Readonly<
  Record<PendingEventStatus, readonly PendingEventStatus[]>
> = {
  pending: ["processing", "failed", "rejected", "review"],
  processing: ["done", "failed", "rejected", "review"],
  failed: ["pending"],
  review: ["processing", "rejected"],
  done: [],
  rejected: [],
};

export function canTransitionPendingEventStatus(
  current: PendingEventStatus,
  next: PendingEventStatus,
): boolean {
  return current === next || ALLOWED_PENDING_EVENT_TRANSITIONS[current].includes(next);
}

export function assertPendingEventStatusTransition(
  current: PendingEventStatus,
  next: PendingEventStatus,
): void {
  if (!canTransitionPendingEventStatus(current, next)) {
    throw new Error(`非法队列状态迁移: ${current} -> ${next}`);
  }
}
