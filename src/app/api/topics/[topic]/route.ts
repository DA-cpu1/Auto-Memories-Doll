import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ErrorCode } from "../../../../lib/api-errors";
import { apiError, apiResponse } from "../../../../lib/api-response";
import { studyGuideGenerateRequestSchema } from "../../../../lib/study-guide/schema";
import { StudyGuideBuilder } from "../../../../server/services/study-guide-builder";

const topicSchema = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u, "话题标识不合法");

export async function GET(_request: NextRequest, { params }: { params: { topic: string } }) {
  const parsedTopic = topicSchema.safeParse(params.topic);
  if (!parsedTopic.success) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, parsedTopic.error.issues[0].message),
      { status: 400 },
    );
  }
  const builder = new StudyGuideBuilder();
  try {
    const guide = await builder.getGuide(parsedTopic.data);
    if (!guide)
      return NextResponse.json(apiError(ErrorCode.NOT_FOUND, "主题学习资料不存在"), {
        status: 404,
      });
    return NextResponse.json(apiResponse(guide));
  } finally {
    builder.close();
  }
}

export async function POST(request: NextRequest, { params }: { params: { topic: string } }) {
  const parsedTopic = topicSchema.safeParse(params.topic);
  if (!parsedTopic.success) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, parsedTopic.error.issues[0].message),
      { status: 400 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError(ErrorCode.INVALID_JSON, "请求体格式无效"), { status: 400 });
  }
  const parsed = studyGuideGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, parsed.error.issues[0].message),
      { status: 400 },
    );
  }
  const builder = new StudyGuideBuilder();
  try {
    const guide = await builder.generateTopic(parsedTopic.data, parsed.data);
    if (!guide)
      return NextResponse.json(apiError(ErrorCode.NOT_FOUND, "该主题没有已接受知识"), {
        status: 404,
      });
    return NextResponse.json(apiResponse(guide));
  } catch (error) {
    return NextResponse.json(
      apiError(ErrorCode.GUIDE_GENERATION_FAILED, (error as Error).message),
      { status: 500 },
    );
  } finally {
    builder.close();
  }
}
