import { ASK_CITATION_MIN_QUOTE_LENGTH, ASK_TIMEOUT_MS } from "../../config/ask.config";
import { logger } from "../../lib/logger";
import {
  AskCitation,
  AskLogRecord,
  AskStreamEvent,
  AskToolTraceEntry,
  AskUsage,
} from "../../types/ask";
import { getAskModelId, runAskLoop } from "../../lib/ai/ask-model";
import { AskToolkit, AskToolkitDeps } from "./ask-tools";
import { AskLogService } from "./ask-log-service";

/**
 * 问答 Agent 编排：跑工具循环 → 解析并校验引用 → 严格拒答或带引用回答 → 落库 ask_logs。
 *
 * 引用校验是硬闸门（Q12 严格模式）：答案末尾的 <citations> 区块里每个
 * memoryId 必须真实存在，quote 必须是该记忆 content/summary 的归一化子串。
 * 零引用或任何一条校验失败 → 拒答，答案不发布。
 */

export type AskOutcome =
  | {
      kind: "answered";
      askId: string;
      answer: string;
      citations: AskCitation[];
      usage: AskUsage;
      toolTrace: AskToolTraceEntry[];
      model: string;
      mode: AskLogRecord["mode"];
      durationMs: number;
    }
  | {
      kind: "refused";
      askId: string;
      reason: string;
      suggestion: string;
      citations: [];
      usage: AskUsage;
      toolTrace: AskToolTraceEntry[];
      model: string;
      mode: AskLogRecord["mode"];
      durationMs: number;
    };

export type ParsedCitation = { memoryId: string; quote: string };

const CITATION_BLOCK_RE = /<citations>\s*([\s\S]*?)\s*<\/citations>/g;

/** 从模型输出中拆出展示答案与引用声明；无区块时 citations 为空并标注 parseError */
export function splitAnswerAndCitations(raw: string): {
  answer: string;
  citations: ParsedCitation[];
  parseError?: string;
} {
  const matches = [...raw.matchAll(CITATION_BLOCK_RE)];
  if (matches.length === 0) {
    return { answer: raw.trim(), citations: [], parseError: "missing-citations-block" };
  }

  // 只取最后一个区块，避免模型在正文里示范格式造成干扰
  const last = matches[matches.length - 1];
  const answer = raw.replace(last[0], "").trim();

  let citations: ParsedCitation[] = [];
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(last[1]) as unknown;
    if (Array.isArray(parsed)) {
      citations = parsed.filter(
        (item): item is ParsedCitation =>
          !!item &&
          typeof item === "object" &&
          typeof (item as ParsedCitation).memoryId === "string" &&
          typeof (item as ParsedCitation).quote === "string",
      );
    } else {
      parseError = "citations-not-array";
    }
  } catch {
    parseError = "citations-invalid-json";
  }

  return { answer, citations, parseError };
}

/**
 * 引用比对的归一化：全半角折叠 + 去全部空白 + 小写。
 * 模型复制原文时常出现全角标点（（）：，）写成半角或反之——这属于编码变体而非改写，
 * 折叠后仍要求逐字命中，闸门强度不变。
 */
export function normalizeForCitation(text: string): string {
  return foldFullWidth(text).replace(/\s+/g, "").toLowerCase();
}

const CJK_PUNCT_MAP: Record<string, string> = {
  "（": "(",
  "）": ")",
  "：": ":",
  "，": ",",
  "。": ".",
  "；": ";",
  "！": "!",
  "？": "?",
  "【": "[",
  "】": "]",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "「": '"',
  "」": '"',
  "—": "-",
  "～": "~",
  "·": "",
};

function foldFullWidth(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = CJK_PUNCT_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // 全角 ASCII 区（U+FF01 ！ 至 U+FF5E ～）折叠为对应半角
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
  }
  return out;
}

export type CitationVerification = {
  citations: AskCitation[];
  valid: boolean;
  failureReason?: string;
};

/** 逐条校验：memoryId 存在 + quote 是该记忆 content/summary 的归一化子串 */
export function verifyCitations(
  citations: ParsedCitation[],
  toolkit: AskToolkit,
): CitationVerification {
  if (citations.length === 0) {
    return { citations: [], valid: false, failureReason: "no-citations" };
  }

  const memories = toolkit.readMemoriesForVerification(citations.map((c) => c.memoryId));
  const byId = new Map(memories.map((m) => [m.id, m]));

  const verified: AskCitation[] = [];
  for (const citation of citations) {
    const memory = byId.get(citation.memoryId);
    if (!memory) {
      return {
        citations: markUnverified(citations),
        valid: false,
        failureReason: `memory-not-found:${citation.memoryId}`,
      };
    }
    if (citation.quote.trim().length < ASK_CITATION_MIN_QUOTE_LENGTH) {
      return {
        citations: markUnverified(citations),
        valid: false,
        failureReason: `quote-too-short:${citation.memoryId}`,
      };
    }

    const normalizedSource = normalizeForCitation(
      `${memory.content}\n${memory.summary}\n${memory.title}`,
    );
    if (!normalizedSource.includes(normalizeForCitation(citation.quote))) {
      return {
        citations: markUnverified(citations),
        valid: false,
        failureReason: `quote-not-in-memory:${citation.memoryId}`,
      };
    }

    verified.push({ ...citation, verified: true });
  }

  return { citations: verified, valid: true };
}

