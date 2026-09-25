/**
 * 问答 Agent（/api/ask）共享类型。
 *
 * 这些类型同时被服务端（ask-log-service / ask-agent-service / ask-tools）
 * 与客户端（ask-client / AskPanel）使用，保持零服务端依赖。
 */

/** 答案引用：必须能溯源到真实存在的记忆卡 */
export type AskCitation = {
  memoryId: string;
  /** 答案声称支撑该结论的记忆原文片段，校验时做归一化子串比对 */
  quote: string;
  verified: boolean;
};

/** 单次工具调用轨迹，落库 ask_logs.toolTrace */
export type AskToolTraceEntry = {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
};

export type AskUsage = {
  promptTokens: number;
  completionTokens: number;
};

/** 本次问答实际执行的循环模式：原生流式 / 非流式缓冲 / JSON 手工循环（降级） */
export type AskLoopMode = "stream" | "buffered" | "json-loop";

/** 拒答诊断：为什么拒（协议缺失/校验失败）+ 模型原始输出，供事后排查 */
export type AskDiagnostics = {
  parseError?: string;
  failureReason?: string;
  /** 拒答时模型的原始输出（已截断），用于排查引用区块与转录质量 */
  rawAnswer?: string;
  rawCitations?: { memoryId: string; quote: string }[];
};

/** ask_logs 表的规范记录形态（JSON 列已反序列化） */
export type AskLogRecord = {
  askId: string;
  question: string;
  /** 拒答时为拒答说明正文 */
  answer: string;
  refused: boolean;
  citations: AskCitation[];
  toolTrace: AskToolTraceEntry[];
  usage: AskUsage;
  model: string;
  mode: AskLoopMode;
  durationMs: number;
  createdAt: string;
  diagnostics?: AskDiagnostics;
};

/** GET /api/ask 返回的累计统计（token 成本可见性承诺） */
export type AskStats = {
  totalAsks: number;
  refusedAsks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  lastAskedAt: string | null;
};

/** POST /api/ask 的 SSE 事件契约（前端按 type 分发渲染） */
export type AskStreamEvent =
  | { type: "start"; askId: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; resultSummary: string }
  | { type: "token"; text: string }
  | { type: "citations"; citations: AskCitation[] }
  | { type: "refusal"; reason: string; suggestion: string }
  | { type: "done"; usage: AskUsage; durationMs: number; askId: string; mode: AskLoopMode }
  | { type: "error"; code: string; message: string };
