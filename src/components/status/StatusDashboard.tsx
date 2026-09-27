"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentProgressEvent } from "@/types/agent";
import type { CodexDialogueDiagnostics } from "@/types/codex-dialogue";
import type { ModelFailure, ModelHealth } from "@/types/model-health";
import type { SourceDocument } from "@/types/source";
import type { FailedTaskSummary } from "@/server/services/memory-service";

type ListenSnapshot = {
  status?: string;
  uptime?: number;
  stats?: {
    totalReceived?: number;
    totalProcessed?: number;
    lastReceivedAt?: string | null;
  };
  agent?: { sources?: SourceDocument[]; progress?: AgentProgressEvent[] };
};
type WatchSnapshot = {
  fileWatcher?: { running?: boolean; root?: string };
  toolWatcher?: { configured?: number; running?: number; sources?: unknown[] };
  events?: Partial<
    Record<"pending" | "processing" | "done" | "failed" | "waiting_dependency", number>
  >;
};
type Snapshot<T> = { data: T | null; error: string | null };
const SOURCES_PER_PAGE = 10;
const FAILURES_PER_PAGE = 10;
type FailurePage = { items: FailedTaskSummary[]; total: number; page: number; pageSize: number };
type ApiResult<T> = { success: true; data: T } | { success: false; error: { message: string } };

