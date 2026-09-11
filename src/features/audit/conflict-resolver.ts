import { MemoryRecord } from "../../types/memory";
import { validateMemoryRecord } from "../../lib/memory/validator";

export type ConflictResolution =
  { action: "auto_merge"; merged: Partial<MemoryRecord> } | { action: "reject"; reason: string };

/** Latest valid candidate wins only its declared fields. Older events never overwrite newer data. */
export function resolveConflicts(
  existing: MemoryRecord,
  candidate: MemoryRecord,
  changedFields: string[],
): ConflictResolution {
  if (
    !validateMemoryRecord(candidate) ||
    !candidate.content.trim() ||
    candidate.id !== existing.id ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  )
    return { action: "reject", reason: "候选格式无效或身份不一致" };
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt))
    return { action: "auto_merge", merged: {} };
  const merged: Record<string, unknown> = {};
  for (const field of changedFields) {
    if (
      [
        "id",
        "version",
        "createdAt",
        "updatedAt",
        "accessedAt",
        "accessCount",
        "heatScore",
        "vectorId",
      ].includes(field)
    )
      continue;
    if (
      !(field in candidate) ||
      (!(field in existing) &&
        !["kind", "evidence", "titleZh", "summaryZh", "tagsZh", "topicZh"].includes(field))
    )
      continue;
    if (
      JSON.stringify(candidate[field as keyof MemoryRecord]) !==
      JSON.stringify(existing[field as keyof MemoryRecord])
    )
      merged[field] = candidate[field as keyof MemoryRecord];
  }
  if (Object.keys(merged).length) merged.updatedAt = candidate.updatedAt;
  return { action: "auto_merge", merged: merged as Partial<MemoryRecord> };
}
