import { watch, FSWatcher } from "chokidar";
import { readFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import { getMemoryRoot } from "../../lib/storage/path-resolver";
import { createSourceRevisionEvent } from "../../lib/source/source-revision";
import { KnowledgeAgent } from "../services/knowledge-agent";
import { isRecentWrite } from "../../lib/storage/write-tracker";
import { logger } from "../../lib/logger";

let watcher: FSWatcher | null = null;
const inFlightIngests = new Map<string, Promise<void>>();

// 运行状态存 globalThis：Next.js dev 把 instrumentation/listener 与路由编译成独立
// 模块实例，模块级 let watcher 在路由 bundle 里是空副本，跨 bundle 查状态必须走 globalThis
const globalStore = globalThis as typeof globalThis & { __amdFileWatcherRunning?: boolean };

export function startFileWatcher(): void {
  // watcher 为空但 globalThis 标记为运行中：说明本模块实例被热重载重建，
  // 真实 watcher 仍在旧实例里活着，跳过以免同进程双监听
  if (watcher || globalStore.__amdFileWatcherRunning) return;

  const watchPaths = [getMemoryRoot()];
  const ignored = [
    "**/memory.db",
    "**/memory.db-journal",
    "**/memory.db-wal",
    "**/archive/**",
    "**/notes/**",
  ];

  watcher = watch(watchPaths, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
  });

  watcher.on("add", async (filePath) => {
    if (!filePath.endsWith(".md")) return;
    if (filePath.endsWith("index-map.md") || filePath.endsWith("profile.md")) return;
    await ingestMarkdownFile(filePath, "add");
  });

  watcher.on("change", async (filePath) => {
    if (!filePath.endsWith(".md")) return;
    if (filePath.endsWith("index-map.md") || filePath.endsWith("profile.md")) return;
    await ingestMarkdownFile(filePath, "change");
  });

  watcher.on("unlink", async (filePath) => {
    if (!filePath.endsWith(".md")) return;
    if (filePath.endsWith("index-map.md") || filePath.endsWith("profile.md")) return;
    await ingestMarkdownFile(filePath, "delete");
  });

  watcher.on("error", (error) => {
    logger.ingest.error("[FileWatcher] 监听错误:", { error: (error as Error).message });
  });

  globalStore.__amdFileWatcherRunning = true;

  logger.ingest.info(`[FileWatcher] 已启动，监听目录: ${watchPaths.join(", ")}`);
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    globalStore.__amdFileWatcherRunning = false;
    logger.ingest.info("[FileWatcher] 已停止");
  }
}

/**
 * 获取文件监听器运行状态（供 API 状态查询）。
 */
export function getFileWatcherStatus(): { running: boolean; root: string } {
  return { running: globalStore.__amdFileWatcherRunning === true, root: getMemoryRoot() };
}

type MarkdownFileEvent = "add" | "change" | "delete" | "scan";

/**
 * 立即重扫记忆库目录下所有 Markdown（绕过 chokidar 事件），供「扫描/重建」按钮调用。
 * 跳过 archive/ 与系统文件；imports/ 一并扫描——重建采集卡片后，导入文件的卡片
 * 只能从这里恢复。已入库且未变更的文件在采集层被哈希跳过，不会产生重复 LLM 成本。
 * 返回扫描的文件数。
 */
export async function scanMemoryRoot(): Promise<number> {
  const root = getMemoryRoot();
  let scanned = 0;
  try {
    const all = await readdir(root, { recursive: true });
    for (const rel of all) {
      const normalized = rel.replace(/\\/g, "/");
      if (!normalized.endsWith(".md") && !normalized.endsWith(".markdown")) continue;
      if (normalized.split("/").some((seg) => seg === "archive" || seg === "notes")) continue;
      if (normalized.endsWith("index-map.md") || normalized.endsWith("profile.md")) continue;
      await ingestMarkdownFile(join(root, rel), "scan");
      scanned++;
    }
  } catch (error) {
    logger.ingest.error("[FileWatcher] 扫描记忆库失败:", { error: (error as Error).message });
  }
  return scanned;
}

/**
 * 处理外部 Markdown：add 创建；change 在记录存在时更新，不存在时按稳定 ID 创建。
 * 导出该边界以便集成测试直接验证文件事件与持久化队列的契约。
 */
export async function ingestMarkdownFile(
  filePath: string,
  eventType: MarkdownFileEvent,
): Promise<void> {
  const ingestKey = resolve(filePath);
  const active = inFlightIngests.get(ingestKey);
  if (active) return active;

  const ingest = ingestMarkdownFileOnce(filePath, eventType).finally(() => {
    inFlightIngests.delete(ingestKey);
  });
  inFlightIngests.set(ingestKey, ingest);
  return ingest;
}

async function ingestMarkdownFileOnce(
  filePath: string,
  eventType: MarkdownFileEvent,
): Promise<void> {
  try {
    const relativePath = filePath.replace(/\\/g, "/");
    if (relativePath.split("/").some((segment) => segment === "notes" || segment === "archive"))
      return;
    // 跳过本进程最近写入的文件，防止 Markdown 写回 → 监听 → 再次入队的循环
    if (isRecentWrite(filePath)) return;

    const content = eventType === "delete" ? "" : await readFile(filePath, "utf-8");
    if (eventType !== "delete" && content.length < 10) return;

    const sourceEvent = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath: filePath,
      content: eventType === "delete" ? `deleted:${relativePath}` : content,
      operation: eventType === "scan" ? "rescan" : eventType,
    });
    const agent = new KnowledgeAgent();
    try {
      const result = await agent.ingestSourceRevision({
        event: sourceEvent,
        content,
        sourceLocator: filePath,
      });
      logger.ingest.info(`[FileWatcher] 来源版本处理完成 (${eventType})`, {
        sourceId: sourceEvent.sourceId,
        revision: sourceEvent.revision,
        status: result.status,
        memoryIds: result.memoryIds,
      });
    } finally {
      agent.close();
    }
  } catch (error) {
    logger.ingest.error(`[FileWatcher] 导入失败 (${filePath}):`, {
      error: (error as Error).message,
    });
  }
}
