"use client";

import { useEffect, useState } from "react";
import { AiConfig } from "@/types/config";
import type { ProviderCatalog } from "@/config/provider-loader";
import AiConfigForm from "@/components/settings/AiConfigForm";

type AiConfigResponse = AiConfig & { providerCatalog?: ProviderCatalog };

export default function AiSettingsPage() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config/ai", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载配置失败（${r.status}）`);
        return (await r.json()) as AiConfigResponse;
      })
      .then((data) => {
        const { providerCatalog: catalog, ...safeConfig } = data;
        setProviderCatalog(catalog);
        setConfig(safeConfig);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "加载配置失败");
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const handleSave = async (next: AiConfig) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `保存失败（${res.status}）`);
      }
      setConfig(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存配置失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <h1>AI 模型</h1>
        <p>配置语言模型与 Embedding 服务。保存后立即用于后续处理。</p>
      </header>
      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      {!config ? (
        error ? (
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => {
              setError(null);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            重试
          </button>
        ) : (
          <div className="settings-loading">
            <div className="loading-dots">
              <span />
              <span />
              <span />
            </div>
            <span>正在读取已保存的配置…</span>
          </div>
        )
      ) : (
        <AiConfigForm
          config={config}
          providerCatalog={providerCatalog}
          onSave={handleSave}
          saving={saving}
        />
      )}
    </div>
  );
}
