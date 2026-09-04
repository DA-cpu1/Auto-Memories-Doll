import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { SourceRevisionEvent } from "../../types/source";

export const sourceTypeSchema = z.enum([
  "markdown",
  "text",
  "codex",
  "claude-code",
  "cursor",
  "trae",
  "listen",
]);

export const sourceRevisionOperationSchema = z.enum(["add", "change", "delete", "rescan"]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "revision 必须是 sha256");

export const sourceRevisionEventSchema = z
  .object({
    eventId: z.string().regex(/^source-event-[a-f0-9]{32}$/),
    sourceId: z.string().regex(/^source-[a-f0-9]{32}$/),
    sourceType: sourceTypeSchema,
    sourcePath: z.string().min(1).optional(),
    revision: sha256Schema,
    observedAt: z.string().datetime({ offset: true }),
    operation: sourceRevisionOperationSchema,
  })
  .strict();

type CreateSourceRevisionEventInput = {
  sourceType: SourceRevisionEvent["sourceType"];
  sourcePath?: string;
  sourceKey?: string;
  content: string | Buffer;
  operation: SourceRevisionEvent["operation"];
  observedAt?: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSourcePath(sourcePath: string): string {
  return resolve(sourcePath).replace(/\\/g, "/");
}

export function createSourceId(sourceType: SourceRevisionEvent["sourceType"], identity: string) {
  const normalizedIdentity = identity.replace(/\\/g, "/").trim();
  return `source-${sha256(`${sourceType}:${normalizedIdentity}`).slice(0, 32)}`;
}

export function createSourceRevision(content: string | Buffer): string {
  return sha256(content);
}

export function createSourceRevisionEvent(
  input: CreateSourceRevisionEventInput,
): SourceRevisionEvent {
  const sourcePath = input.sourcePath ? normalizeSourcePath(input.sourcePath) : undefined;
  const identity = sourcePath ?? input.sourceKey?.trim();
  if (!identity) throw new Error("sourcePath 或 sourceKey 至少需要一个");

  const sourceId = createSourceId(input.sourceType, identity);
  const revision = createSourceRevision(input.content);
  const eventId = `source-event-${sha256(`${sourceId}:${revision}`).slice(0, 32)}`;

  return parseSourceRevisionEvent({
    eventId,
    sourceId,
    sourceType: input.sourceType,
    sourcePath,
    revision,
    observedAt: input.observedAt ?? new Date().toISOString(),
    operation: input.operation,
  });
}

export function parseSourceRevisionEvent(value: unknown): SourceRevisionEvent {
  return sourceRevisionEventSchema.parse(value) as SourceRevisionEvent;
}

export function safeParseSourceRevisionEvent(value: unknown) {
  return sourceRevisionEventSchema.safeParse(value);
}