const STAGE_LABELS: Record<string, string> = {
  discovered: "已发现",
  parsing: "解析中",
  normalizing: "归一化",
  staged: "已入队",
  processing: "处理中",
  accepted: "已接受",
  publishing: "发布中",
  indexed: "已索引",
  done: "已完成",
  review: "等待自动恢复",
  rejected: "已拒绝",
  failed_retryable: "等待重试",
  waiting_dependency: "等待模型服务",
};
const HEALTH_LABELS: Record<string, string> = {
  healthy: "正常",
  degraded: "降级",
  unavailable: "不可用",
  disabled: "已停用",
  unknown: "未知",
};
const DIALOGUE_LABELS: Record<CodexDialogueDiagnostics["reasons"][number], string> = {
  no_final_answer: "等待最终回答",
  no_dialogue: "只有非对话事件",
  unsupported_format: "不支持的会话格式",
  orphan_final: "最终回答缺少用户输入",
  ambiguous_turn: "轮次关联不明确",
};
const SLOT_LABELS: Record<ModelFailure["slot"], string> = {
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

async function readSnapshot<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function readFailurePage(page: number): Promise<FailurePage> {
  const result = await readSnapshot<ApiResult<FailurePage>>(`/api/status/failures?page=${page}`);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

function failureAdvice(task: FailedTaskSummary) {
  const code = (task.errorCode || "").toUpperCase();
  const message = (task.error || "").toLowerCase();
  if (/非法队列状态迁移|pending\s*->\s*done/.test(message))
    return "这是后台队列状态转换错误，来源和模型设置通常无关。更新服务端后再重试，并保留事件 ID 供排查。";
  if (
    /AUTH|PERMISSION|401|403/.test(code) ||
    /认证|权限|api.?key|unauthorized|forbidden/.test(message)
  )
    return "检查模型服务的密钥与权限，修复后再重试。";
  if (/TIMEOUT|RATE_LIMIT|429/.test(code) || /超时|限流|timeout|rate.limit/.test(message))
    return "检查模型服务状态和额度，恢复后再重试。";
  if (/NOT_CONFIGURED|MODEL|DEPENDENCY/.test(code) || /模型未配置|等待模型/.test(message))
    return "打开模型设置，检查所需模型及连接配置。";
  if (/ENOENT|PATH|FILE|SOURCE/.test(code) || /文件不存在|路径|无法读取/.test(message))
    return "检查来源路径与读取权限，再到来源设置核对监听配置。";
  return "先核对错误内容和来源配置，排除问题后再重试。";
}

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "时间未知"
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function formatUptime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "不足 1 分钟";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return [
    days ? `${days} 天` : "",
    hours ? `${hours} 小时` : "",
    remainder ? `${remainder} 分钟` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function Metric({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="status-metric">
      <span>{label}</span>
      <strong>{value === undefined ? "—" : value}</strong>
    </div>
  );
}

export default function StatusDashboard() {
  const [listen, setListen] = useState<Snapshot<ListenSnapshot>>({ data: null, error: null });
  const [watch, setWatch] = useState<Snapshot<WatchSnapshot>>({ data: null, error: null });
  const [health, setHealth] = useState<Snapshot<ModelHealth>>({ data: null, error: null });
  const [failures, setFailures] = useState<Snapshot<FailurePage>>({ data: null, error: null });
  const [loading, setLoading] = useState(true);
  const [sourcePage, setSourcePage] = useState(1);
  const [failurePage, setFailurePage] = useState(1);
  const [selectedFailureId, setSelectedFailureId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const refreshId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRefresh = ++refreshId.current;
    setLoading(true);
    const [listenResult, watchResult, healthResult, failureResult] = await Promise.allSettled([
      readSnapshot<ListenSnapshot>("/api/listen"),
      readSnapshot<WatchSnapshot>("/api/config/tool-sources/status"),
      readSnapshot<ModelHealth>("/api/health"),
      readFailurePage(failurePage),
    ]);
    if (currentRefresh !== refreshId.current) return;
    setListen(
      listenResult.status === "fulfilled"
        ? { data: listenResult.value, error: null }
        : {
            data: null,
            error: listenResult.reason instanceof Error ? listenResult.reason.message : "读取失败",
          },
    );
    setWatch(
      watchResult.status === "fulfilled"
        ? { data: watchResult.value, error: null }
        : {
            data: null,
            error: watchResult.reason instanceof Error ? watchResult.reason.message : "读取失败",
          },
    );
    setHealth(
      healthResult.status === "fulfilled"
        ? { data: healthResult.value, error: null }
        : {
            data: null,
            error: healthResult.reason instanceof Error ? healthResult.reason.message : "读取失败",
          },
    );
    setFailures(
      failureResult.status === "fulfilled"
        ? { data: failureResult.value, error: null }
        : {
            data: null,
            error:
              failureResult.reason instanceof Error ? failureResult.reason.message : "读取失败",
          },
    );
    if (failureResult.status === "fulfilled") {
      const lastPage = Math.max(
        1,
        Math.ceil(failureResult.value.total / failureResult.value.pageSize),
      );
      if (failurePage > lastPage) setFailurePage(lastPage);
      setSelectedFailureId((current) =>
        failureResult.value.items.some((item) => item.eventId === current)
          ? current
          : (failureResult.value.items[0]?.eventId ?? null),
      );
    }
    setLoading(false);
  }, [failurePage]);

  const retryFailure = async (eventId: string) => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const response = await fetch("/api/status/failures/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId }),
      });
      const result = (await response.json()) as ApiResult<{ eventId: string; status: string }>;
      if (!response.ok || !result.success) {
        throw new Error(result.success ? `HTTP ${response.status}` : result.error.message);
      }
      setRetryMessage("已重新入队；处理结果请在稍后刷新查看。");
      await refresh();
    } catch (error) {
      setRetryMessage(error instanceof Error ? error.message : "重试请求失败");
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sources = listen.data?.agent?.sources;
  const sourcePageCount = Math.max(1, Math.ceil((sources?.length ?? 0) / SOURCES_PER_PAGE));
  const currentSourcePage = Math.min(sourcePage, sourcePageCount);
  const sourceStart = (currentSourcePage - 1) * SOURCES_PER_PAGE;
  const visibleSources = sources?.slice(sourceStart, sourceStart + SOURCES_PER_PAGE) ?? [];
  const progress = listen.data?.agent?.progress;
  const fileRunning = watch.data?.fileWatcher?.running;
  const toolRunning = watch.data?.toolWatcher?.running;
  const watcherCount =
    fileRunning === undefined || toolRunning === undefined
      ? undefined
      : toolRunning + (fileRunning ? 1 : 0);
  const events = watch.data?.events;
  const degraded = health.data?.degradedCapabilities;
  const recent = progress?.slice(-8).reverse() ?? [];
  const failedItems = failures.data?.items ?? [];
  const selectedFailure = failedItems.find((item) => item.eventId === selectedFailureId);
  const failurePageCount = Math.max(1, Math.ceil((failures.data?.total ?? 0) / FAILURES_PER_PAGE));

  return (
    <div className="page-frame status-page">
      <header className="page-heading-row">
        <div>
          <h1>运行状态</h1>
          <p>查看来源监听、知识处理进度和模型服务情况。</p>
        </div>
        <div className="heading-actions">
          <span
            className={`connection-state ${loading ? "is-loading" : listen.data || watch.data ? "is-ready" : "is-unavailable"}`}
            role="status"
          >
            {loading ? "正在读取" : listen.data || watch.data ? "最近读取" : "无法连接"}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新状态"}
          </button>
        </div>
      </header>

      {listen.error || watch.error || health.error || failures.error ? (
        <div className="notice notice-warning" role="status">
          部分状态暂时无法读取；未读取到的字段会显示为“—”。
          {[
            listen.error && `来源：${listen.error}`,
            watch.error && `队列：${watch.error}`,
            health.error && `模型：${health.error}`,
            failures.error && `失败任务：${failures.error}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}

      <section className="status-section" aria-labelledby="status-overview-title">
        <div className="section-heading">
          <h2 id="status-overview-title">概览</h2>
        </div>
        <div className="status-metrics-grid">
          <Metric label="已登记来源" value={Array.isArray(sources) ? sources.length : undefined} />
          <Metric label="活跃监听" value={watcherCount} />
          <Metric label="正在处理" value={events?.processing} />
          <Metric label="已完成任务" value={events?.done} />
        </div>
      </section>

      <section className="status-section" aria-labelledby="failures-title">
        <div className="section-heading">
          <h2 id="failures-title">失败处理</h2>
          <span className="section-note">
            {failures.data ? `共 ${failures.data.total} 条失败任务` : "—"}
          </span>
        </div>
        <p className="section-note">查看错误并排除原因。刷新状态只重新读取数据，不会重试任务。</p>
        {retryMessage ? (
          <p role="status" className="notice">
            {retryMessage}
          </p>
        ) : null}
        {failures.error ? (
          <p className="empty-inline">失败任务暂不可用。</p>
        ) : failedItems.length ? (
          <>
            <div className="status-failure-workspace">
              <div className="status-failure-list" aria-label="失败任务列表">
                {failedItems.map((item) => (
                  <button
                    type="button"
                    key={item.eventId}
                    className="status-failure-entry"
                    aria-pressed={item.eventId === selectedFailureId}
                    onClick={() => {
                      setSelectedFailureId(item.eventId);
                      setRetryMessage(null);
                    }}
                  >
                    <strong>{item.sourceId || `记忆 ${item.memoryId.slice(-10)}`}</strong>
                    <span>
                      事件 {item.eventId.slice(-8)} · {formatTime(item.createdAt)} · 已失败{" "}
                      {item.retryCount} 次
                    </span>
                  </button>
                ))}
              </div>
              <div className="status-failure-detail" aria-live="polite">
                {selectedFailure ? (
                  <>
                    <h3>任务详情</h3>
                    <dl className="status-failure-meta">
                      <div>
                        <dt>来源</dt>
                        <dd>{selectedFailure.sourceId || selectedFailure.sourceType}</dd>
                      </div>
                      <div>
                        <dt>事件 ID</dt>
                        <dd>{selectedFailure.eventId}</dd>
                      </div>
                      <div>
                        <dt>记忆 ID</dt>
                        <dd>{selectedFailure.memoryId}</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{formatTime(selectedFailure.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>失败次数</dt>
                        <dd>{selectedFailure.retryCount}</dd>
                      </div>
                      <div>
                        <dt>错误代码</dt>
                        <dd>{selectedFailure.errorCode || "未提供"}</dd>
                      </div>
                    </dl>
                    <h4>错误内容</h4>
                    <p className="status-failure-error">
                      {selectedFailure.error || "队列未记录错误详情，请查看服务日志。"}
                    </p>
                    <h4>建议处理</h4>
                    <p>{failureAdvice(selectedFailure)}</p>
                    <div className="status-failure-actions">
                      {/非法队列状态迁移|pending\s*->\s*done/i.test(
                        selectedFailure.error || "",
                      ) ? null : (
                        <>
                          <Link href="/settings/ai">模型设置</Link>
                          <Link href="/settings/tools">来源设置</Link>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={selectedFailure.retryCount < 3 || retrying}
                        onClick={() => void retryFailure(selectedFailure.eventId)}
                      >
                        {retrying ? "正在入队…" : "手动重试"}
                      </button>
                    </div>
                    {selectedFailure.retryCount < 3 ? (
                      <p className="section-note">后台仍会自动重试，达到上限后才可手动重新入队。</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            {failurePageCount > 1 ? (
              <nav className="status-source-pagination" aria-label="失败任务分页">
                <span>
                  第 {failurePage} / {failurePageCount} 页
                </span>
                <div>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={loading || failurePage === 1}
                    onClick={() => setFailurePage(failurePage - 1)}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={loading || failurePage === failurePageCount}
                    onClick={() => setFailurePage(failurePage + 1)}
                  >
                    下一页
                  </button>
                </div>
              </nav>
            ) : null}
          </>
        ) : (
          <p className="empty-inline">
            {failures.data ? "当前没有失败任务。" : "正在读取失败任务…"}
          </p>
        )}
      </section>

      <section className="status-section" aria-labelledby="listen-api-title">
        <div className="section-heading">
          <h2 id="listen-api-title">API 监听</h2>
        </div>
        <div className="status-metrics-grid">
          <div className="status-metric">
            <span>接口状态</span>
            <strong>
              {listen.data?.status === "listening" ? "运行中" : listen.data?.status || "—"}
            </strong>
          </div>
          <div className="status-metric">
            <span>进程运行时间</span>
            <strong>{formatUptime(listen.data?.uptime)}</strong>
          </div>
          <Metric label="收到会话" value={listen.data?.stats?.totalReceived} />
          <Metric label="处理成功" value={listen.data?.stats?.totalProcessed} />
        </div>
        <p className="section-note">
          最近接收：{formatTime(listen.data?.stats?.lastReceivedAt || undefined)}
          {watch.data?.fileWatcher?.root ? ` · 记忆目录：${watch.data.fileWatcher.root}` : ""}
          {watch.data?.toolWatcher?.configured === undefined ||
          watch.data?.toolWatcher?.running === undefined
            ? ""
            : ` · 工具来源运行 ${watch.data.toolWatcher.running} / 已启用 ${watch.data.toolWatcher.configured}`}
        </p>
      </section>

      <section className="status-section" aria-labelledby="queue-title">
        <div className="section-heading">
          <h2 id="queue-title">任务队列</h2>
        </div>
        <p className="section-note">任务由后台自动处理；失败项表示处理出错。</p>
        <div className="queue-list">
          <Metric label="排队等待入库" value={events?.pending} />
          <Metric label="正在自动处理" value={events?.processing} />
          <Metric label="等待模型服务" value={events?.waiting_dependency} />
          <Metric label="已完成任务" value={events?.done} />
          <Metric label="处理失败" value={events?.failed} />
        </div>
      </section>

      <section className="status-section" aria-labelledby="models-title">
        <div className="section-heading">
          <h2 id="models-title">模型服务</h2>
          <Link href="/settings/ai">管理模型设置 →</Link>
        </div>
        {health.data ? (
          <>
            <p className="service-state">
              {degraded?.length
                ? `当前降级能力：${degraded.map((item) => (item === "llm" ? "语言模型" : "向量检索")).join("、")}`
                : "当前未报告模型能力降级"}
              <span>
                检查时间{" "}
                {new Date(health.data.timestamp).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </p>
            {health.data.failures.length ? (
              <ul className="model-failure-list">
                {health.data.failures.map((failure) => (
                  <li key={`${failure.slot}-${failure.failedAt || "current"}`}>
                    <strong>
                      {SLOT_LABELS[failure.slot]} · {failure.model || "未配置"}
                    </strong>
                    <span>{REASON_LABELS[failure.reason] || failure.reason}</span>
                    {failure.purpose ? (
                      <span>{failure.purpose === "health-check" ? "恢复检查" : "后台加工"}</span>
                    ) : null}
                    {failure.durationMs !== undefined ? (
                      <span>耗时 {(failure.durationMs / 1000).toFixed(1)} 秒</span>
                    ) : null}
                    {failure.failedAt ? (
                      <time dateTime={failure.failedAt}>{formatTime(failure.failedAt)}</time>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="empty-inline">
            {health.error ? "模型状态暂不可用。" : "正在读取模型状态…"}
          </p>
        )}
      </section>

      <section className="status-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">最近处理</h2>
        </div>
        {listen.error ? (
          <p className="empty-inline">处理记录暂不可用。</p>
        ) : recent.length ? (
          <ol className="recent-progress-list">
            {recent.map((item: AgentProgressEvent) => (
              <li key={item.progressId}>
                <div className="progress-head">
                  <strong>{STAGE_LABELS[item.stage] || item.stage}</strong>
                  <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
                </div>
                <p>
                  {item.sourceId} · {item.outcome}
                  {item.durationMs === undefined ? "" : ` · ${item.durationMs} ms`}
                </p>
                {item.error ? <p className="progress-error">{item.error}</p> : null}
                {item.degradedCapabilities.length ? (
                  <p>降级能力：{item.degradedCapabilities.join("、")}</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-inline">{listen.data ? "暂无处理记录。" : "正在读取处理记录…"}</p>
        )}
      </section>

      <section className="status-section" aria-labelledby="sources-title">
        <div className="section-heading">
          <h2 id="sources-title">来源健康与最近版本</h2>
          <Link href="/settings/tools">管理来源 →</Link>
        </div>
        {listen.error ? (
          <p className="empty-inline">来源数据暂不可用。</p>
        ) : sources?.length ? (
          <>
            <div className="table-scroll">
              <table className="status-table">
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>健康</th>
                    <th>最近版本</th>
                    <th>最后观察 / 处理</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSources.map((source) => (
                    <tr key={source.sourceId}>
                      <td>
                        <strong>{source.sourceType}</strong>
                        <span className="source-path">{source.sourcePath || source.sourceId}</span>
                      </td>
                      <td>
                        <span className={`health-pill health-${source.health}`}>
                          {HEALTH_LABELS[source.health] || source.health}
                        </span>
                      </td>
                      <td className="revision-cell">
                        {source.latestRevision ? source.latestRevision.slice(0, 12) : "尚未观察"}
                      </td>
                      <td>
                        <span>观察 {formatTime(source.lastObservedAt)}</span>
                        <span>处理 {formatTime(source.lastProcessedAt)}</span>
                        {source.lastError ? (
                          <span className="progress-error">{source.lastError}</span>
                        ) : null}
                        {source.dialogue ? (
                          <span className="dialogue-note">{dialogueSummary(source.dialogue)}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sourcePageCount > 1 ? (
              <nav className="status-source-pagination" aria-label="来源列表分页">
                <span>
                  显示 {sourceStart + 1}–{Math.min(sourceStart + SOURCES_PER_PAGE, sources.length)}{" "}
                  / {sources.length} 个来源
                </span>
                <div>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={currentSourcePage === 1}
                    onClick={() => setSourcePage(currentSourcePage - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    第 {currentSourcePage} / {sourcePageCount} 页
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={currentSourcePage === sourcePageCount}
                    onClick={() => setSourcePage(currentSourcePage + 1)}
                  >
                    下一页
                  </button>
                </div>
              </nav>
            ) : null}
          </>
        ) : (
          <p className="empty-inline">{listen.data ? "尚未登记来源。" : "正在读取来源…"}</p>
        )}
      </section>
    </div>
  );
}

function dialogueSummary(dialogue: CodexDialogueDiagnostics) {
  const parts = [`已采集 ${dialogue.completedTurns} 轮对话`];
  parts.push(...dialogue.reasons.map((reason) => DIALOGUE_LABELS[reason]));
  if (dialogue.truncated) parts.push("对话已截断");
  return parts.join(" · ");
}
