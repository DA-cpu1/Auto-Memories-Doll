"use client";

import React, { useEffect, useState } from "react";
import type { ModelHealth, ModelFailure } from "@/types/model-health";

const SLOT_LABELS = {
  budget: "廉价模型",
  standard: "普通模型",
  flagship: "旗舰模型",
  embedding: "向量模型",
};
const REASON_LABELS: Record<ModelFailure["reason"], string> = {
  NOT_CONFIGURED: "未配置模型或密钥",
  DISABLED: "已关闭",
  AUTH_FAILED: "认证或权限失败",
  TIMEOUT: "调用超时",
  RATE_LIMITED: "请求被限流",
  REQUEST_FAILED: "请求失败",
  INVALID_OUTPUT: "返回格式不符合要求",
  OUTPUT_TRUNCATED: "模型输出被截断",
};

/**
 * 全局降级状态 Banner。
 * 每 30 秒轮询 /api/health，当 AI API 处于降级模式时在页面顶部显示持久提示。
 * 只展示当前服务状态，不从历史任务或浏览器缓存推断当前故障。
 */
export default function DegradationBanner() {
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    const checkHealth = async () => {
      try {
        const res = await fetch("/api/health", { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error("Health request failed");
        const data = (await res.json()) as ModelHealth;
        if (!active) return;
        setHealth(data);
        setStale(false);
      } catch {
        if (active) setStale(true);
      }
    };

    checkHealth();
    const timer = setInterval(checkHealth, 30000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return <ModelHealthNotice health={health} stale={stale} />;
}

export function ModelHealthNotice({
  health,
  stale = false,
}: {
  health: ModelHealth | null;
  stale?: boolean;
}) {
  const capabilities = health?.degradedCapabilities ?? [];
  if (!stale && capabilities.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="模型状态"
      aria-live="polite"
      className="sticky top-0 z-50 w-full border-b border-warning-bg bg-warning-bg/95"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-warning">
            {stale ? "模型状态暂时无法更新" : "部分模型能力处于降级模式"}
          </p>
          <p className="text-xs text-warning/80 leading-relaxed">
            {stale ? "以下为上次获取的状态，请检查本地服务是否正常。" : ""}
            {capabilities.includes("llm")
              ? "部分 AI 加工异常；整理失败时会保存已采集的有效文本。"
              : ""}
            {capabilities.includes("embedding") ? " 语义检索不可用，关键词检索继续运行。" : ""}
          </p>
          {(health?.failures ?? []).map((failure) => (
            <p key={failure.slot} className="mt-1 break-words text-xs text-warning/80">
              {SLOT_LABELS[failure.slot]} · {failure.model || "未配置"}：
              {REASON_LABELS[failure.reason] || failure.reason}
              {failure.purpose
                ? `（${failure.purpose === "health-check" ? "恢复检查" : "后台加工"}）`
                : ""}
              {failure.durationMs !== undefined
                ? `，耗时 ${(failure.durationMs / 1000).toFixed(1)} 秒`
                : ""}
              {failure.failedAt
                ? `；发生于 ${new Date(failure.failedAt).toLocaleString("zh-CN")}`
                : ""}
              {failure.retryAt ? "；等待自动重试或确认恢复" : ""}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
