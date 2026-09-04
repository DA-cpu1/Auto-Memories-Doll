"use client";

import { useState } from "react";
import type { ToolWatchSource, ToolType } from "../../types/config";

type Preset = { name: string; toolType: ToolType; path: string; filePattern: string };
type FormValue = {
  name: string;
  toolType: ToolType;
  path: string;
  filePattern: string;
  topic: string;
  description: string;
};
type Props = {
  sources: ToolWatchSource[];
  presets: Record<string, Preset>;
  onChange: (sources: ToolWatchSource[]) => void;
};

const EMPTY_FORM: FormValue = {
  name: "",
  toolType: "markdown",
  path: "",
  filePattern: "*.md",
  topic: "",
  description: "",
};
const TOOL_LABELS: Record<ToolType, string> = {
  codex: "Codex CLI",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  trae: "Trae",
  markdown: "Markdown",
  text: "纯文本",
};

export default function ToolSourceList({ sources, presets, onChange }: Props) {
  const [form, setForm] = useState<FormValue>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const openCreate = (preset?: Preset) => {
    setForm(preset ? { ...preset, topic: "", description: "" } : EMPTY_FORM);
    setEditingId(null);
    setFormOpen(true);
    setError("");
  };
  const openEdit = (source: ToolWatchSource) => {
    setForm({
      name: source.name,
      toolType: source.toolType,
      path: source.path,
      filePattern: source.filePattern,
      topic: source.topic || "",
      description: source.description || "",
    });
    setEditingId(source.id);
    setFormOpen(true);
    setError("");
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setError("");
  };

  const save = async () => {
    if (!form.name.trim() || !form.path.trim()) {
      setError("名称和路径不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        editingId
          ? `/api/config/tool-sources/${encodeURIComponent(editingId)}`
          : "/api/config/tool-sources",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            toolType: form.toolType,
            path: form.path.trim(),
            filePattern: form.filePattern.trim() || "*.jsonl",
            ...(editingId ? {} : { enabled: true }),
            topic: form.topic.trim() || undefined,
            description: form.description.trim() || undefined,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存失败");
      onChange(
        editingId
          ? sources.map((source) => (source.id === editingId ? payload : source))
          : [payload, ...sources],
      );
      closeForm();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (source: ToolWatchSource) => {
    const response = await fetch(`/api/config/tool-sources/${encodeURIComponent(source.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    if (response.ok) {
      const updated = await response.json();
      onChange(sources.map((item) => (item.id === source.id ? updated : item)));
    }
  };
  const remove = async (source: ToolWatchSource) => {
    if (!window.confirm(`确定移除来源“${source.name}”吗？已发布知识不会被删除。`)) return;
    const response = await fetch(`/api/config/tool-sources/${encodeURIComponent(source.id)}`, {
      method: "DELETE",
    });
    if (response.ok) onChange(sources.filter((item) => item.id !== source.id));
  };

  return (
    <div className="space-y-4">
      {!formOpen ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(presets).map(([key, preset]) => (
            <button
              key={key}
              type="button"
              className="btn-secondary px-3 py-2 text-xs"
              onClick={() => openCreate(preset)}
            >
              新增 {preset.name}
            </button>
          ))}
          <button type="button" className="btn px-3 py-2 text-xs" onClick={() => openCreate()}>
            新增自定义来源
          </button>
        </div>
      ) : null}

      {formOpen ? (
        <section
          aria-labelledby="source-form-title"
          className="rounded-lg border border-accent-line bg-accent-soft p-4"
        >
          <h3 id="source-form-title" className="mb-4 text-sm font-semibold text-text-primary">
            {editingId ? "编辑监听源" : "新增监听源"}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <SourceField label="名称">
              <input
                className="input"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </SourceField>
            <SourceField label="来源类型">
              <select
                className="input"
                value={form.toolType}
                onChange={(event) => setForm({ ...form, toolType: event.target.value as ToolType })}
              >
                {Object.entries(TOOL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </SourceField>
            <div className="sm:col-span-2">
              <SourceField label="监听路径">
                <input
                  className="input font-mono text-sm"
                  value={form.path}
                  onChange={(event) => setForm({ ...form, path: event.target.value })}
                  placeholder="D:\notes 或 ~/.codex/sessions"
                />
              </SourceField>
            </div>
            <SourceField label="包含规则">
              <input
                className="input font-mono text-sm"
                value={form.filePattern}
                onChange={(event) => setForm({ ...form, filePattern: event.target.value })}
                placeholder="*.jsonl"
              />
            </SourceField>
            <SourceField label="固定主题（可选）">
              <input
                className="input"
                value={form.topic}
                onChange={(event) => setForm({ ...form, topic: event.target.value })}
              />
            </SourceField>
            <div className="sm:col-span-2">
              <SourceField label="说明（可选）">
                <input
                  className="input"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </SourceField>
            </div>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-error">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={closeForm}>
              取消
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
              {saving ? "保存中…" : "保存来源"}
            </button>
          </div>
        </section>
      ) : null}

      {sources.length === 0 && !formOpen ? (
        <p className="border-y border-border py-10 text-center text-sm text-text-tertiary">
          还没有监听源。
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {sources.map((source) => (
            <article
              key={source.id}
              className="flex min-w-0 flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-text-primary">{source.name}</h3>
                  <span className="tag">{TOOL_LABELS[source.toolType]}</span>
                  {source.topic ? <span className="tag tag-accent">#{source.topic}</span> : null}
                </div>
                <p className="mt-2 break-all font-mono text-xs text-text-secondary">
                  {source.path}
                </p>
                <p className="mt-1 text-xs text-text-tertiary">
                  包含 {source.filePattern}
                  {source.description ? ` · ${source.description}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => openEdit(source)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={source.enabled}
                  aria-label={`${source.enabled ? "停用" : "启用"}${source.name}`}
                  className={`relative h-6 w-11 rounded-full border transition-colors ${source.enabled ? "border-accent bg-accent" : "border-border bg-muted"}`}
                  onClick={() => void toggle(source)}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-transform ${source.enabled ? "translate-x-5" : "translate-x-0.5"}`}
                  />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs text-error"
                  onClick={() => void remove(source)}
                >
                  移除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-text-secondary">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
