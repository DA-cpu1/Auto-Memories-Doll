import { NextRequest, NextResponse } from "next/server";
import { generateId } from "../../../lib/utils/id";
import { AskAgentService } from "../../../server/services/ask-agent-service";
import { askRequestSchema, askStatsResponseSchema } from "../../../config/api-route-contracts";
import { ErrorCode, ERROR_HTTP_STATUS } from "../../../lib/api-errors";
import { apiError, apiResponse } from "../../../lib/api-response";
import { AskStreamEvent } from "../../../types/ask";

export const dynamic = "force-dynamic";

/**
 * POST /api/ask —— 问答 Agent 的 SSE 流式入口。
 * 响应是 text/event-stream，每帧 `data: <AskStreamEvent JSON>`：
 * start → (tool_call | tool_result | token)* → citations | refusal → done | error
 * 请求体校验失败（400）在流开始前以统一 JSON 错误结构返回。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError(ErrorCode.INVALID_JSON, "请求体不是合法 JSON"), {
      status: ERROR_HTTP_STATUS[ErrorCode.INVALID_JSON],
    });
  }

  const parsed = askRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, "question 必须是 1-500 字符的字符串"),
      { status: ERROR_HTTP_STATUS[ErrorCode.VALIDATION_FAILED] },
    );
  }

  const askId = generateId();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let errorSent = false;
      const send = (event: AskStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: "start", askId });

      const service = new AskAgentService();
      try {
        await service.ask({
          question: parsed.data.question,
          onEvent: (event) => {
            if (event.type === "error") errorSent = true;
            send(event);
          },
          signal: request.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!errorSent) {
          send({ type: "error", code: ErrorCode.INTERNAL_ERROR, message });
        }
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // 客户端已断开
          }
          closed = true;
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** GET /api/ask —— 问答累计统计（token 成本可见性） */
export async function GET() {
  const service = new AskAgentService();
  try {
    return NextResponse.json(
      apiResponse(askStatsResponseSchema.parse({ stats: service.getStats() })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(apiError(ErrorCode.INTERNAL_ERROR, message), {
      status: ERROR_HTTP_STATUS[ErrorCode.INTERNAL_ERROR],
    });
  }
}
