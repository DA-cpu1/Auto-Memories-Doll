import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { KnowledgeAgent } from "../../../server/services/knowledge-agent";
import { ListenStatsService } from "../../../server/services/listen-stats-service";
import { getNotePath } from "../../../lib/storage/path-resolver";
import {
  createSourceRevision,
  createSourceRevisionEvent,
} from "../../../lib/source/source-revision";
import { ErrorCode } from "../../../lib/api-errors";
import { apiError } from "../../../lib/api-response";
import { logger } from "../../../lib/logger";

const MAX_LISTEN_BODY_BYTES = 1_000_000;
const MAX_LISTEN_MESSAGES = 200;

const listenRequestSchema = z.object({
  source: z.string({ error: "source 不能为空" }).min(1, "source 不能为空"),
  sourceType: z.enum(["listen", "chat", "ingest", "manual", "mcp", "skill"]).default("listen"),
  title: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1),
        timestamp: z.string().optional(),
      }),
    )
    .min(1, "messages 至少需要一条消息")
    .max(MAX_LISTEN_MESSAGES, `messages 不能超过 ${MAX_LISTEN_MESSAGES} 条`),
  tags: z.array(z.string()).optional(),
  topic: z.string().optional(),
  metadata: z
    .object({
      url: z.string().optional(),
      platform: z.string().optional(),
      model: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * POST /api/listen
 *
 * 外部工具（Trae IDE、浏览器 AI 会话等）通过此端点将对话数据发送到
 * Auto-Memories-Doll。系统自动完成：
 * 1. 格式化对话为 Markdown
 * 2. 自动提取话题
 * 3. 生成知识卡片摘要
 * 4. 将唯一候选记录写入待审计队列
 * 5. 审计通过后由 Orchestrator 写入带稳定 memoryId 的 Markdown
 */
export async function POST(request: NextRequest) {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength > MAX_LISTEN_BODY_BYTES) {
      return NextResponse.json(
        apiError(ErrorCode.VALIDATION_FAILED, `请求体不能超过 ${MAX_LISTEN_BODY_BYTES} bytes`),
        { status: 413 },
      );
    }
  }

  let body: unknown;
  let rawBody: string;
  try {
    rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_LISTEN_BODY_BYTES) {
      return NextResponse.json(
        apiError(ErrorCode.VALIDATION_FAILED, `请求体不能超过 ${MAX_LISTEN_BODY_BYTES} bytes`),
        { status: 413 },
      );
    }
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(apiError(ErrorCode.INVALID_JSON, "请求体不是有效 JSON"), {
      status: 400,
    });
  }

  const parsed = listenRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, parsed.error.issues[0]?.message || "请求参数校验失败"),
      { status: 400 },
    );
  }

  const data = parsed.data;
  let agent: KnowledgeAgent | undefined;
  let statsService: ListenStatsService | undefined;

  try {
    agent = new KnowledgeAgent();
    statsService = new ListenStatsService();
    const sourceEvent = createSourceRevisionEvent({
      sourceType: "listen",
      sourceKey: listenSourceIdentity(data, rawBody),
      content: rawBody,
      operation: "add",
    });
    const result = await agent.ingestSourceRevision({ event: sourceEvent, conversation: data });
    const memoryId = result.memoryIds[0];
    const topic = result.topic;
    const knowledgeCard = result.knowledgeCard;
    if (!memoryId || !topic || !knowledgeCard) {
      throw new Error(`监听来源没有生成候选: ${sourceEvent.sourceId}`);
    }
    const filePath = getNotePath(topic, memoryId);

    statsService.record(data.source, topic, true);

    return NextResponse.json({
      success: true,
      memoryId,
      topic,
      filePath,
      knowledgeCard: {
        title: knowledgeCard.title,
        summary: knowledgeCard.summary,
        content: knowledgeCard.content,
        tags: knowledgeCard.tags,
        topic: knowledgeCard.topic,
      },
      message: `已接收来自 "${data.source}" 的对话，话题: ${topic}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.api.error("POST /api/listen 处理失败", {
      message: detail,
      stack: error instanceof Error ? error.stack : undefined,
    });
    try {
      statsService?.record(data.source, data.topic || "unknown", false);
    } catch (statsError) {
      logger.api.error("POST /api/listen 失败统计写入失败", {
        message: statsError instanceof Error ? statsError.message : String(statsError),
      });
    }
    return NextResponse.json(apiError(ErrorCode.INTERNAL_ERROR, "监听请求处理失败"), {
      status: 500,
    });
  } finally {
    agent?.close();
    statsService?.close();
  }
}

function listenSourceIdentity(data: z.infer<typeof listenRequestSchema>, rawBody: string): string {
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const externalId = metadata?.conversationId ?? metadata?.sessionId;
  if (typeof externalId === "string" && externalId.trim()) {
    return `${data.source}:${externalId.trim()}`;
  }
  if (data.metadata?.url) return `${data.source}:${data.metadata.url}`;
  if (data.title?.trim()) return `${data.source}:${data.title.trim()}`;
  return `${data.source}:${createSourceRevision(rawBody)}`;
}

/**
 * GET /api/listen
 * 返回监听器状态，供外部工具检查服务是否就绪
 */
export async function GET() {
  const statsService = new ListenStatsService();
  const stats = statsService.getStats();
  statsService.close();
  const agent = new KnowledgeAgent();
  const sources = agent.listSources();
  const progress = agent.listRecentProgress();
  agent.close();

  // 动态 import：避免路由 bundle 在模块加载期触发 watcher 模块的启动副作用，
  // 同时解决 dev 模式下 instrumentation 与路由模块实例隔离导致的状态不可见
  const { getFileWatcherStatus } = await import("../../../server/watchers/file-watcher");
  const { getActiveSources } = await import("../../../server/watchers/tool-dir-watcher");

  return NextResponse.json({
    status: "listening",
    uptime: process.uptime(),
    stats,
    agent: { sources, progress },
    watchers: {
      fileWatcher: getFileWatcherStatus(),
      toolSources: getActiveSources(),
    },
    endpoints: {
      post: "POST /api/listen - 发送对话数据",
      get: "GET  /api/listen - 查看监听状态",
      scan: "POST /api/listen/scan - 手动重扫记忆库与监听源",
      import: "POST /api/listen/import - 导入本地消息记录文件",
    },
    example: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        source: "trae-ide",
        sourceType: "listen",
        messages: [
          { role: "user", content: "帮我写一个排序算法" },
          { role: "assistant", content: "好的，这是快速排序的实现..." },
        ],
        metadata: {
          platform: "Trae IDE",
          model: "claude-sonnet-4-20250514",
        },
      },
    },
  });
}
