"use client";

import { useEffect, useState } from "react";

/**
 * 全局降级状态 Banner。
 * 每 30 秒轮询 /api/health，当 AI API 处于降级模式时在页面顶部显示持久提示。
 * 降级状态会同步到 localStorage，刷新页面后仍能保持提示直到恢复。
 */
export default function DegradationBanner() {
  const [capabilities, setCapabilities] = useState<string[]>([]);

  useEffect(() => {
    // 初始从 localStorage 恢复
    const stored = localStorage.getItem("amd:degraded");
    if (stored === "true") setCapabilities(["llm", "embedding"]);

    let active = true;

    const checkHealth = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;
        setCapabilities(
          Array.isArray(data.degradedCapabilities)
            ? data.degradedCapabilities
            : data.degraded
              ? ["llm", "embedding"]
              : [],
        );
        localStorage.setItem("amd:degraded", data.degraded ? "true" : "false");
      } catch {
        // 接口不可用时不强制设置降级，避免误报
      }
    };

    checkHealth();
    const timer = setInterval(checkHealth, 30000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (capabilities.length === 0) return null;

  return (
    <div className="sticky top-0 z-50 w-full border-b border-warning-bg bg-warning-bg/95">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-warning">部分模型能力处于降级模式</p>
          <p className="text-xs text-warning/80 leading-relaxed">
            {capabilities.includes("llm") ? "LLM 不可用：依赖模型的候选将进入人工审核。" : ""}
            {capabilities.includes("embedding")
              ? " Embedding 不可用：检索自动切换为关键词匹配。"
              : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
