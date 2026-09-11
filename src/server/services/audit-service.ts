import { ConflictRecord } from "../../types/memory";
import { getDatabase } from "../../lib/storage/database";
import Database from "better-sqlite3";

export class AuditService {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conflict_records (
        conflictId TEXT PRIMARY KEY,
        memoryId TEXT,
        eventId TEXT,
        field TEXT,
        existingValue TEXT,
        candidateValue TEXT,
        status TEXT,
        resolution TEXT,
        createdAt TEXT,
        resolvedAt TEXT
      )
    `);
  }

  listConflicts(status?: string): ConflictRecord[] {
    let stmt: Database.Statement;
    if (status) {
      stmt = this.db.prepare("SELECT * FROM conflict_records WHERE status = ?");
    } else {
      stmt = this.db.prepare("SELECT * FROM conflict_records");
    }

    const rows = status ? (stmt.all(status) as any[]) : (stmt.all() as any[]);
    return rows.map((row) => ({
      conflictId: row.conflictId,
      memoryId: row.memoryId,
      eventId: row.eventId,
      field: row.field,
      existingValue: row.existingValue,
      candidateValue: row.candidateValue,
      status: row.status as ConflictRecord["status"],
      resolution: row.resolution,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    }));
  }

  close(): void {
    // shared connection — no-op
  }
}
