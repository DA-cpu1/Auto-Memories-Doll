import { NextRequest, NextResponse } from "next/server";
import { dependencyActionSchema } from "../../../../config/api-route-contracts";
import { DependencyRecovery } from "../../../../server/services/dependency-recovery";
import { VectorBackfill } from "../../../../server/services/vector-backfill";

export async function GET() {
  const recovery = new DependencyRecovery();
  return NextResponse.json({
    items: recovery.waiting(),
    latestBatch: recovery.latestBatch(),
    vectorStates: new VectorBackfill().counts(),
  });
}

export async function POST(request: NextRequest) {
  const parsed = dependencyActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 400 });
  const recovery = new DependencyRecovery();
  try {
    const command = parsed.data;
    if (command.action === "retry")
      return NextResponse.json({ success: recovery.retry(command.eventId) });
    if (command.action === "preview")
      return NextResponse.json(recovery.preview(command.includeDisabled));
    if (command.action === "report") return NextResponse.json(recovery.report(command.batchId));
    return NextResponse.json(recovery.execute(command.batchId, command.action === "pause"));
  } catch {
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
