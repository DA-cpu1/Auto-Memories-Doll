import { createHash } from "node:crypto";
import { getDatabase } from "../../lib/storage/database";
import { KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import type { MemoryRecord, PendingEvent } from "../../types/memory";

export class ProcessingCheckpoints {
  private db = getDatabase();

  constructor() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processing_checkpoints (
        eventId TEXT NOT NULL, stage TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (eventId, stage)
      );
      CREATE TABLE IF NOT EXISTS content_references (
        eventId TEXT PRIMARY KEY, memoryId TEXT NOT NULL, targetMemoryId TEXT NOT NULL,
        sourceId TEXT, sourceRevision TEXT, sourceEventId TEXT, createdAt TEXT NOT NULL
      );
    `);
  }

  private fingerprint(candidate: MemoryRecord, stage: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "ka-003-final-json-v2",
          candidate,
          KnowledgeModelAdapter.configurationFingerprint(
            stage === "topic" ? "standard" : "flagship",
          ),
        ]),
      )
      .digest("hex");
  }

  read<T>(event: PendingEvent, candidate: MemoryRecord, stage: string): T | undefined {
    const row = this.db
      .prepare(
        "SELECT result FROM processing_checkpoints WHERE eventId = ? AND stage = ? AND fingerprint = ?",
      )
      .get(event.eventId, stage, this.fingerprint(candidate, stage)) as
      { result: string } | undefined;
    return row ? (JSON.parse(row.result) as T) : undefined;
  }

  write(event: PendingEvent, candidate: MemoryRecord, stage: string, result: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO processing_checkpoints VALUES (?, ?, ?, ?)")
      .run(event.eventId, stage, this.fingerprint(candidate, stage), JSON.stringify(result));
  }

  isSuperseded(event: PendingEvent): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM pending_events WHERE memoryId = ? AND eventId != ? AND createdAt > ? AND status != 'rejected' LIMIT 1`,
        )
        .get(event.memoryId, event.eventId, event.createdAt),
    );
  }

  exactDuplicate(event: PendingEvent, candidate: MemoryRecord): string | undefined {
    const published = this.db
      .prepare("SELECT id FROM memories WHERE id != ? AND content = ? LIMIT 1")
      .get(event.memoryId, candidate.content) as { id: string } | undefined;
    if (published) return published.id;
    // Processed source bodies are retained in the queue even when the published card is rewritten.
    const rows = this.db
      .prepare(
        `SELECT memoryId, candidate FROM pending_events WHERE memoryId != ? AND (status IN ('pending','processing','waiting_dependency','review') OR (status = 'done' AND memoryId IN (SELECT id FROM memories))) AND (createdAt < ? OR (createdAt = ? AND eventId < ?)) ORDER BY createdAt, eventId`,
      )
      .all(event.memoryId, event.createdAt, event.createdAt, event.eventId) as Array<{
      memoryId: string;
      candidate: string;
    }>;
    return rows.find(
      (row) => (JSON.parse(row.candidate) as MemoryRecord).content === candidate.content,
    )?.memoryId;
  }

  recordReference(event: PendingEvent, target: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO content_references VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        event.eventId,
        event.memoryId,
        target,
        event.sourceId ?? null,
        event.sourceRevision ?? null,
        event.sourceEventId ?? null,
        new Date().toISOString(),
      );
  }
}
