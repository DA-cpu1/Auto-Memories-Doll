"use client";

import { useCallback, useEffect, useState } from "react";

type ConflictRecord = {
  conflictId: string;
  memoryId: string;
  eventId: string;
  field: string;
  existingValue: string;
  candidateValue: string;
  createdAt: string;
};
type AuditReport = { totalMemories: number; pendingEvents: number; conflicts: number };
type ReviewCandidate = {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  topic: string;
  kind: string;
  source: string;
  evidence?: { text: string; location?: string };
};
type ReviewEvent = {
  eventId: string;
  memoryId: string | null;
  sourceType: string;
  sourceId?: string;
  sourceRevision?: string;
  createdAt: string;
  retryCount: number;
  reasonCode: string;
  reason: string;
  candidate: ReviewCandidate | null;
};
type Tab = "review" | "conflicts" | "report";

export default function AuditPanel() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [reviews, setReviews] = useState<ReviewEvent[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewCandidate | null>(null);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [reportResponse, conflictResponse, reviewResponse] = await Promise.all([
        fetch("/api/audit"),
        fetch("/api/audit/conflicts"),
        fetch("/api/audit/review-events"),
      ]);
      if (!reportResponse.ok || !conflictResponse.ok || !reviewResponse.ok)
        throw new Error("审计数据加载失败");
      const reviewPayload = await reviewResponse.json();
      setReport(await reportResponse.json());
      setConflicts(await conflictResponse.json());
      setReviews(reviewPayload.items || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "审计数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const decideReview = async (
    review: ReviewEvent,
    action: "accept" | "reject",
    edited?: ReviewCandidate,
  ) => {
    setWorkingId(review.eventId);
    setError("");
    try {
      const response = await fetch("/api/audit/review-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: review.eventId,
          action,
          ...(edited ? { candidate: edited } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "裁决失败");
      setReviews((items) => items.filter((item) => item.eventId !== review.eventId));
      setEditingId(null);
      setDraft(null);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "裁决失败");
    } finally {
      setWorkingId(null);
    }
  };

  const resolveConflict = async (
    conflict: ConflictRecord,
    resolution: "accept" | "keep" | "manual",
  ) => {
    setWorkingId(conflict.conflictId);
    setError("");
    try {
      const response = await fetch("/api/audit/conflicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conflictId: conflict.conflictId,
          resolution,
          ...(resolution === "manual"
            ? { manualValue: manualValues[conflict.conflictId] || "" }
            : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "冲突裁决失败");
      setConflicts((items) => items.filter((item) => item.conflictId !== conflict.conflictId));
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "冲突裁决失败");
    } finally {
      setWorkingId(null);
    }
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "review", label: "待审核候选", count: reviews.length },
    { id: "conflicts", label: "字段冲突", count: conflicts.length },
    { id: "report", label: "审计概览" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-7 flex flex-col gap-4 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 font-mono text-xs font-semibold uppercase text-text-tertiary">
            Decision desk
          </p>
          <h1 className="text-3xl font-bold text-text-primary">审核工作台</h1>
          <p className="mt-2 text-sm text-text-secondary">所有不确定内容在发布前都需要明确裁决。</p>
        </div>
        <button
          type="button"
          className="btn-secondary self-start"
          onClick={() => void load()}
          disabled={loading}
        >
          刷新
        </button>
      </header>

      <nav
        aria-label="审核视图"
        className="mb-7 flex max-w-full gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`shrink-0 border-b-2 px-3 py-3 text-sm font-medium ${activeTab === tab.id ? "border-accent text-accent" : "border-transparent text-text-secondary hover:text-text-primary"}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined ? ` ${tab.count}` : ""}
          </button>
        ))}
      </nav>
      {error ? (
        <div
          role="alert"
          className="mb-5 border-l-2 border-error bg-error-bg px-4 py-3 text-sm text-error"
        >
          {error}
        </div>
      ) : null}
      {loading ? <EmptyLine>正在读取审计队列…</EmptyLine> : null}

      {!loading && activeTab === "review" ? (
        reviews.length === 0 ? (
          <EmptyLine>没有等待裁决的候选。</EmptyLine>
        ) : (
          <div className="space-y-5">
            {reviews.map((review) => {
              const candidate = editingId === review.eventId ? draft : review.candidate;
              return (
                <article
                  key={review.eventId}
                  className="overflow-hidden rounded-lg border border-border bg-surface"
                >
                  <header className="flex flex-col gap-3 border-b border-border bg-muted/60 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="status-tag status-tag--pending">待人工审核</span>
                        <code className="text-xs text-text-tertiary">{review.reasonCode}</code>
                      </div>
                      <h2 className="mt-2 break-words text-lg font-semibold text-text-primary">
                        {review.candidate?.title || "候选内容无法解析"}
                      </h2>
                      <p className="mt-1 break-all font-mono text-xs text-text-tertiary">
                        {review.sourceId || review.candidate?.source || review.eventId}
                      </p>
                    </div>
                    <time
                      className="shrink-0 text-xs text-text-tertiary"
                      dateTime={review.createdAt}
                    >
                      {new Date(review.createdAt).toLocaleString("zh-CN")}
                    </time>
                  </header>
                  <div className="grid min-w-0 lg:grid-cols-2">
                    <section className="min-w-0 border-b border-border p-4 sm:p-5 lg:border-b-0 lg:border-r">
                      <p className="mb-2 text-xs font-semibold uppercase text-text-tertiary">
                        来源摘录
                      </p>
                      <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-accent-line pl-4 text-sm leading-6 text-text-secondary">
                        {review.candidate?.evidence?.text || "该候选没有附带来源摘录。"}
                      </blockquote>
                      <dl className="mt-4 grid gap-2 text-xs">
                        <Meta
                          label="位置"
                          value={
                            review.candidate?.evidence?.location ||
                            review.candidate?.source ||
                            "未提供"
                          }
                        />
                        <Meta label="来源版本" value={review.sourceRevision || "旧事件未记录"} />
                      </dl>
                    </section>
                    <section className="min-w-0 p-4 sm:p-5">
                      <p className="mb-2 text-xs font-semibold uppercase text-text-tertiary">
                        候选知识
                      </p>
                      {editingId === review.eventId && candidate ? (
                        <CandidateEditor value={candidate} onChange={setDraft} />
                      ) : candidate ? (
                        <>
                          <p className="font-semibold text-text-primary">{candidate.title}</p>
                          <p className="mt-2 text-sm leading-6 text-text-secondary">
                            {candidate.summary}
                          </p>
                          <div className="mt-4 max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-border pt-4 text-sm text-text-secondary">
                            {candidate.content}
                          </div>
                          <div className="mt-4 flex flex-wrap gap-1.5">
                            {candidate.tags.map((tag) => (
                              <span key={tag} className="tag">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-error">候选数据损坏，建议拒绝并重新采集。</p>
                      )}
                    </section>
                  </div>
                  <footer className="flex flex-col gap-4 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <p className="max-w-2xl text-sm text-text-secondary">
                      <strong className="text-text-primary">判断原因：</strong>
                      {review.reason}
                    </p>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {editingId === review.eventId ? (
                        <>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => {
                              setEditingId(null);
                              setDraft(null);
                            }}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={!draft || workingId === review.eventId}
                            onClick={() => draft && void decideReview(review, "accept", draft)}
                          >
                            保存并接受
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-ghost text-error"
                            disabled={workingId === review.eventId}
                            onClick={() => void decideReview(review, "reject")}
                          >
                            拒绝
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={!review.candidate || workingId === review.eventId}
                            onClick={() => {
                              setEditingId(review.eventId);
                              setDraft(review.candidate);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={!review.candidate || workingId === review.eventId}
                            onClick={() => void decideReview(review, "accept")}
                          >
                            接受候选
                          </button>
                        </>
                      )}
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      {!loading && activeTab === "conflicts" ? (
        conflicts.length === 0 ? (
          <EmptyLine>没有待处理的字段冲突。</EmptyLine>
        ) : (
          <div className="space-y-5">
            {conflicts.map((conflict) => (
              <article
                key={conflict.conflictId}
                className="rounded-lg border border-border bg-surface p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-semibold text-text-primary">字段：{conflict.field}</h2>
                  <code className="text-xs text-text-tertiary">{conflict.memoryId}</code>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <CompareValue label="现有内容" value={conflict.existingValue} />
                  <CompareValue label="候选内容" value={conflict.candidateValue} />
                </div>
                <label
                  className="mt-4 block text-xs font-medium text-text-secondary"
                  htmlFor={`manual-${conflict.conflictId}`}
                >
                  手动合并值
                </label>
                <textarea
                  id={`manual-${conflict.conflictId}`}
                  className="input mt-1 min-h-24 resize-y"
                  value={manualValues[conflict.conflictId] || ""}
                  onChange={(event) =>
                    setManualValues((values) => ({
                      ...values,
                      [conflict.conflictId]: event.target.value,
                    }))
                  }
                />
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void resolveConflict(conflict, "keep")}
                  >
                    保留现有
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void resolveConflict(conflict, "manual")}
                    disabled={!manualValues[conflict.conflictId]?.trim()}
                  >
                    使用合并值
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void resolveConflict(conflict, "accept")}
                  >
                    接受候选
                  </button>
                </div>
              </article>
            ))}
          </div>
        )
      ) : null}

      {!loading && activeTab === "report" ? (
        <section className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
          {[
            ["已发布知识", report?.totalMemories ?? 0],
            ["待处理事件", report?.pendingEvents ?? 0],
            ["待裁决冲突", report?.conflicts ?? 0],
          ].map(([label, value]) => (
            <div key={label} className="bg-surface p-6">
              <p className="text-sm text-text-secondary">{label}</p>
              <p className="mt-2 font-mono text-3xl font-bold text-text-primary">{value}</p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function CandidateEditor({
  value,
  onChange,
}: {
  value: ReviewCandidate;
  onChange: (value: ReviewCandidate) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="标题">
        <input
          className="input"
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
        />
      </Field>
      <Field label="摘要">
        <textarea
          className="input min-h-20 resize-y"
          value={value.summary}
          onChange={(event) => onChange({ ...value, summary: event.target.value })}
        />
      </Field>
      <Field label="正文">
        <textarea
          className="input min-h-48 resize-y font-mono text-sm"
          value={value.content}
          onChange={(event) => onChange({ ...value, content: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="主题">
          <input
            className="input"
            value={value.topic}
            onChange={(event) => onChange({ ...value, topic: event.target.value })}
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            className="input"
            value={value.tags.join(", ")}
            onChange={(event) =>
              onChange({
                ...value,
                tags: event.target.value
                  .split(/[,，]/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-text-secondary">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_1fr] gap-2">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="break-all font-mono text-text-secondary">{value}</dd>
    </div>
  );
}
function CompareValue({ label, value }: { label: string; value: string }) {
  return (
    <section className="min-w-0 border border-border bg-muted/50 p-3">
      <p className="mb-2 text-xs font-semibold text-text-tertiary">{label}</p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-text-secondary">
        {value}
      </pre>
    </section>
  );
}
function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-y border-border py-16 text-center text-sm text-text-tertiary">
      {children}
    </div>
  );
}