/** 校验失败时保留原始声明供审计，统一标记 verified: false */
function markUnverified(citations: ParsedCitation[]): AskCitation[] {
  return citations.map((citation) => ({ ...citation, verified: false }));
}

export type AskOptions = {
  question: string;
  onEvent?: (event: AskStreamEvent) => void;
  signal?: AbortSignal;
};

export class AskAgentService {
  private readonly toolkit: AskToolkit;
  private readonly askLogService: AskLogService;

  constructor(deps: { toolkit?: AskToolkitDeps; askLogService?: AskLogService } = {}) {
    this.toolkit = new AskToolkit(deps.toolkit);
    this.askLogService = deps.askLogService ?? new AskLogService();
  }

  async ask(options: AskOptions): Promise<AskOutcome> {
    const { question, onEvent, signal } = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const startedAt = Date.now();
    try {
      const loopResult = await runAskLoop({
        question,
        toolkit: this.toolkit,
        onEvent,
        signal: controller.signal,
      });

      const parsed = splitAnswerAndCitations(loopResult.answerText);
      const verification = verifyCitations(parsed.citations, this.toolkit);

      const durationMs = Date.now() - startedAt;
      const model = getAskModelId();
      const outcome: AskOutcome = verification.valid
        ? {
            kind: "answered",
            askId: "",
            answer: parsed.answer,
            citations: verification.citations,
            usage: loopResult.usage,
            toolTrace: loopResult.toolTrace,
            model,
            mode: loopResult.mode,
            durationMs,
          }
        : {
            kind: "refused",
            askId: "",
            reason: "库内未找到可验证的依据",
            suggestion: buildSuggestion(
              parsed.answer,
              verification.failureReason,
              parsed.parseError,
            ),
            citations: [],
            usage: loopResult.usage,
            toolTrace: loopResult.toolTrace,
            model,
            mode: loopResult.mode,
            durationMs,
          };

      const record = this.askLogService.recordAsk({
        question,
        answer: outcome.kind === "answered" ? outcome.answer : outcome.reason,
        refused: outcome.kind === "refused",
        citations: outcome.citations,
        toolTrace: outcome.toolTrace,
        usage: outcome.usage,
        model,
        mode: outcome.mode,
        durationMs,
        diagnostics:
          outcome.kind === "refused"
            ? {
                parseError: parsed.parseError,
                failureReason: verification.failureReason,
                rawAnswer: parsed.answer.slice(0, 2000) || loopResult.answerText.slice(0, 2000),
                rawCitations: parsed.citations,
              }
            : undefined,
      });

      const finalOutcome = { ...outcome, askId: record.askId } as AskOutcome;
      if (finalOutcome.kind === "answered") {
        onEvent?.({ type: "citations", citations: finalOutcome.citations });
      } else {
        onEvent?.({
          type: "refusal",
          reason: finalOutcome.reason,
          suggestion: finalOutcome.suggestion,
        });
      }
      onEvent?.({
        type: "done",
        usage: finalOutcome.usage,
        durationMs: finalOutcome.durationMs,
        askId: finalOutcome.askId,
        mode: finalOutcome.mode,
      });

      return finalOutcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.agent.warn(`问答失败: ${message}`);
      onEvent?.({ type: "error", code: "ASK_LOOP_FAILED", message });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  getStats() {
    return this.askLogService.getStats();
  }

  listRecent(limit = 20) {
    return this.askLogService.listRecent(limit);
  }
}

/**
 * 拒答时的建议文案：模型按协议明确说明缺口时复用其描述；
 * 协议缺失（无区块/JSON 损坏）时答案未经任何引用约束，不作为建议展示。
 */
function buildSuggestion(modelAnswer: string, failureReason?: string, parseError?: string): string {
  const protocolBroken =
    parseError === "missing-citations-block" ||
    parseError === "citations-invalid-json" ||
    parseError === "citations-not-array";
  const cleaned = modelAnswer.trim();

  if (!protocolBroken && cleaned && cleaned.length >= 6) {
    return cleaned;
  }
  if (protocolBroken || failureReason === "no-citations") {
    return "知识库中没有支撑该问题的记录。可尝试导入相关会话或文档后重新提问。";
  }
  return "答案引用未能通过校验（引用的记忆或原文片段不存在）。可换个问法，或确认相关记忆已在库中。";
}
