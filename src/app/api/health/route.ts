import { NextResponse } from "next/server";
import { KnowledgeModelAdapter } from "../../../lib/ai/knowledge-model-adapter";

export async function GET() {
  return NextResponse.json({
    degraded: KnowledgeModelAdapter.isDegradedMode,
    timestamp: Date.now(),
  });
}
