import { MemoryRecord } from "./memory";

export type MemoryQueryRequest = {
  query: string;
  limit?: number;
  tags?: string[];
  sourceTypes?: string[];
};

export type MemoryQueryResponse = {
  results: MemoryRecord[];
  total: number;
  queryTime: number;
};

export type MemoryListResponse = {
  items: MemoryRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type MemorySearchResponse = {
  results: MemorySearchResult[];
  total: number;
  retrievalMode: "vector" | "keyword" | null;
  degradedMode: boolean;
};

export type MemorySearchResult = MemoryRecord & {
  /** 最终用于排序的归一化相关度。 */
  score: number;
  /** 实际参与本次命中的召回通道。 */
  channels: Array<"vector" | "keyword" | "tag" | "graph">;
};

export type MemoryWriteRequest = {
  memory: Partial<MemoryRecord>;
  mode: "merge" | "replace";
};

export type MemoryWriteResponse = {
  success: boolean;
  memoryId: string;
  status: "written" | "queued" | "conflict";
};

export type IngestRequest = {
  source: string;
  sourceType: "chat" | "ingest" | "manual" | "mcp" | "skill";
  content: string;
  metadata?: Record<string, string>;
};

export type IngestResponse = {
  eventId: string;
  status: "queued" | "processing";
};

export type AuditRequest = {
  action: "process" | "resolve" | "list";
  eventId?: string;
  conflictId?: string;
  resolution?: "accept" | "keep" | "manual";
  manualValue?: string;
};

export type AuditResponse = {
  success: boolean;
  results?: any[];
  message?: string;
};

export type ApiError = {
  code: number;
  message: string;
  details?: string;
};
