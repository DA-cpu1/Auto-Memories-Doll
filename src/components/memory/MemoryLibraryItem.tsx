"use client";

import Link from "next/link";
import React from "react";
import MemoryCard from "@/components/memory/MemoryCard";
import { memoryDetailHref, memoryTopicHref } from "@/lib/memory-api-client";
import { getTopicLabelClient } from "@/config/topics-data";
import type { MemoryRecord } from "@/types/memory";
import type { MemorySearchResult } from "@/types/api";

type DisplayMemory = MemoryRecord & Partial<Pick<MemorySearchResult, "score" | "channels">>;

const CHANNEL_LABELS = { vector: "向量", keyword: "关键词", tag: "标签", graph: "图谱" } as const;

export default function MemoryLibraryItem({ memory }: { memory: DisplayMemory }) {
  return (
    <article className="group flex h-full flex-col">
      <Link
        href={memoryDetailHref(memory.id)}
        className="block h-full rounded-2xl focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
        aria-label={`查看记忆：${memory.titleZh || memory.title}`}
      >
        <MemoryCard
          memory={memory}
          className="h-full transition-transform duration-200 group-hover:-translate-y-0.5"
        />
      </Link>
      <div className="flex items-center justify-between gap-3 px-1 pt-3 text-xs text-text-tertiary">
        <Link href={memoryTopicHref(memory.topic)} className="truncate hover:text-accent">
          话题：{memory.topicZh || getTopicLabelClient(memory.topic)}
        </Link>
        <Link href={memoryDetailHref(memory.id)} className="shrink-0 font-medium hover:text-accent">
          查看详情 →
        </Link>
      </div>
      {memory.score !== undefined ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-xs text-text-tertiary">
          <span className="font-mono font-semibold text-accent">
            {Math.round(memory.score * 100)}%
          </span>
          <span aria-hidden="true">·</span>
          <span>来源 {memory.source}</span>
          {memory.channels?.map((channel) => (
            <span key={channel} className="tag">
              {CHANNEL_LABELS[channel]}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
