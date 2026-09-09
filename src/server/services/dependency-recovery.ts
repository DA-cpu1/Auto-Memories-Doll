import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "../../lib/storage/database";
import { KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import { MemoryService } from "./memory-service";
import { SourceRegistry } from "./source-registry";
import type { MemoryRecord, PendingEvent } from "../../types/memory";
import { dependencyConfig } from "../../config/dependency.config";

export class DependencyRecovery {
  private db = getDatabase();
  private memory = new MemoryService();
  private sources = new SourceRegistry();

  constructor() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS recovery_batches (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, createdAt TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS recovery_items (
      batchId TEXT NOT NULL, eventId TEXT NOT NULL, fingerprint TEXT NOT NULL,
      sourceId TEXT, reason TEXT NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (batchId, eventId)
    )`);
  }

  waiting() {
    return this.memory.getEventsByStatus("waiting_dependency").map((event) => ({
      eventId: event.eventId,
      memoryId: event.memoryId,
      sourceId: event.sourceId,
      title: (JSON.parse(event.candidate) as MemoryRecord).title,
      dependency: event.dependency,
    }));
  }

  retry(eventId: string): boolean {
    const event = this.memory.getEvent(eventId);
    if (!event || event.status !== "waiting_dependency" || !event.dependency) return false;
    KnowledgeModelAdapter.resetCapability(event.dependency.slot);
    if (KnowledgeModelAdapter.dependencyReason(event.dependency.slot)) return false;
    this.memory.updateEvent({ ...event, status: "pending", dependency: undefined });
    return true;
  }

  private fingerprint(event: PendingEvent): string {
    return createHash("sha256").update(JSON.stringify(event)).digest("hex");
  }

  private eligibility(event: PendingEvent): string {
    if (event.status !== "review" || event.decisionReasonCode !== "VECTOR_RECALL_UNAVAILABLE")
      return "NOT_VECTOR_ONLY_REVIEW";
    const candidate = JSON.parse(event.candidate) as MemoryRecord;
    if (candidate.updatedAt !== candidate.createdAt) return "EDITED_OR_UNPROVEN";
    if (!event.sourceId || !event.sourceRevision) return "MISSING_SOURCE_EVIDENCE";
    const source = this.sources.getSource(event.sourceId);
    if (!source) return "SOURCE_REMOVED";
    const version = this.sources.getVersion(event.sourceId, event.sourceRevision);
    if (
      source.sourceType === "codex" &&
      version?.normalizationReport.dialogue?.policyVersion !== "codex-final-dialogue-v1"
    )
      return "KA002_EVIDENCE_REQUIRED";
    const conflicts = this.db
      .prepare("SELECT 1 FROM conflict_records WHERE eventId = ? LIMIT 1")
      .get(event.eventId);
    if (conflicts) return "CONTENT_CONFLICT";
    return source.health === "disabled" ? "SOURCE_DISABLED" : "ELIGIBLE";
  }

  preview(includeDisabled = false) {
    const id = `recovery-${randomUUID()}`;
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO recovery_batches VALUES (?, 'preview', ?)")
        .run(id, new Date().toISOString());
      for (const event of this.memory.getEventsByStatus("review")) {
        const eligibility = this.eligibility(event);
        const reason =
          includeDisabled && eligibility === "SOURCE_DISABLED" ? "SELECTED_DISABLED" : eligibility;
        this.db
          .prepare("INSERT INTO recovery_items VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            id,
            event.eventId,
            this.fingerprint(event),
            event.sourceId ?? null,
            reason,
            reason === "ELIGIBLE" || reason === "SELECTED_DISABLED" ? "pending" : "skipped",
          );
      }
    })();
    return this.report(id);
  }

  latestBatch() {
    const batch = this.db
      .prepare("SELECT id FROM recovery_batches ORDER BY createdAt DESC, rowid DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return batch ? this.report(batch.id) : null;
  }

  report(id: string) {
    const batch = this.db.prepare("SELECT * FROM recovery_batches WHERE id = ?").get(id) as
      { id: string; status: string; createdAt: string } | undefined;
    if (!batch) throw new Error("批次不存在");
    const items = this.db
      .prepare(
        "SELECT eventId, sourceId, reason, status FROM recovery_items WHERE batchId = ? ORDER BY eventId",
      )
      .all(id) as Array<{
      eventId: string;
      sourceId: string | null;
      reason: string;
      status: string;
    }>;
    return { ...batch, items };
  }

  execute(id: string, pause = false) {
    this.report(id);
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE recovery_batches SET status = ? WHERE id = ?")
        .run(pause ? "paused" : "running", id);
      if (pause) return;
      const items = this.db
        .prepare(
          "SELECT eventId, fingerprint, reason FROM recovery_items WHERE batchId = ? AND status = 'pending' LIMIT ?",
        )
        .all(id, dependencyConfig.batchSize) as Array<{
        eventId: string;
        fingerprint: string;
        reason: string;
      }>;
      for (const item of items) {
        const event = this.memory.getEvent(item.eventId);
        const eligible =
          event &&
          this.fingerprint(event) === item.fingerprint &&
          (this.eligibility(event) === "ELIGIBLE" ||
            (item.reason === "SELECTED_DISABLED" && this.eligibility(event) === "SOURCE_DISABLED"));
        if (eligible) this.memory.updateEvent({ ...event, status: "pending" });
        this.db
          .prepare(
            "UPDATE recovery_items SET status = ?, reason = ? WHERE batchId = ? AND eventId = ?",
          )
          .run(
            eligible ? "queued" : "skipped",
            eligible ? "VECTOR_RECALL_UNAVAILABLE" : "CHANGED_SINCE_PREVIEW",
            id,
            item.eventId,
          );
      }
      const remaining = this.db
        .prepare("SELECT 1 FROM recovery_items WHERE batchId = ? AND status = 'pending' LIMIT 1")
        .get(id);
      if (!remaining)
        this.db.prepare("UPDATE recovery_batches SET status = 'done' WHERE id = ?").run(id);
    })();
    return this.report(id);
  }

  resumeBatches(): void {
    const batch = this.db
      .prepare(
        "SELECT id FROM recovery_batches WHERE status = 'running' ORDER BY createdAt LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (batch) this.execute(batch.id);
  }
}
