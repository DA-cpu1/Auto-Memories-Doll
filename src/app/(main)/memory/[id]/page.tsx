"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import Markdown from "@/components/common/Markdown";
import { getTopicLabelClient } from "@/config/topics-data";
import {
  getMemoryClient,
  memoryDetailHref,
  memoryTopicHref,
  recordMemoryAccessClient,
} from "@/lib/memory-api-client";
import type { MemoryRecord } from "@/types/memory";

export default function MemoryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const memoryId = params.id;
  const [memory, setMemory] = useState<MemoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function loadMemory() {
      setLoading(true);
      setError("");
      try {
        const loaded = await getMemoryClient(memoryId, controller.signal);
        setMemory(loaded);
        void recordMemoryAccessClient(memoryId).catch(() => undefined);
      } catch (loadError) {
        if (!controller.signal.aborted)
          setError(loadError instanceof Error ? loadError.message : "记忆加载失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadMemory();
    return () => controller.abort();
  }, [memoryId]);

  const handleDelete = useCallback(async () => {
    if (!memory || !confirm(`确定要删除“${memory.titleZh || memory.title}”吗？`)) return;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memory.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`);
      router.push("/memory");
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }, [memory, router]);

  if (loading) {
    return (
      <div className="memory-detail-state">
        <span className="loading-dots">
          <i />
          <i />
          <i />
        </span>
        <p>正在加载记忆…</p>
      </div>
    );
  }
  if (!memory) {
    return (
      <div className="memory-detail-state">
        <h1>记忆不存在</h1>
        <p>{error || "没有找到对应的记忆内容。"}</p>
        <Link href="/memory" className="btn-secondary">
          返回检索库
        </Link>
      </div>
    );
  }

  const tags = memory.tagsZh?.length ? memory.tagsZh : memory.tags;
  return (
    <div className="page-frame memory-detail-page">
      <nav className="topic-breadcrumb" aria-label="面包屑">
        <Link href="/">首页</Link>
        <span aria-hidden="true">/</span>
        <Link href="/memory">检索库</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">记录详情</span>
      </nav>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <article className="record-document">
        <header className="record-document-heading">
          <div>
            <Link className="record-topic-link" href={memoryTopicHref(memory.topic)}>
              {memory.topicZh || getTopicLabelClient(memory.topic)}
            </Link>
            <h1>{memory.titleZh || memory.title}</h1>
            <p>{memory.summaryZh || memory.summary}</p>
          </div>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? "删除中…" : "删除记忆"}
          </button>
        </header>
        {tags.length ? (
          <div className="memory-detail-tags">
            {tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        <section className="record-document-content" aria-labelledby="memory-content-title">
          <h2 id="memory-content-title">完整内容</h2>
          <Markdown
            content={memory.content || memory.summaryZh || memory.summary || "（暂无详细内容）"}
          />
        </section>
        <section className="record-document-info" aria-labelledby="memory-meta-title">
          <h2 id="memory-meta-title">记录信息</h2>
          <dl>
            <div>
              <dt>记忆 ID</dt>
              <dd className="mono-value">{memory.id}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{memory.source}</dd>
            </div>
            <div>
              <dt>来源类型</dt>
              <dd>{memory.sourceType === "listen" ? "监听导入" : memory.sourceType}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{memory.version}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{new Date(memory.createdAt).toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{new Date(memory.updatedAt).toLocaleString("zh-CN")}</dd>
            </div>
          </dl>
        </section>
        {memory.graphLinks.length ? (
          <section className="record-related" aria-label="关联记忆">
            <h2>关联记忆</h2>
            <div>
              {memory.graphLinks.map((linkedId) => (
                <Link key={linkedId} href={memoryDetailHref(linkedId)}>
                  {linkedId}
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </article>
    </div>
  );
}
