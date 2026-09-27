"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Markdown from "@/components/common/Markdown";
import { askQuestionStream } from "@/lib/ask-client";
import { memoryDetailHref } from "@/lib/memory-api-client";
import type { AskCitation, AskStreamEvent } from "@/types/ask";

type Mode = "ask" | "search";
type Phase = "running" | "answered" | "refused" | "error";
type ToolLine = { tool: string; summary: string | null };
type Exchange = {
  id: string;
  question: string;
  phase: Phase;
  toolLines: ToolLine[];
  answer: string;
  citations: AskCitation[];
  refusal: { reason: string; suggestion: string } | null;
  error: string | null;
  usage: { prompt: number; completion: number } | null;
  activityOpen: boolean;
};

const TOOL_LABELS: Record<string, string> = {
  search_memory: "检索记忆",
  read_memory: "读取记忆",
  read_source_document: "读取来源文档",
  read_topic_guide: "读取主题资料",
  citation_repair: "校验引用",
};

function emptyExchange(question: string): Exchange {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    question,
    phase: "running",
    toolLines: [],
    answer: "",
    citations: [],
    refusal: null,
    error: null,
    usage: null,
    activityOpen: true,
  };
}

export function AskPanel() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("ask");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [formError, setFormError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const updateExchange = (id: string, update: (item: Exchange) => Exchange) => {
    setExchanges((items) => items.map((item) => (item.id === id ? update(item) : item)));
  };

  const sendQuestion = async (question: string) => {
    const exchange = emptyExchange(question);
    const controller = new AbortController();
    abortRef.current = controller;
    setExchanges((items) => [...items, exchange]);

    let pendingText = "";
    const flushText = () => {
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = "";
      updateExchange(exchange.id, (item) => ({ ...item, answer: item.answer + chunk }));
    };
    const flushTimer = window.setInterval(flushText, 120);

    const handleEvent = (event: AskStreamEvent) => {
      switch (event.type) {
        case "tool_call":
          updateExchange(exchange.id, (item) => ({
            ...item,
            toolLines: [...item.toolLines, { tool: event.tool, summary: null }],
          }));
          break;
        case "tool_result":
          updateExchange(exchange.id, (item) => {
            const toolLines = [...item.toolLines];
            for (let index = toolLines.length - 1; index >= 0; index -= 1) {
              if (toolLines[index].tool === event.tool && toolLines[index].summary === null) {
                toolLines[index] = { ...toolLines[index], summary: event.resultSummary };
                break;
              }
            }
            return { ...item, toolLines };
          });
          break;
        case "token":
          pendingText += event.text;
          break;
        case "citations":
          updateExchange(exchange.id, (item) => ({
            ...item,
            citations: event.citations,
            phase: "answered",
            activityOpen: false,
          }));
          break;
        case "refusal":
          pendingText = "";
          updateExchange(exchange.id, (item) => ({
            ...item,
            answer: "",
            refusal: { reason: event.reason, suggestion: event.suggestion },
            phase: "refused",
            activityOpen: false,
          }));
          break;
        case "done":
          updateExchange(exchange.id, (item) => ({
            ...item,
            usage: {
              prompt: event.usage.promptTokens,
              completion: event.usage.completionTokens,
            },
            activityOpen: false,
          }));
          break;
        case "error":
          pendingText = "";
          updateExchange(exchange.id, (item) => ({
            ...item,
            error: event.message,
            phase: "error",
            activityOpen: false,
          }));
          break;
        default:
          break;
      }
    };

    try {
      await askQuestionStream(question, { signal: controller.signal, onEvent: handleEvent });
    } catch (error) {
      if (!controller.signal.aborted) {
        updateExchange(exchange.id, (item) => ({
          ...item,
          error: error instanceof Error ? error.message : String(error),
          phase: "error",
          activityOpen: false,
        }));
      }
    } finally {
      window.clearInterval(flushTimer);
      flushText();
      abortRef.current = null;
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) {
      setFormError("请输入问题或关键词。");
      return;
    }
    if (mode === "ask" && exchanges.some((item) => item.phase === "running")) return;
    setFormError("");
    setQuery("");
    if (mode === "search") {
      router.push(`/memory?q=${encodeURIComponent(value)}`);
      return;
    }
    void sendQuestion(value);
  };

  return (
    <div className="home-workspace">
      {exchanges.length > 0 ? (
        <section className="conversation-list" aria-label="提问记录">
          {exchanges.map((exchange) => (
            <article className="exchange" key={exchange.id}>
              <div className="user-row">
                <p className="user-message">{exchange.question}</p>
              </div>
              <div className="assistant-column">
                <details
                  className="activity-details"
                  open={exchange.activityOpen}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setExchanges((items) =>
                      items.map((item) =>
                        item.id === exchange.id && item.activityOpen !== open
                          ? { ...item, activityOpen: open }
                          : item,
                      ),
                    );
                  }}
                >
                  <summary>
                    <span>{exchange.phase === "running" ? "正在处理" : "处理过程"}</span>
                    {exchange.toolLines.length > 0 ? (
                      <span className="activity-count">{exchange.toolLines.length} 项依据操作</span>
                    ) : null}
                  </summary>
                  <ol className="activity-list" aria-live="polite">
                    {exchange.toolLines.length === 0 ? (
                      <li className="activity-empty">正在连接问答服务…</li>
                    ) : (
                      exchange.toolLines.map((line, index) => (
                        <li key={`${line.tool}-${index}`}>
                          <span className="activity-mark" aria-hidden="true">
                            {line.summary === null ? "·" : "✓"}
                          </span>
                          <span className="activity-label">
                            {TOOL_LABELS[line.tool] || line.tool}
                          </span>
                          <span className="activity-summary">{line.summary || "读取中"}</span>
                        </li>
                      ))
                    )}
                  </ol>
                </details>

                <div className="answer-content" aria-live="polite">
                  {exchange.answer ? (
                    <Markdown content={exchange.answer} className="answer-markdown" />
                  ) : null}
                  {exchange.phase === "running" && exchange.answer ? (
                    <p className="inline-progress">引用校验中…</p>
                  ) : null}
                  {exchange.refusal ? (
                    <div className="notice notice-warning" role="status">
                      <p className="font-medium">{exchange.refusal.reason}</p>
                      <p>{exchange.refusal.suggestion}</p>
                    </div>
                  ) : null}
                  {exchange.error ? (
                    <p className="notice notice-error" role="alert">
                      问答失败：{exchange.error}
                    </p>
                  ) : null}
                  {exchange.citations.length > 0 ? (
                    <section className="citation-section" aria-label="已校验引用">
                      <h2>
                        来源 <span>{exchange.citations.length} 条已校验</span>
                      </h2>
                      <ul>
                        {exchange.citations.map((citation, index) => (
                          <li key={`${citation.memoryId}-${index}`}>
                            <Link href={memoryDetailHref(citation.memoryId)}>
                              <span className="citation-index">{index + 1}</span>
                              <span className="citation-id">{citation.memoryId}</span>
                              <span className="citation-quote">“{citation.quote}”</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <form className="home-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="home-query">
          输入问题或关键词
        </label>
        <input
          id="home-query"
          value={query}
          maxLength={500}
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value.trim()) setFormError("");
          }}
          placeholder={mode === "ask" ? "例如：来源版本如何避免重复入库？" : "例如：来源版本"}
          autoComplete="off"
          aria-invalid={Boolean(formError)}
          aria-describedby={formError ? "home-query-error" : undefined}
        />
        <div className="composer-actions">
          <div className="mode-switch" role="group" aria-label="选择操作方式">
            <button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}>
              提问
            </button>
            <button
              type="button"
              aria-pressed={mode === "search"}
              onClick={() => setMode("search")}
            >
              检索
            </button>
          </div>
          <button
            className="submit-button"
            type="submit"
            aria-label={mode === "ask" ? "发送提问" : "开始检索"}
            disabled={mode === "ask" && exchanges.some((item) => item.phase === "running")}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 19V5m-6 6 6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </form>
      {formError ? (
        <p id="home-query-error" className="form-error" role="alert">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
