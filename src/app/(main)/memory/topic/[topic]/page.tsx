"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "@/components/common/Markdown";
import { getTopicLabelClient } from "@/config/topics-data";
import { listMemoriesClient, memoryDetailHref } from "@/lib/memory-api-client";
import type { ApiResponse } from "@/lib/api-response";
import type { MemoryRecord } from "@/types/memory";
import type { StudyGuide } from "@/types/study-guide";

type LoadState = "loading" | "ready" | "missing" | "error";

export default function TopicGuidePage() {
  const topic = useParams().topic as string;
  const [guide, setGuide] = useState<StudyGuide | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);

  const loadGuide = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      const [guideResponse, memoryResponse] = await Promise.all([
        fetch(`/api/topics/${encodeURIComponent(topic)}`),
        listMemoriesClient(100, 1, topic),
      ]);
      setMemories(memoryResponse.items);
      if (guideResponse.status === 404) {
        setGuide(null);
        setState("missing");
        return;
      }
      const payload = (await guideResponse.json()) as ApiResponse<StudyGuide>;
      if (!guideResponse.ok || !payload.success) {
        throw new Error(payload.success ? "主题资料加载失败" : payload.error.message);
      }
      setGuide(payload.data);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "主题资料加载失败");
      setState("error");
    }
  }, [topic]);

  useEffect(() => void loadGuide(), [loadGuide]);

  const memoryById = useMemo(
    () => new Map(memories.map((memory) => [memory.id, memory])),
    [memories],
  );

  const generateGuide = async () => {
    setGenerating(true);
    setMessage("");
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelAssist: false, force: true }),
      });
      const payload = (await response.json()) as ApiResponse<StudyGuide>;
      if (!response.ok || !payload.success) {
        throw new Error(payload.success ? "主题资料生成失败" : payload.error.message);
      }
      setGuide(payload.data);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "主题资料生成失败");
    } finally {
      setGenerating(false);
    }
  };

  if (state === "loading") {
    return <PageNotice title="正在整理主题资料" detail="读取大纲、知识引用与来源版本…" />;
  }
  if (state === "error") {
    return (
      <PageNotice title="主题资料暂时无法读取" detail={message}>
        <button type="button" className="btn" onClick={() => void loadGuide()}>
          重新加载
        </button>
      </PageNotice>
    );
  }
  if (state === "missing" || !guide) {
    return (
      <PageNotice
        title={`${getTopicLabelClient(topic)}尚未生成学习资料`}
        detail={
          memories.length > 0
            ? `已有 ${memories.length} 条已发布知识，可以据此生成确定性资料。`
            : "该主题暂时没有可用于生成资料的已发布知识。"
        }
      >
        {message ? (
          <p role="alert" className="text-sm text-error">
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/memory" className="btn-secondary">
            返回检索库
          </Link>
          <button
            type="button"
            className="btn"
            disabled={generating || memories.length === 0}
            onClick={() => void generateGuide()}
          >
            {generating ? "生成中…" : "生成主题资料"}
          </button>
        </div>
      </PageNotice>
    );
  }

  return (
    <div className="page-frame topic-page">
      <nav aria-label="面包屑" className="topic-breadcrumb">
        <Link href="/memory" className="hover:text-accent">
          检索库
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{guide.title}</span>
      </nav>
      <header className="topic-heading">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words">{guide.title}</h1>
            <p className="topic-counts">
              {guide.sections.length} 个章节 · {guide.memoryIds.length} 条知识 ·{" "}
              {guide.sourceVersions.length} 个来源版本
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <span className="status-tag status-tag--loading self-center">
              {guide.modelAssisted ? "模型辅助编排" : "确定性编排"}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={generating}
              onClick={() => void generateGuide()}
            >
              {generating ? "刷新中…" : "刷新资料"}
            </button>
          </div>
        </div>
      </header>

      <div className="topic-layout">
        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <h2 className="topic-outline-title">大纲</h2>
          <nav aria-label="主题资料大纲" className="topic-outline">
            {guide.outline.map((item, index) => (
              <a key={item.sectionId} href={`#${item.sectionId}`} className="topic-outline-link">
                <span className="topic-outline-number">{String(index + 1).padStart(2, "0")}</span>
                {item.title}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          <div className="topic-sections">
            {guide.sections.map((section, index) => (
              <section key={section.id} id={section.id} className="topic-section scroll-mt-24">
                <div className="topic-section-heading">
                  <span className="topic-section-number">{String(index + 1).padStart(2, "0")}</span>
                  <h2>{section.title}</h2>
                </div>
                <div className="topic-prose break-words">
                  <Markdown content={section.content} />
                </div>
                <div className="topic-evidence">
                  <p>本节依据</p>
                  <div className="flex flex-wrap gap-2">
                    {section.memoryIds.map((memoryId) => {
                      const memory = memoryById.get(memoryId);
                      return (
                        <Link
                          key={memoryId}
                          href={memoryDetailHref(memoryId)}
                          className="tag max-w-full"
                        >
                          <span className="truncate">
                            {memory?.titleZh || memory?.title || memoryId}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </section>
            ))}
          </div>

          <section aria-labelledby="sources-heading" className="topic-sources">
            <div className="topic-sources-heading">
              <div>
                <h2 id="sources-heading">来源版本</h2>
              </div>
              <time dateTime={guide.generatedAt}>
                生成于 {new Date(guide.generatedAt).toLocaleString("zh-CN")}
              </time>
            </div>
            <div className="table-scroll">
              <table className="status-table topic-source-table">
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>类型</th>
                    <th>版本</th>
                    <th>采集时间</th>
                    <th>知识数</th>
                  </tr>
                </thead>
                <tbody>
                  {guide.sourceVersions.map((source) => (
                    <tr key={`${source.sourceId}:${source.revision}`}>
                      <td className="max-w-[280px] break-all">
                        {source.sourcePath || source.sourceId}
                      </td>
                      <td>{source.sourceType}</td>
                      <td className="revision-cell">{source.revision.slice(0, 12)}</td>
                      <td>{new Date(source.capturedAt).toLocaleString("zh-CN")}</td>
                      <td className="revision-cell">{source.memoryIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PageNotice({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="topic-page-notice">
      <h1>{title}</h1>
      <p>{detail}</p>
      {children ? <div className="mt-6 space-y-3">{children}</div> : null}
    </div>
  );
}
