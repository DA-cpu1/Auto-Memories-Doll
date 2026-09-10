import { NextResponse } from "next/server";
import { KnowledgeModelAdapter } from "../../../lib/ai/knowledge-model-adapter";
import { healthResponseSchema } from "../../../config/api-route-contracts";

export const dynamic = "force-dynamic";

export async function GET() {
  const degradedCapabilities = KnowledgeModelAdapter.getDegradedCapabilities();
  return NextResponse.json(
    healthResponseSchema.parse({
      degraded: degradedCapabilities.length > 0,
      degradedCapabilities,
      failures: KnowledgeModelAdapter.getFailures(),
      timestamp: Date.now(),
    }),
  );
}
