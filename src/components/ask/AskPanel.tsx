"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Markdown from "@/components/common/Markdown";
import { fetchAskStats, askQuestionStream } from "@/lib/ask-client";
import { memoryDetailHref, searchMemoriesClient } from "@/lib/memory-api-client";
import type { AskCitation, AskStats } from "@/types/ask";

type SearchResult = {
  id: string;
  title: string;
  titleZh?: string;
  summary: string;
  summaryZh?: string;
  topic: string;
  score?: number;
  source?: string;
  channels?: string[];
};

type AskPhase = "idle" | "running" | "answered" | "refused" | "error";

type ToolLine = { tool: string; summary: string | null };

/**
 * 首页问答 + 检索入口。
 * - 提问：/api/ask SSE 工具循环，答案流式渲染，引用校验通过后展示引用卡片；
 *   拒答时答案整体替换为拒答说明（严格模式，无引用不发布）。
 * - 检索：保留原关键词检索行为（/api/memory/search 内联结果）。
 */
export function AskPanel() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<AskPhase>("idle");
  const [toolLines, setToolLines] = useState<ToolLine[]>([]);
  const [answerText, setAnswerText] = useState("");
  const [citations, setCitations] = useState<AskCitation[]>([]);
  const [refusal, setRefusal] = useState<{ reason: string; suggestion: string } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ prompt: number; completion: number } | null>(null);
  const [stats, setStats] = useState<AskStats | null>(null);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await fetchAskStats());
    } catch {
      // 统计不可见不阻塞主流程
    }
  }, []);

  useEffect(() => {
    loadStats().catch(() => undefined);
  }, [loadStats]);

  const resetAskState = () => {
    setToolLines([]);
    setAnswerText("");
    setCitations([]);
    setRefusal(null);
    setAskError(null);
    setUsage(null);
  };

  const handleAsk = async () => {
    const question = query.trim();
    if (!question || phase === "running") return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    resetAskState();
    setPhase("running");
    try {
      await askQuestionStream(question, {
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "tool_call":
              setToolLines((lines) => [...lines, { tool: event.tool, summary: null }]);
              break;
            case "tool_result":
              setToolLines((lines) => {
                const next = [...lines];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].tool === event.tool && next[i].summary === null) {
                    next[i] = { tool: event.tool, summary: event.resultSummary };
                    break;
                  }
                }
                return next;
              });
              break;
            case "token":
              setAnswerText((text) => text + event.text);
              break;
            case "citations":
              setCitations(event.citations);
              setPhase("answered");
              break;
            case "refusal":
              // 严格拒答：已流出的答案不再展示
              setAnswerText("");
              setRefusal({ reason: event.reason, suggestion: event.suggestion });
              setPhase("refused");
              break;
            case "done":
              setUsage({
                prompt: event.usage.promptTokens,
                completion: event.usage.completionTokens,
              });
              loadStats().catch(() => undefined);
              break;
            case "error":
              setAskError(event.message);
              setPhase("error");
              break;
            default:
              break;
          }
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setAskError(error instanceof Error ? error.message : String(error));
      setPhase("error");
    } finally {
      // 流结束但未收到终态事件时解除按钮锁定
      setPhase((current) => (current === "running" ? "idle" : current));
    }
  };

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;

    setSearching(true);
    setSearched(true);
    try {
      const response = await searchMemoriesClient(value, 8);
      setResults(response.results);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="rounded-lg border border-[#E0D6C7] bg-[#FFFDF9] p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 sm:gap-4">
        <h2 className="text-base font-semibold text-[#3E3224]">提问与检索</h2>
        <div className="flex items-center gap-3">
          <LinkishStats stats={stats} />
          <Link href="/memory" className="text-sm font-medium text-[#8B6500] hover:underline">
            打开检索库
          </Link>
        </div>
      </div>

      <form onSubmit={handleSearch} className="flex flex-col gap-2">
        <label htmlFor="dashboard-search" className="sr-only">
          提问或检索知识
        </label>
        <input
          id="dashboard-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入关键词或自然语言问题"
          className="input min-w-0 flex-1"
        />
        <div className="flex flex-row gap-2">
          <button
            type="button"
            className="btn min-w-0 flex-1"
            disabled={phase === "running" || !query.trim()}
            onClick={handleAsk}
          >
            {phase === "running" ? "问答中" : "提问"}
          </button>
          <button type="submit" className="btn btn-secondary shrink-0" disabled={searching}>
            {searching ? "检索中" : "检索"}
          </button>
        </div>
      </form>

      {phase === "running" || toolLines.length > 0 ? (
        <div className="mt-4 space-y-1" aria-live="polite">
          {toolLines.map((line, index) => (
            <p key={`${line.tool}-${index}`} className="font-mono text-xs text-[#8B7355]">
              {line.summary === null ? `⚙ ${line.tool} …` : `✓ ${line.tool} — ${line.summary}`}
            </p>
          ))}
          {phase === "running" && answerText === "" && toolLines.length === 0 ? (
            <p className="font-mono text-xs text-[#8B7355]">正在检索知识库…</p>
          ) : null}
        </div>
      ) : null}

      {answerText ? (
        <div className="mt-4 border-t border-[#ECE4D8] pt-4">
          <Markdown content={answerText} className="text-sm leading-relaxed text-[#3E3224]" />
          {phase === "running" ? (
            <p className="mt-1 font-mono text-xs text-[#A67C00]">引用校验中…</p>
          ) : null}
        </div>
      ) : null}

      {citations.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-[#8B7355]">
            引用（已逐条校验，{citations.length} 条）
          </p>
          <ul className="space-y-2">
            {citations.map((citation) => (
              <li key={citation.memoryId}>
                <button
                  type="button"
                  onClick={() => router.push(memoryDetailHref(citation.memoryId))}
                  className="w-full rounded-md border border-[#E0D6C7] bg-white/60 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A67C00]"
                >
                  <span className="font-mono text-xs text-[#8B7355]">{citation.memoryId}</span>
                  <p className="mt-1 line-clamp-2 text-xs text-[#6F604B]">“{citation.quote}”</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {refusal ? (
        <div
          role="status"
          className="mt-4 rounded-md border border-[#E5D5B0] bg-[#FBF4E4] px-4 py-3 text-sm text-[#6F604B]"
        >
          <p className="font-medium text-[#8B6500]">{refusal.reason}</p>
          <p className="mt-1">{refusal.suggestion}</p>
        </div>
      ) : null}

      {askError ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-[#D9B4A8] bg-[#F9EDE8] px-4 py-3 text-sm text-[#A14C37]"
        >
          问答失败：{askError}
        </p>
      ) : null}

      {usage ? (
        <p className="mt-3 font-mono text-xs text-[#8B7355]">
          本次消耗：输入 {usage.prompt} / 输出 {usage.completion} token
        </p>
      ) : null}

      {searched ? (
        <div className="mt-5 border-t border-[#ECE4D8] pt-4" aria-live="polite">
          {results.length > 0 ? (
            <ul className="divide-y divide-[#ECE4D8]">
              {results.map((result) => (
                <li key={result.id}>
                  <button
                    type="button"
                    onClick={() => router.push(memoryDetailHref(result.id))}
                    className="w-full py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A67C00]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-medium text-[#3E3224]">
                        {result.titleZh || result.title}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-[#8B7355]">
                        {result.score === undefined
                          ? result.topic
                          : `${Math.round(result.score * 100)}%`}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-[#6F604B]">
                      {result.summaryZh || result.summary}
                    </p>
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#8B7355]">
                      <span>主题 {result.topic}</span>
                      <span>来源 {result.source || "未知"}</span>
                      {result.channels?.length ? (
                        <span>命中 {result.channels.join(" + ")}</span>
                      ) : null}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          ) : searching ? null : (
            <p className="py-6 text-center text-sm text-[#8B7355]">未找到匹配知识</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function LinkishStats({ stats }: { stats: AskStats | null }) {
  if (!stats || stats.totalAsks === 0) {
    return <span className="text-xs text-[#8B7355]">尚无提问记录</span>;
  }
  return (
    <span className="font-mono text-xs text-[#8B7355]">
      累计 {stats.totalAsks} 问 · token {stats.totalPromptTokens}/{stats.totalCompletionTokens}
    </span>
  );
}
