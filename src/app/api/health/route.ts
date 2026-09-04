import { NextResponse } from "next/server";
import { KnowledgeModelAdapter } from "../../../lib/ai/knowledge-model-adapter";

export const dynamic = "force-dynamic";

export async function GET() {
  const degradedCapabilities = KnowledgeModelAdapter.getDegradedCapabilities();
  return NextResponse.json({
    degraded: degradedCapabilities.length > 0,
    degradedCapabilities,
    timestamp: Date.now(),
  });
}
