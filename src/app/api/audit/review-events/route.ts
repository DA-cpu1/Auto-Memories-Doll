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
      const progress = event.sourceEventId
        ? agent.listProgress({ eventId: event.sourceEventId }).at(-1)
        : undefined;
      return {
        eventId: event.eventId,
        memoryId: event.memoryId,
        sourceType: event.sourceType,
        createdAt: event.createdAt,
        retryCount: event.retryCount,
        sourceId: event.sourceId,
        sourceRevision: event.sourceRevision,
        reasonCode: event.decisionReasonCode ?? progress?.errorCode ?? "MANUAL_REVIEW",
        reason: event.decisionReason ?? progress?.error ?? "质量闸门要求人工确认",
        candidate: candidate
          ? {
              title: candidate.title,
              summary: candidate.summary,
              content: candidate.content,
              tags: candidate.tags,
              topic: candidate.topic,
              kind: candidate.kind ?? "fact",
              evidence: candidate.evidence,
              source: candidate.source,
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
  candidate: z
    .object({
      title: z.string().trim().min(1).max(240),
      summary: z.string().trim().min(1).max(2000),
      content: z.string().trim().min(1),
      tags: z.array(z.string().trim().min(1).max(80)).max(30),
      topic: z.string().trim().min(1).max(128),
    })
    .strict()
    .optional(),
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
    if (parsed.data.action === "accept" && parsed.data.candidate) {
      agent.updateReviewCandidate(parsed.data.eventId, parsed.data.candidate);
    }
    const event = await agent.resolveReviewEvent(parsed.data.eventId, parsed.data.action);
    return NextResponse.json({ success: true, status: event.status });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  } finally {
    agent.close();
  }
}
