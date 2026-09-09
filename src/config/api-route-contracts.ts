import { z } from "zod";
import { codexDialogueDiagnosticsSchema } from "../types/codex-dialogue";

export const dependencyActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry"), eventId: z.string().min(1) }),
  z.object({ action: z.literal("preview"), includeDisabled: z.boolean().optional() }),
  z.object({ action: z.enum(["execute", "pause", "report"]), batchId: z.string().min(1) }),
]);

const recoveryBatchSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  items: z.array(
    z.object({
      eventId: z.string(),
      sourceId: z.string().nullable(),
      reason: z.string(),
      status: z.string(),
    }),
  ),
});

export const dependencyResponseSchema = z.union([
  z.object({
    latestBatch: recoveryBatchSchema.nullable().optional(),
    vectorStates: z.record(z.string(), z.number().int().nonnegative()).optional(),
    items: z.array(
      z.object({
        eventId: z.string(),
        memoryId: z.string(),
        title: z.string(),
        sourceId: z.string().optional(),
        dependency: z
          .object({
            slot: z.enum(["flagship", "standard", "budget", "embedding"]),
            stage: z.string(),
            reason: z.string(),
            attempts: z.number().int(),
            lastAttemptAt: z.string(),
            nextAttemptAt: z.string().optional(),
            paused: z.boolean(),
            configFingerprint: z.string(),
          })
          .optional(),
      }),
    ),
  }),
  recoveryBatchSchema,
  z.object({ success: z.boolean() }),
  z.object({ error: z.enum(["VALIDATION_FAILED", "INTERNAL_ERROR"]) }),
]);

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
  "src/app/api/audit/dependencies/route.ts": {
    requestSchema: "dependencyActionSchema",
    responseSchema: "dependencyResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/audit/route.ts": {
    requestSchema: "auditActionSchema",
    responseSchema: "auditResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "INTERNAL_ERROR"],
  },
  "src/app/api/audit/conflicts/route.ts": {
    requestSchema: "conflictResolveSchema",
    responseSchema: "conflictResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "NOT_FOUND", "AUDIT_CONFLICT", "INTERNAL_ERROR"],
  },
  "src/app/api/audit/review-events/route.ts": {
    requestSchema: "reviewDecisionSchema",
    responseSchema: "reviewEventsResponseSchema",
    errorCodes: ["VALIDATION_FAILED", "NOT_FOUND", "INTERNAL_ERROR"],
  },
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
