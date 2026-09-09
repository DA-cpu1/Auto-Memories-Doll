"use client";

import { useCallback, useEffect, useState } from "react";
import type { PendingEvent } from "../../types/memory";

type Waiting = { eventId: string; title: string; dependency?: PendingEvent["dependency"] };
type Batch = {
  id: string;
  status: string;
  items: Array<{ eventId: string; reason: string; status: string }>;
};
const reasonLabels: Record<string, string> = {
  ELIGIBLE: "可重新处理的旧向量故障",
  VECTOR_RECALL_UNAVAILABLE: "旧向量故障，已提交重新处理",
  NOT_VECTOR_ONLY_REVIEW: "其他审核原因，保留人工审核",
  EDITED_OR_UNPROVEN: "已编辑或历史记录不足",
  MISSING_SOURCE_EVIDENCE: "缺少来源版本证据",
  SOURCE_REMOVED: "来源已移除",
  KA002_EVIDENCE_REQUIRED: "缺少最终对话筛选记录",
  CONTENT_CONFLICT: "存在内容冲突",
  SOURCE_DISABLED: "来源已停用，未选择",
  SELECTED_DISABLED: "已选择的停用来源候选",
  CHANGED_SINCE_PREVIEW: "预览后发生变更，已跳过",
};
const batchLabels: Record<string, string> = {
  preview: "等待确认",
  running: "正在提交重新处理",
  paused: "批次已暂停",
  done: "批次提交完成",
};

export default function DependencyPanel({
  onQueueChanged,
}: {
  onQueueChanged?: () => Promise<void>;
}) {
  const [items, setItems] = useState<Waiting[]>([]);
  const [vectorStates, setVectorStates] = useState<Record<string, number>>({});
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/audit/dependencies", { cache: "no-store" });
      if (!response.ok) throw new Error("恢复数据读取失败");
      const data = await response.json();
      setItems(data.items);
      setVectorStates(data.vectorStates ?? {});
      setBatch(data.latestBatch ?? null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (batch?.status !== "running") return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        await load();
        await onQueueChanged?.();
      } finally {
        polling = false;
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [batch?.status, load, onQueueChanged]);

  async function act(command: Record<string, string | boolean>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/audit/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error("操作失败，请刷新后重试");
      const result = await response.json();
      if (result.id) setBatch(result);
      if (result.success === false) setError("模型尚不可用，请检查对应模型设置后重试");
      await load();
      if (command.action === "execute" || command.action === "retry") await onQueueChanged?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pending = batch?.items.filter((item) => item.status === "pending").length ?? 0;
  const queued = batch?.items.filter((item) => item.status === "queued").length ?? 0;
  const skipped = batch?.items.filter((item) => item.status === "skipped").length ?? 0;
  return (
    <section className="mb-7 border-b border-border pb-6" aria-labelledby="recovery-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="recovery-heading" className="text-lg font-semibold text-text-primary">
          服务故障候选重处理
        </h2>
        {batch ? (
          <p role="status" className="text-sm text-text-secondary">
            {batchLabels[batch.status] ?? batch.status}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="py-2 text-red-700">
          {error}
        </p>
      ) : null}
      {batch ? (
        <p className="my-3 text-sm text-text-secondary">
          可重新处理 <strong className="text-text-primary">{pending}</strong> 条 · 已提交 {queued}{" "}
          条 · 跳过 {skipped} 条
        </p>
      ) : (
        <p className="my-3 text-sm text-text-secondary">
          {loading ? "正在读取已保存的预览…" : "尚无预览结果"}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {batch && pending > 0 && batch.status !== "running" ? (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || loading}
            onClick={() => void act({ action: "execute", batchId: batch.id })}
          >
            {busy
              ? "正在提交…"
              : batch.status === "paused"
                ? `继续重新处理 ${pending} 条`
                : `确认重新处理 ${pending} 条`}
          </button>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || loading || batch?.status === "running"}
          onClick={() => void act({ action: "preview", includeDisabled })}
        >
          {batch ? "重新预览" : "预览旧服务故障候选"}
        </button>
        {batch?.status === "running" ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void act({ action: "pause", batchId: batch.id })}
          >
            暂停批次
          </button>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || loading}
          onClick={() => void load()}
        >
          刷新恢复状态
        </button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={includeDisabled}
          disabled={busy || batch?.status === "running"}
          onChange={(event) => {
            setIncludeDisabled(event.target.checked);
            setBatch(null);
          }}
        />
        包含已停用来源的现有候选
      </label>
      {batch ? (
        <details className="mt-3 text-sm text-text-secondary">
          <summary className="cursor-pointer">预览明细</summary>
          <ul className="mt-2 space-y-1">
            {[...new Set(batch.items.map((item) => item.reason))].map((reason) => (
              <li key={reason}>
                {reasonLabels[reason] ?? reason}：
                {batch.items.filter((item) => item.reason === reason).length} 条
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-primary">等待模型服务 ({items.length})</h2>
        <a href="/settings/ai" className="text-sm underline">
          模型设置
        </a>
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">暂无等待候选</p>
      ) : (
        <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-border">
          {items.map((item) => (
            <li key={item.eventId} className="py-3 text-sm">
              <p className="break-words font-medium">{item.title}</p>
              <p>
                {item.dependency?.slot} / {item.dependency?.stage} / {item.dependency?.reason}
              </p>
              <p className="break-words">
                上次尝试：{item.dependency?.lastAttemptAt}；
                {item.dependency?.paused
                  ? "自动重试已暂停"
                  : `下次重试：${item.dependency?.nextAttemptAt ?? "待调度"}`}
              </p>
              <button
                type="button"
                className="mt-2 underline disabled:opacity-50"
                disabled={busy || item.dependency?.reason === "NOT_CONFIGURED"}
                onClick={() => void act({ action: "retry", eventId: item.eventId })}
              >
                重试此候选
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-tertiary">
        已发布知识的向量索引：已完成 {vectorStates.ready ?? 0}；待生成 {vectorStates.pending ?? 0}
        ；失败 {vectorStates.failed ?? 0}；已关闭 {vectorStates.disabled ?? 0}
      </p>
    </section>
  );
}
