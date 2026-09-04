export type AgentStage =
  | "discovered"
  | "parsing"
  | "normalizing"
  | "staged"
  | "processing"
  | "accepted"
  | "publishing"
  | "indexed"
  | "done"
  | "review"
  | "rejected"
  | "failed_retryable";

export type AgentProgressOutcome = "completed" | "skipped" | "waiting" | "failed";

export type AgentProgressEvent = {
  progressId: string;
  eventId: string;
  sourceId: string;
  revision: string;
  memoryId?: string;
  stage: AgentStage;
  attempt: number;
  timestamp: string;
  durationMs: number;
  outcome: AgentProgressOutcome;
  errorCode?: string;
  error?: string;
  retryable: boolean;
  degradedCapabilities: Array<"llm" | "embedding">;
};
