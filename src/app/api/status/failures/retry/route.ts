import { NextRequest, NextResponse } from "next/server";
import { failedTaskRetryRequestSchema } from "../../../../../config/api-route-contracts";
import { MemoryService } from "../../../../../server/services/memory-service";
import { ErrorCode } from "../../../../../lib/api-errors";
import { apiError, apiResponse } from "../../../../../lib/api-response";
import { logger } from "../../../../../lib/logger";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json(apiError(ErrorCode.VALIDATION_FAILED, "仅允许从当前页面重试任务"), {
      status: 403,
    });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return NextResponse.json(apiError(ErrorCode.VALIDATION_FAILED, "请使用 JSON 请求体"), {
      status: 415,
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError(ErrorCode.INVALID_JSON, "请求体格式无效"), { status: 400 });
  }
  const parsed = failedTaskRetryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(apiError(ErrorCode.VALIDATION_FAILED, "任务 ID 无效"), {
      status: 400,
    });
  }
  const service = new MemoryService();
  try {
    const result = service.retryFailedTask(parsed.data.eventId);
    if (result === "not_found") {
      return NextResponse.json(apiError(ErrorCode.NOT_FOUND, "任务不存在"), { status: 404 });
    }
    if (result === "not_ready") {
      return NextResponse.json(
        apiError(ErrorCode.VALIDATION_FAILED, "任务状态已变化或仍由后台自动重试"),
        { status: 409 },
      );
    }
    return NextResponse.json(apiResponse({ eventId: parsed.data.eventId, status: "pending" }));
  } catch (error) {
    logger.api.error("手动重试失败", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(apiError(ErrorCode.INTERNAL_ERROR, "手动重试失败"), { status: 500 });
  } finally {
    service.close();
  }
}
