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
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <nav
        aria-label="面包屑"
        className="mb-6 flex flex-wrap items-center gap-2 text-sm text-text-tertiary"
      >
        <Link href="/memory" className="hover:text-accent">
          检索库
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{guide.title}</span>
      </nav>
      <header className="border-b border-border pb-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="mb-2 font-mono text-xs font-semibold uppercase text-text-tertiary">
              Topic dossier
            </p>
            <h1 className="break-words text-3xl font-bold text-text-primary sm:text-4xl">
              {guide.title}
            </h1>
            <p className="mt-3 text-sm text-text-secondary">
              {guide.sections.length} 个章节 · {guide.memoryIds.length} 条知识 ·{" "}
              {guide.sourceVersions.length} 个来源版本
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <span className="status-tag status-tag--success self-center">
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

      <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <h2 className="mb-3 text-xs font-semibold uppercase text-text-tertiary">大纲</h2>
          <nav aria-label="主题资料大纲" className="border-l border-border">
            {guide.outline.map((item, index) => (
              <a
                key={item.sectionId}
                href={`#${item.sectionId}`}
                className="block border-l-2 border-transparent px-4 py-2 text-sm text-text-secondary hover:border-accent hover:text-accent"
              >
                <span className="mr-2 font-mono text-xs text-text-tertiary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {item.title}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <div className="divide-y divide-border border-y border-border">
            {guide.sections.map((section, index) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-24 py-8 first:pt-0 sm:py-10"
              >
                <div className="mb-5 flex items-baseline gap-3">
                  <span className="font-mono text-xs font-semibold text-accent">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h2 className="text-xl font-bold text-text-primary sm:text-2xl">
                    {section.title}
                  </h2>
                </div>
                <div className="prose max-w-none break-words text-text-secondary">
                  <Markdown content={section.content} />
                </div>
                <div className="mt-6 border-l-2 border-accent-line pl-4">
                  <p className="mb-2 text-xs font-semibold text-text-tertiary">本节依据</p>
                  <div className="flex flex-wrap gap-2">
                    {section.memoryIds.map((memoryId) => {
                      const memory = memoryById.get(memoryId);
                      return (
                        <Link
                          key={memoryId}
                          href={memoryDetailHref(memoryId)}
                          className="tag max-w-full hover:border-accent hover:text-accent"
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

          <section aria-labelledby="sources-heading" className="mt-10">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-1 font-mono text-xs uppercase text-text-tertiary">
                  Provenance ledger
                </p>
                <h2 id="sources-heading" className="text-xl font-bold text-text-primary">
                  来源版本
                </h2>
              </div>
              <time className="text-xs text-text-tertiary" dateTime={guide.generatedAt}>
                生成于 {new Date(guide.generatedAt).toLocaleString("zh-CN")}
              </time>
            </div>
            <div className="overflow-x-auto border-y border-border">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-muted text-xs text-text-tertiary">
                  <tr>
                    <th className="px-3 py-3 font-medium">来源</th>
                    <th className="px-3 py-3 font-medium">类型</th>
                    <th className="px-3 py-3 font-medium">版本</th>
                    <th className="px-3 py-3 font-medium">采集时间</th>
                    <th className="px-3 py-3 font-medium">知识数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {guide.sourceVersions.map((source) => (
                    <tr key={`${source.sourceId}:${source.revision}`}>
                      <td className="max-w-[280px] break-all px-3 py-3 text-text-primary">
                        {source.sourcePath || source.sourceId}
                      </td>
                      <td className="px-3 py-3 text-text-secondary">{source.sourceType}</td>
                      <td className="px-3 py-3 font-mono text-xs text-text-secondary">
                        {source.revision.slice(0, 12)}
                      </td>
                      <td className="px-3 py-3 text-text-secondary">
                        {new Date(source.capturedAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="px-3 py-3 font-mono text-text-secondary">
                        {source.memoryIds.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
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
    <main className="mx-auto flex min-h-[65vh] max-w-xl flex-col items-center justify-center px-5 text-center">
      <p className="mb-3 font-mono text-xs font-semibold uppercase text-text-tertiary">
        Topic dossier
      </p>
      <h1 className="text-2xl font-bold text-text-primary">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-text-secondary">{detail}</p>
      {children ? <div className="mt-6 space-y-3">{children}</div> : null}
    </main>
  );
}
