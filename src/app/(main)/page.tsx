"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { memoryDetailHref, searchMemoriesClient } from "@/lib/memory-api-client";

type SearchResult = {
  id: string;
  title: string;
  titleZh?: string;
  summary: string;
  summaryZh?: string;
  topic: string;
  score?: number;
};

type SourceStatus = {
  agent?: {
    sources?: unknown[];
    progress?: Array<{
      progressId: string;
      stage: string;
      timestamp: string;
      sourceId: string;
    }>;
  };
  watchers?: {
    fileWatcher?: { running?: boolean };
    toolSources?: unknown[];
  };
};

type QueueStatus = {
  events?: { pending?: number; review?: number; failed?: number };
};

const STAGE_LABELS: Record<string, string> = {
  discovered: "已发现",
  parsing: "解析中",
  normalizing: "归一化",
  staged: "已入队",
  processing: "处理中",
  accepted: "已接受",
  publishing: "发布中",
  indexed: "已索引",
  done: "已完成",
  review: "待审核",
  rejected: "已拒绝",
  failed_retryable: "等待重试",
};

export default function DashboardPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);

  const loadStatus = useCallback(async () => {
    const [sourceResponse, queueResponse] = await Promise.all([
      fetch("/api/listen"),
      fetch("/api/config/tool-sources/status"),
    ]);
    if (sourceResponse.ok) setSourceStatus((await sourceResponse.json()) as SourceStatus);
    if (queueResponse.ok) setQueueStatus((await queueResponse.json()) as QueueStatus);
  }, []);

  useEffect(() => {
    loadStatus().catch(() => undefined);
  }, [loadStatus]);

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

  const sourceCount = sourceStatus?.agent?.sources?.length ?? 0;
  const activeWatcherCount =
    (sourceStatus?.watchers?.fileWatcher?.running ? 1 : 0) +
    (sourceStatus?.watchers?.toolSources?.length ?? 0);
  const recentProgress = sourceStatus?.agent?.progress?.slice(0, 5) ?? [];
  const events = queueStatus?.events;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-5 border-b border-[#D8CEBE] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 font-mono text-xs font-semibold uppercase text-[#8B7355]">
            Local Knowledge Agent
          </p>
          <h1 className="text-2xl font-bold text-[#3E3224] sm:text-3xl">知识处理概览</h1>
          <p className="mt-2 text-sm text-[#6F604B]">来源、审核队列与检索状态</p>
        </div>
        <button type="button" className="btn btn-secondary self-start" onClick={loadStatus}>
          刷新状态
        </button>
      </header>

      <section aria-labelledby="status-heading">
        <h2 id="status-heading" className="sr-only">
          处理状态
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "已登记来源", value: sourceCount, tone: "text-[#3E3224]" },
            {
              label: "活跃监听",
              value: activeWatcherCount,
              tone: activeWatcherCount > 0 ? "text-[#567228]" : "text-[#8B7355]",
            },
            { label: "待处理", value: events?.pending ?? 0, tone: "text-[#A67C00]" },
            {
              label: "待审核",
              value: events?.review ?? 0,
              tone: (events?.review ?? 0) > 0 ? "text-[#A14C37]" : "text-[#3E3224]",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-[#E0D6C7] bg-[#FFFDF9] p-4">
              <p className="text-xs font-medium text-[#8B7355]">{item.label}</p>
              <p className={`mt-2 font-mono text-2xl font-bold ${item.tone}`}>{item.value}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
        <section className="rounded-lg border border-[#E0D6C7] bg-[#FFFDF9] p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-[#3E3224]">快速检索</h2>
            <Link href="/memory" className="text-sm font-medium text-[#8B6500] hover:underline">
              打开检索库
            </Link>
          </div>
          <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="dashboard-search" className="sr-only">
              检索知识
            </label>
            <input
              id="dashboard-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入关键词或自然语言问题"
              className="input min-w-0 flex-1"
            />
            <button type="submit" className="btn shrink-0" disabled={searching}>
              {searching ? "检索中" : "检索"}
            </button>
          </form>

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

        <aside className="rounded-lg border border-[#E0D6C7] bg-[#FFFDF9] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-[#3E3224]">最近处理</h2>
            <span className="text-xs text-[#8B7355]">
              {sourceStatus?.watchers?.fileWatcher?.running ? "文件监听正常" : "文件监听未运行"}
            </span>
          </div>
          {recentProgress.length > 0 ? (
            <ol className="space-y-3">
              {recentProgress.map((progress) => (
                <li key={progress.progressId} className="border-l-2 border-[#D4B84A] pl-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-[#4E412F]">
                      {STAGE_LABELS[progress.stage] || progress.stage}
                    </span>
                    <time className="text-xs text-[#9A8A73]">
                      {new Date(progress.timestamp).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-[#8B7355]">
                    {progress.sourceId}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-[#8B7355]">暂无处理记录</p>
          )}
        </aside>
      </div>

      <nav aria-label="快捷入口" className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          { href: "/settings/tools", title: "来源设置", detail: "配置目录与工具会话来源" },
          { href: "/audit", title: "审核队列", detail: `${events?.review ?? 0} 条候选等待裁决` },
          { href: "/memory/map", title: "知识图谱", detail: "浏览 Wikilink 关联" },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg border border-[#D8CEBE] bg-transparent p-4 transition-colors hover:border-[#A67C00] hover:bg-[#FFFDF9]"
          >
            <span className="block text-sm font-semibold text-[#3E3224]">{item.title}</span>
            <span className="mt-1 block text-xs text-[#7C6B54]">{item.detail}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
