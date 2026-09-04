"use client";

import { useCallback, useEffect, useState } from "react";
import { ToolWatchSource, ToolType } from "@/types/config";
import ToolSourceList from "@/components/settings/ToolSourceList";

const API_BASE = "/api/config";

type Preset = { name: string; toolType: ToolType; path: string; filePattern: string };

type WatchStatus = {
  fileWatcher: { running: boolean; root: string };
  toolWatcher: {
    configured: number;
    running: number;
    sources: { id: string; name: string; toolType: string; path: string }[];
  };
  events: { pending: number; review: number; failed: number };
};

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
        ok ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
      {label}
    </span>
  );
}

export default function ToolSourcesPage() {
  const [sources, setSources] = useState<ToolWatchSource[]>([]);
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");

  const refresh = useCallback(() => {
    fetch(`${API_BASE}/tool-sources`)
      .then((r) => r.json())
      .then((d) => {
        setSources(d.sources || []);
        setPresets(d.presets || {});
      })
      .catch(() => {});
    fetch(`${API_BASE}/tool-sources/status`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.title = "来源设置 | Auto-Memories-Doll";
    refresh();
  }, [refresh]);

  const scanSources = async () => {
    setScanning(true);
    setScanMessage("");
    try {
      const response = await fetch("/api/listen/scan", { method: "POST" });
      const payload = await response.json();
      setScanMessage(payload.message || (response.ok ? "扫描完成" : "扫描失败"));
      refresh();
    } catch {
      setScanMessage("扫描失败，请检查服务状态");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 py-8 sm:p-6 md:py-10">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 font-mono text-xs font-semibold uppercase text-text-tertiary">
            Source registry
          </p>
          <h1 className="text-3xl font-bold text-text-primary">来源设置</h1>
          <p className="mt-2 text-sm text-text-secondary">管理本地目录与开发工具会话的采集入口。</p>
        </div>
        <button
          type="button"
          className="btn self-start"
          onClick={() => void scanSources()}
          disabled={scanning}
        >
          {scanning ? "扫描中…" : "扫描所有来源"}
        </button>
      </header>
      {scanMessage ? (
        <p
          role="status"
          className="border-l-2 border-accent bg-accent-soft px-4 py-3 text-sm text-text-secondary"
        >
          {scanMessage}
        </p>
      ) : null}
      <section className="rounded-lg border border-border bg-surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-1">运行状态</h2>
        <p className="text-xs text-text-tertiary mb-4">
          监听器与采集队列的实时情况（配置变更后自动刷新）
        </p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-text-secondary">文件监听</p>
              <p className="text-xs text-text-tertiary font-mono break-all">
                {status?.fileWatcher.root || "—"}
              </p>
            </div>
            <StatusBadge
              ok={!!status?.fileWatcher.running}
              label={status?.fileWatcher.running ? "运行中" : "未运行"}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-text-secondary">工具目录监听</p>
              <p className="text-xs text-text-tertiary">
                {status
                  ? status.toolWatcher.running > 0
                    ? `${status.toolWatcher.running} 个源监听中`
                    : status.toolWatcher.configured > 0
                      ? "已配置但未运行，重启服务后生效"
                      : "尚未配置监听源"
                  : "—"}
              </p>
            </div>
            <StatusBadge
              ok={(status?.toolWatcher.running ?? 0) > 0}
              label={
                status
                  ? `${status.toolWatcher.running} / ${status.toolWatcher.configured} 活跃`
                  : "—"
              }
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-text-secondary">采集队列</p>
              <p className="text-xs text-text-tertiary">
                待处理 {status?.events.pending ?? 0} · 失败 {status?.events.failed ?? 0}
                {(status?.events.review ?? 0) > 0 && (
                  <>
                    {" · "}
                    <a href="/audit" className="text-accent hover:underline">
                      {status?.events.review} 条待人工裁决，去审计页处理 →
                    </a>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-1">监听源</h2>
        <p className="text-xs text-text-tertiary mb-6">
          新增、编辑、停用或移除来源；变更后监听器会自动重启。
        </p>
        <ToolSourceList sources={sources} presets={presets} onChange={refresh} />
      </section>
    </div>
  );
}
