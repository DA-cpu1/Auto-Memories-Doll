export type SourceType =
  "markdown" | "text" | "codex" | "claude-code" | "cursor" | "trae" | "listen";

export type SourceRevisionOperation = "add" | "change" | "delete" | "rescan";

export type SourceRevisionEvent = {
  eventId: string;
  sourceId: string;
  sourceType: SourceType;
  sourcePath?: string;
  revision: string;
  observedAt: string;
  operation: SourceRevisionOperation;
};

export type SourceHealth = "unknown" | "healthy" | "degraded" | "unavailable" | "disabled";

export type SourceDocument = {
  sourceId: string;
  sourceType: SourceType;
  sourcePath?: string;
  latestRevision?: string;
  health: SourceHealth;
  lastObservedAt?: string;
  lastProcessedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};
