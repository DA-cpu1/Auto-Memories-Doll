import { NextRequest, NextResponse } from "next/server";
import { MemoryService } from "../../../../server/services/memory-service";
import { ErrorCode } from "../../../../lib/api-errors";
import { apiError, apiResponse } from "../../../../lib/api-response";
import { logger } from "../../../../lib/logger";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 10;

export async function GET(request: NextRequest) {
  const rawPage = Number(request.nextUrl.searchParams.get("page") || "1");
  if (!Number.isSafeInteger(rawPage) || rawPage < 1) {
    return NextResponse.json(apiError(ErrorCode.VALIDATION_FAILED, "页码无效"), { status: 400 });
  }
  const service = new MemoryService();
  try {
    return NextResponse.json(
      apiResponse({
        ...service.listFailedTasks(rawPage, PAGE_SIZE),
        page: rawPage,
        pageSize: PAGE_SIZE,
      }),
    );
  } catch (error) {
    logger.api.error("读取失败任务失败", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(apiError(ErrorCode.INTERNAL_ERROR, "读取失败任务失败"), {
      status: 500,
    });
  } finally {
    service.close();
  }
}
