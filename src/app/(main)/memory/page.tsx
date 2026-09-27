"use client";

import React from "react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Markdown from "@/components/common/Markdown";
import EmptyState from "@/components/common/EmptyState";
import { defaultTopicLabels, getTopicLabelClient } from "@/config/topics-data";
import {
  getMemoryClient,
  listMemoriesClient,
  memoryDetailHref,
  memoryTopicHref,
  recordMemoryAccessClient,
  searchMemoriesClient,
} from "@/lib/memory-api-client";
import type { MemoryRecord } from "@/types/memory";
import type { MemorySearchResult } from "@/types/api";

const PAGE_SIZE = 12;
const SEARCH_LIMIT = 50;
type LibraryMemory = MemoryRecord & Partial<Pick<MemorySearchResult, "score" | "channels">>;

export default function MemoryLibraryPage() {
  const router = useRouter();
  const [memories, setMemories] = useState<LibraryMemory[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [activeTopic, setActiveTopic] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [retrievalMode, setRetrievalMode] = useState<"vector" | "keyword" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<MemoryRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState("");
  const detailRequest = useRef<AbortController | null>(null);
  const detailDialog = useRef<HTMLDialogElement | null>(null);
  const initialSearchApplied = useRef(false);
  const searchRequestId = useRef(0);

  const loadDetail = useCallback(async (memory: LibraryMemory) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setSelectedId(memory.id);
    setSelectedMemory(memory);
    setDetailError("");
    setDetailLoading(true);
    try {
      const fullRecord = await getMemoryClient(memory.id, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedMemory(fullRecord);
      void recordMemoryAccessClient(memory.id).catch(() => undefined);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setDetailError(loadError instanceof Error ? loadError.message : "详情读取失败");
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (searchMode) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    listMemoriesClient(PAGE_SIZE, page, activeTopic === "all" ? undefined : activeTopic)
      .then((data) => {
        if (cancelled) return;
        setMemories(data.items);
        setTotal(data.total);
        detailRequest.current?.abort();
        setSelectedId(null);
        setSelectedMemory(null);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setMemories([]);
        setTotal(null);
        setError(loadError instanceof Error ? loadError.message : "记忆列表加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTopic, page, reloadToken, searchMode]);

  const runSearch = useCallback(
    async (query: string, topic = "all") => {
      const requestId = ++searchRequestId.current;
      detailRequest.current?.abort();
      setSubmittedQuery(query);
      setSearchMode(true);
      setLoading(true);
      setError("");
      setRetrievalMode(null);
      try {
        const data = await searchMemoriesClient(
          query,
          SEARCH_LIMIT,
          topic === "all" ? undefined : topic,
        );
        if (requestId !== searchRequestId.current) return;
        setMemories(data.results);
        setTotal(data.total);
        setRetrievalMode(data.retrievalMode);
        if (data.results[0]) void loadDetail(data.results[0]);
        else {
          detailRequest.current?.abort();
          setSelectedId(null);
          setSelectedMemory(null);
        }
      } catch (searchError) {
        if (requestId !== searchRequestId.current) return;
        setMemories([]);
        setTotal(null);
        setError(searchError instanceof Error ? searchError.message : "记忆搜索失败");
      } finally {
        if (requestId === searchRequestId.current) setLoading(false);
      }
    },
    [loadDetail],
  );

  useEffect(() => {
    if (initialSearchApplied.current) return;
    initialSearchApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const initialQuery = params.get("q")?.slice(0, 500).trim();
    if (!initialQuery) return;
    const initialTopic = params.get("topic") || "all";
    setActiveTopic(initialTopic);
    setSearchInput(initialQuery);
    void runSearch(initialQuery, initialTopic);
  }, [runSearch]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchInput.trim();
    if (!query) return;
    const topicParam = activeTopic === "all" ? "" : `&topic=${encodeURIComponent(activeTopic)}`;
    router.replace(`/memory?q=${encodeURIComponent(query)}${topicParam}`, { scroll: false });
    void runSearch(query, activeTopic);
  };

  const clearSearch = () => {
    searchRequestId.current += 1;
    detailRequest.current?.abort();
    setSearchInput("");
    setSubmittedQuery("");
    setSearchMode(false);
    setRetrievalMode(null);
    setPage(1);
    setError("");
    router.replace("/memory", { scroll: false });
    setReloadToken((token) => token + 1);
  };

  const handleTopicChange = (topic: string) => {
    setActiveTopic(topic);
    setPage(1);
    if (searchMode) {
      const topicParam = topic === "all" ? "" : `&topic=${encodeURIComponent(topic)}`;
      router.replace(`/memory?q=${encodeURIComponent(submittedQuery)}${topicParam}`, {
        scroll: false,
      });
      void runSearch(submittedQuery, topic);
    } else {
      router.replace("/memory", { scroll: false });
    }
  };

  const handleFullRebuild = async () => {
    if (!window.confirm("将扫描全部现有记忆并加入重建队列，是否继续？")) return;
    setRebuilding(true);
    setRebuildMessage("");
    try {
      const response = await fetch("/api/memory/rebuild", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.error || "重建入队失败");
      setRebuildMessage(data.message || "重建任务已加入队列。");
      setReloadToken((token) => token + 1);
    } catch (rebuildError) {
      setRebuildMessage(rebuildError instanceof Error ? rebuildError.message : "重建入队失败");
    } finally {
      setRebuilding(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));
  const topicOptions = Object.entries(defaultTopicLabels);
  const selectedIndex = memories.findIndex((memory) => memory.id === selectedId);

  return (
    <div className="page-frame memory-library-page">
      <header className="page-heading-row">
        <div>
          <h1>记忆检索库</h1>
          <p>搜索、筛选和阅读已自动入库的记录。</p>
        </div>
        <div className="library-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleFullRebuild()}
            disabled={rebuilding}
          >
            {rebuilding ? "加入队列中…" : "全量扫描重建"}
          </button>
          <Link href="/memory/map" className="text-action-link">
            知识图谱 →
          </Link>
        </div>
      </header>

      <section className="library-controls" aria-label="记忆搜索和筛选">
        <form onSubmit={handleSearch} role="search" className="library-search-form">
          <label className="sr-only" htmlFor="memory-search-input">
            搜索记忆
          </label>
          <input
            id="memory-search-input"
            value={searchInput}
            maxLength={500}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索标题、摘要、正文或标签…"
            className="input"
          />
          <button type="submit" className="btn" disabled={loading && searchMode}>
            {loading && searchMode ? "搜索中…" : "搜索记忆"}
          </button>
          {searchMode ? (
            <button type="button" className="btn-secondary" onClick={clearSearch}>
              返回全部
            </button>
          ) : null}
        </form>
        <label className="topic-filter-label" htmlFor="memory-topic-filter">
          话题
          <select
            id="memory-topic-filter"
            value={activeTopic}
            onChange={(event) => handleTopicChange(event.target.value)}
            className="input"
          >
            <option value="all">全部话题</option>
            {topicOptions.map(([topic, label]) => (
              <option key={topic} value={topic}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {rebuildMessage ? (
        <p className="notice notice-neutral" role="status">
          {rebuildMessage}
        </p>
      ) : null}
      {retrievalMode === "keyword" ? (
        <p className="notice notice-info" role="status">
          Embedding 当前不可用，本次搜索使用关键词匹配。
        </p>
      ) : null}
      {error ? (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              if (searchMode) void runSearch(submittedQuery, activeTopic);
              else setReloadToken((token) => token + 1);
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="library-results-heading">
        <h2>
          {searchMode
            ? "搜索结果"
            : activeTopic === "all"
              ? "全部记忆"
              : getTopicLabelClient(activeTopic)}
        </h2>
        <span>
          {loading
            ? "读取中…"
            : total === null
              ? `— 条${searchMode ? "匹配记录" : "记录"}`
              : `${total} 条${searchMode ? "匹配记录" : "记录"}`}
        </span>
        {!searchMode && totalPages > 1 ? (
          <span>
            第 {page} / {totalPages} 页
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="memory-loading">
          <span className="loading-dots">
            <i />
            <i />
            <i />
          </span>
          <span>正在读取记忆库…</span>
        </div>
      ) : error ? null : memories.length === 0 ? (
        <EmptyState
          title={searchMode ? "没有找到匹配的记忆" : "暂无记忆"}
          description={
            searchMode
              ? "试试更换关键词或话题。"
              : "配置来源或导入内容后，自动入库的记录会显示在这里。"
          }
        />
      ) : !searchMode ? (
        <>
          <div className="memory-library-grid">
            {memories.map((memory) => (
              <button
                className="memory-library-card"
                key={memory.id}
                type="button"
                onClick={() => {
                  void loadDetail(memory);
                  detailDialog.current?.showModal();
                }}
              >
                <span className="memory-library-topic">
                  {memory.topicZh || getTopicLabelClient(memory.topic)}
                </span>
                <strong>{memory.titleZh || memory.title}</strong>
                <span className="memory-library-summary">{memory.summaryZh || memory.summary}</span>
                <span className="memory-library-meta">
                  {memory.source} · {new Date(memory.updatedAt).toLocaleDateString("zh-CN")}
                </span>
              </button>
            ))}
          </div>
          <dialog className="memory-library-dialog" ref={detailDialog} aria-label="记忆详情">
            <div className="memory-library-dialog-head">
              <span>
                {selectedMemory?.topicZh || getTopicLabelClient(selectedMemory?.topic || "")}
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => detailDialog.current?.close()}
              >
                关闭
              </button>
            </div>
            {detailLoading ? <p role="status">正在读取完整记录…</p> : null}
            {detailError ? <p role="status">{detailError}，当前展示列表中的记录内容。</p> : null}
            {selectedMemory ? (
              <>
                <h2>{selectedMemory.titleZh || selectedMemory.title}</h2>
                <p className="memory-library-dialog-summary">
                  {selectedMemory.summaryZh || selectedMemory.summary}
                </p>
                <p className="memory-library-dialog-source">来源：{selectedMemory.source}</p>
                <div className="memory-detail-content">
                  <Markdown
                    content={
                      selectedMemory.content || selectedMemory.summaryZh || selectedMemory.summary
                    }
                  />
                </div>
                <div className="memory-detail-actions">
                  <Link href={memoryDetailHref(selectedMemory.id)} className="text-action-link">
                    打开完整记录 →
                  </Link>
                </div>
              </>
            ) : null}
          </dialog>
        </>
      ) : (
        <div className="memory-split-layout">
          <aside
            className="memory-record-list"
            role="tablist"
            aria-label="记忆记录"
            aria-orientation="vertical"
          >
            {memories.map((memory, index) => {
              const title = memory.titleZh || memory.title;
              const summary = memory.summaryZh || memory.summary;
              return (
                <button
                  className="memory-record-card"
                  key={memory.id}
                  type="button"
                  id={`memory-tab-${index}`}
                  role="tab"
                  aria-controls="memory-detail-panel"
                  aria-selected={memory.id === selectedId}
                  tabIndex={memory.id === selectedId ? 0 : -1}
                  onClick={() => void loadDetail(memory)}
                  onKeyDown={(event) => {
                    let nextIndex = index;
                    if (event.key === "ArrowDown" || event.key === "ArrowRight")
                      nextIndex = (index + 1) % memories.length;
                    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
                      nextIndex = (index - 1 + memories.length) % memories.length;
                    else if (event.key === "Home") nextIndex = 0;
                    else if (event.key === "End") nextIndex = memories.length - 1;
                    else return;
                    event.preventDefault();
                    void loadDetail(memories[nextIndex]);
                    requestAnimationFrame(() =>
                      document.getElementById(`memory-tab-${nextIndex}`)?.focus(),
                    );
                  }}
                >
                  <span className="memory-record-topline">
                    <span>{memory.topicZh || getTopicLabelClient(memory.topic)}</span>
                    {memory.score !== undefined ? (
                      <span>{Math.round(memory.score * 100)}%</span>
                    ) : null}
                  </span>
                  <strong>{title}</strong>
                  <span className="memory-record-summary">{summary}</span>
                  <span className="memory-record-meta">
                    {memory.source} · {new Date(memory.updatedAt).toLocaleDateString("zh-CN")}
                  </span>
                  <span className="sr-only">第 {index + 1} 条记录</span>
                </button>
              );
            })}
          </aside>

          <section
            id="memory-detail-panel"
            className="memory-detail-pane"
            role="tabpanel"
            aria-labelledby={selectedIndex >= 0 ? `memory-tab-${selectedIndex}` : undefined}
            aria-label="所选记忆详情"
            aria-live="polite"
            tabIndex={0}
          >
            {selectedMemory ? (
              <>
                <div className="detail-kicker">
                  <span>{selectedMemory.topicZh || getTopicLabelClient(selectedMemory.topic)}</span>
                  <span>
                    {selectedIndex >= 0 ? `${selectedIndex + 1} / ${memories.length}` : ""}
                  </span>
                </div>
                {detailLoading ? <p className="detail-loading">正在读取完整记录…</p> : null}
                {detailError ? (
                  <p className="detail-load-error" role="status">
                    {detailError}，当前展示列表中的记录内容。
                  </p>
                ) : null}
                <h2>{selectedMemory.titleZh || selectedMemory.title}</h2>
                <p className="memory-detail-summary">
                  {selectedMemory.summaryZh || selectedMemory.summary}
                </p>
                <div className="memory-detail-content">
                  <Markdown
                    content={
                      selectedMemory.content || selectedMemory.summaryZh || selectedMemory.summary
                    }
                  />
                </div>
                {selectedMemory.tagsZh?.length || selectedMemory.tags.length ? (
                  <div className="memory-detail-tags">
                    {(selectedMemory.tagsZh?.length
                      ? selectedMemory.tagsZh
                      : selectedMemory.tags
                    ).map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <dl className="memory-detail-meta">
                  <div>
                    <dt>来源</dt>
                    <dd>{selectedMemory.source}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{new Date(selectedMemory.updatedAt).toLocaleString("zh-CN")}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>{selectedMemory.version}</dd>
                  </div>
                </dl>
                {selectedMemory.graphLinks.length ? (
                  <div className="memory-related-links">
                    <span>关联记录</span>
                    {selectedMemory.graphLinks.map((id) => (
                      <Link key={id} href={memoryDetailHref(id)}>
                        {id}
                      </Link>
                    ))}
                  </div>
                ) : null}
                <div className="memory-detail-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={selectedIndex <= 0}
                    onClick={() => void loadDetail(memories[selectedIndex - 1])}
                  >
                    ← 上一条
                  </button>
                  <Link href={memoryTopicHref(selectedMemory.topic)} className="text-action-link">
                    打开主题资料
                  </Link>
                  <Link href={memoryDetailHref(selectedMemory.id)} className="text-action-link">
                    完整记录 →
                  </Link>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={selectedIndex < 0 || selectedIndex >= memories.length - 1}
                    onClick={() => void loadDetail(memories[selectedIndex + 1])}
                  >
                    下一条 →
                  </button>
                </div>
              </>
            ) : (
              <p className="empty-inline">选择左侧记录查看详情。</p>
            )}
          </section>
        </div>
      )}

      {!searchMode && totalPages > 1 ? (
        <nav className="pagination" aria-label="记忆列表分页">
          <button
            type="button"
            className="btn-secondary"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </button>
          <span>
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            下一页
          </button>
        </nav>
      ) : null}
    </div>
  );
}
