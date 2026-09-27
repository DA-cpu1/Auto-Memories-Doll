"use client";

import { useEffect, useState } from "react";
import StorageConfigForm from "@/components/settings/StorageConfigForm";

const API_BASE = "/api/config";

type StorageConfig = {
  notesPath: string;
  databasePath: string;
  updatedAt: string;
};

export default function StorageSettingsPage() {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    fetch(`${API_BASE}/storage`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: StorageConfig) => {
        setConfig(data);
        setError(null);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
  }, []);

  const handleChanged = () => {
    load();
  };

  if (error) {
    return (
      <div className="settings-page">
        <header className="settings-page-heading">
          <h1>存储路径</h1>
          <p>配置记忆笔记的位置并查看固定数据库路径。</p>
        </header>
        <div className="notice notice-error" role="alert">
          加载失败：{error}
        </div>
        <button onClick={load} className="btn-secondary mt-3">
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <h1>存储路径</h1>
        <p>配置记忆笔记的位置并查看固定数据库路径。</p>
      </header>
      {config ? (
        <StorageConfigForm config={config} onChanged={handleChanged} />
      ) : (
        <div className="settings-loading">
          <span>正在读取存储配置…</span>
        </div>
      )}
    </div>
  );
}
