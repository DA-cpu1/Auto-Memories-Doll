"use client";

import { useCallback, useEffect, useState } from "react";
import { ToolWatchSource, ToolType } from "@/types/config";
import ToolSourceList from "@/components/settings/ToolSourceList";

const API_BASE = "/api/config";

type Preset = { name: string; toolType: ToolType; path: string; filePattern: string };

type WatchStatus = {
  fileWatcher?: { running?: boolean; root?: string };
  toolWatcher: {
    configured?: number;
    running?: number;
    sources: { id: string; name: string; toolType: string; path: string }[];
  };
  events?: { pending?: number; processing?: number; done?: number; failed?: number };
};

function StatusBadge({
  state,
  label,
}: {
  state: "running" | "stopped" | "unknown";
  label: string;
}) {
  return (
    <span className={`source-status-badge source-status-${state}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export default function ToolSourcesPage() {
  const [sources, setSources] = useState<ToolWatchSource[] | null>(null);
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");

  const refresh = useCallback(() => {
    fetch(`${API_BASE}/tool-sources`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        setSources(data.sources);
        setPresets(data.presets);
        setSourceError("");
      })
      .catch((error: unknown) =>
        setSourceError(error instanceof Error ? error.message : "来源配置读取失败"),
      );
    fetch(`${API_BASE}/tool-sources/status`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        setStatus(data);
        setStatusError("");
      })
      .catch((error: unknown) => {
        setStatus(null);
        setStatusError(error instanceof Error ? error.message : "监听状态读取失败");
      });
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
      if (!response.ok) throw new Error(payload.error?.message || payload.error || "扫描失败");
      setScanMessage(payload.message || "扫描已完成。");
      refresh();
    } catch (error) {
      setScanMessage(error instanceof Error ? error.message : "扫描失败，请检查服务状态");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="settings-page">
      <header className="settings-page-heading settings-page-heading-actions">
        <div>
          <h1>来源监听</h1>
          <p>管理本地目录与开发工具会话的采集入口。</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => void scanSources()}
          disabled={scanning}
        >
          {scanning ? "扫描中…" : "扫描所有来源"}
        </button>
      </header>
      {scanMessage ? (
        <p role="status" className="notice notice-neutral">
          {scanMessage}
        </p>
      ) : null}
      <section className="settings-section">
        <h2>运行状态</h2>
        <p className="section-note">监听器与采集队列的实时情况。来源变更后会自动刷新。</p>
        {statusError ? (
          <p className="notice notice-warning" role="status">
            状态暂不可用：{statusError}
          </p>
        ) : null}
        <div className="source-runtime-list">
          <div className="source-runtime-row">
            <div>
              <strong>文件监听</strong>
              <span>{status?.fileWatcher?.root || "监听路径未知"}</span>
            </div>
            <StatusBadge
              state={
                status?.fileWatcher?.running === undefined
                  ? "unknown"
                  : status.fileWatcher.running
                    ? "running"
                    : "stopped"
              }
              label={
                status?.fileWatcher?.running === undefined
                  ? "未知"
                  : status.fileWatcher.running
                    ? "运行中"
                    : "未运行"
              }
            />
          </div>
          <div className="source-runtime-row">
            <div>
              <strong>工具目录监听</strong>
              <span>
                {status?.toolWatcher.running === undefined
                  ? "运行状态未知"
                  : status.toolWatcher.running > 0
                    ? `${status.toolWatcher.running} 个源监听中`
                    : status.toolWatcher.configured === undefined
                      ? "配置数量未知"
                      : status.toolWatcher.configured > 0
                        ? "已配置但当前未运行"
                        : "尚未配置监听源"}
              </span>
            </div>
            <StatusBadge
              state={
                status?.toolWatcher.running === undefined
                  ? "unknown"
                  : status.toolWatcher.running > 0
                    ? "running"
                    : "stopped"
              }
              label={
                status?.toolWatcher.running === undefined
                  ? "未知"
                  : `${status.toolWatcher.running} / ${status.toolWatcher.configured ?? "—"} 活跃`
              }
            />
          </div>
          <div className="source-runtime-row">
            <div>
              <strong>采集队列</strong>
              <span>
                待处理 {status?.events?.pending ?? "—"} · 失败 {status?.events?.failed ?? "—"}
              </span>
            </div>
            <span className="runtime-detail">
              处理中 {status?.events?.processing ?? "—"} · 已完成 {status?.events?.done ?? "—"}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>监听源</h2>
        <p className="section-note">新增、编辑、停用或移除来源；变更后监听器会自动重启。</p>
        {sourceError ? (
          <p className="notice notice-error" role="alert">
            来源配置暂不可用：{sourceError}
          </p>
        ) : null}
        {sources === null ? (
          <p className="empty-inline">{sourceError ? "来源列表尚未读取。" : "正在读取来源列表…"}</p>
        ) : (
          <ToolSourceList sources={sources} presets={presets} onChange={() => refresh()} />
        )}
      </section>
    </div>
  );
}
