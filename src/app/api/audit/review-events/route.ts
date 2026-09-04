import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { KnowledgeAgent } from "../../../../server/services/knowledge-agent";
import { MemoryRecord } from "../../../../types/memory";

/** GET：列出待人工裁决的 review 事件（含候选记忆摘要） */
export async function GET() {
  const agent = new KnowledgeAgent();
  try {
    const items = agent.getReviewEvents().map((event) => {
      let candidate: MemoryRecord | null = null;
      try {
        candidate = JSON.parse(event.candidate) as MemoryRecord;
      } catch {
        // candidate 损坏时仍返回事件骨架
      }
      return {
        eventId: event.eventId,
        memoryId: event.memoryId,
        sourceType: event.sourceType,
        createdAt: event.createdAt,
        retryCount: event.retryCount,
        candidate: candidate
          ? {
              title: candidate.title,
              summary: candidate.summary,
              contentPreview: candidate.content.slice(0, 500),
              tags: candidate.tags,
            }
          : null,
      };
    });

    return NextResponse.json({ items });
  } finally {
    agent.close();
  }
}

const reviewDecisionSchema = z.object({
  eventId: z.string().min(1),
  action: z.enum(["accept", "reject"]),
});

/** POST：人工裁决 —— accept 跳过闸门落盘；reject 终态拒绝 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是合法的 JSON" }, { status: 400 });
  }

  const parsed = reviewDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const agent = new KnowledgeAgent();
  try {
    const event = await agent.resolveReviewEvent(parsed.data.eventId, parsed.data.action);
    return NextResponse.json({ success: true, status: event.status });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  } finally {
    agent.close();
  }
}
