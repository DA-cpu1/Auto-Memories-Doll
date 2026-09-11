import { z } from "zod";
import { codexDialogueDiagnosticsSchema } from "../types/codex-dialogue";

export const healthResponseSchema = z.object({
  degraded: z.boolean(),
  degradedCapabilities: z.array(z.enum(["llm", "embedding"])),
  failures: z.array(
    z.object({
      slot: z.enum(["budget", "standard", "flagship", "embedding"]),
      model: z.string(),
      reason: z.string(),
      failedAt: z.string().optional(),
      retryAt: z.string().optional(),
      durationMs: z.number().nonnegative().optional(),
      purpose: z.enum(["processing", "health-check"]).optional(),
    }),
  ),
  timestamp: z.number(),
});

export const listenStatusAgentSchema = z.object({
  sources: z.array(
    z
      .object({
        sourceId: z.string(),
        dialogue: codexDialogueDiagnosticsSchema.optional(),
      })
      .passthrough(),
  ),
  progress: z.array(z.unknown()),
});

export type ApiRouteContract = {
  requestSchema?: string;
  responseSchema: string;
  errorCodes: readonly string[];
  statusAgentSchema?: string;
};

export const apiRouteContracts: Record<string, ApiRouteContract> = {
  "src/app/api/config/ai/route.ts": {
    requestSchema: "aiConfigSchema",
    responseSchema: "aiConfigResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/config/ai/test/route.ts": {
    requestSchema: "aiConfigTestSchema",
    responseSchema: "aiConfigTestResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/config/storage/route.ts": {
    requestSchema: "storageConfigUpdateSchema",
    responseSchema: "storageConfigResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/config/tool-sources/route.ts": {
    requestSchema: "toolSourceCreateSchema",
    responseSchema: "toolSourceListResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/config/tool-sources/[id]/route.ts": {
    requestSchema: "toolSourceUpdateSchema",
    responseSchema: "toolSourceResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "NOT_FOUND", "INTERNAL_ERROR"],
  },
  "src/app/api/config/tool-sources/status/route.ts": {
    responseSchema: "toolSourceStatusResponseSchema",
    errorCodes: ["INTERNAL_ERROR"],
  },
  "src/app/api/health/route.ts": {
    responseSchema: "healthResponseSchema",
    errorCodes: [],
  },
  "src/app/api/ingest/route.ts": {
    requestSchema: "ingestRequestSchema",
    responseSchema: "ingestResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INGEST_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/listen/route.ts": {
    statusAgentSchema: "listenStatusAgentSchema",
    requestSchema: "listenRequestSchema",
    responseSchema: "listenResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INVALID_JSON", "INTERNAL_ERROR"],
  },
  "src/app/api/listen/scan/route.ts": {
    responseSchema: "listenScanResponseSchema",
    errorCodes: ["INTERNAL_ERROR"],
  },
  "src/app/api/listen/import/route.ts": {
    responseSchema: "listenImportResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/listen/rebuild/route.ts": {
    responseSchema: "listenRebuildResponseSchema",
    errorCodes: ["INTERNAL_ERROR"],
  },
  "src/app/api/memory/route.ts": {
    requestSchema: "memoryCreateSchema",
    responseSchema: "memoryResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "MEMORY_CREATE_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/memory/search/route.ts": {
    responseSchema: "memorySearchResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "MEMORY_VECTOR_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/memory/[id]/route.ts": {
    requestSchema: "memoryUpdateSchema",
    responseSchema: "memoryDetailResponseSchema",
    errorCodes: [
      "VALIDATION_FAILED",
      "NOT_FOUND",
      "MEMORY_UPDATE_FAILED",
      "MEMORY_DELETE_FAILED",
      "INTERNAL_ERROR",
    ],
  },
  "src/app/api/memory/rebuild/route.ts": {
    responseSchema: "memoryRebuildResponseSchema",
    errorCodes: ["INTERNAL_ERROR"],
  },
  "src/app/api/memory/[id]/access/route.ts": {
    responseSchema: "memoryAccessResponseSchema",
    errorCodes: ["NOT_FOUND", "INTERNAL_ERROR"],
  },
  "src/app/api/topics/[topic]/route.ts": {
    requestSchema: "studyGuideGenerateRequestSchema",
    responseSchema: "studyGuideResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "NOT_FOUND", "GUIDE_GENERATION_FAILED", "INTERNAL_ERROR"],
  },
};
