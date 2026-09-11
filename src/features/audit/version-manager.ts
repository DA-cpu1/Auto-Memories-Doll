import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getArchivePath } from "../../lib/storage/path-resolver";
import { formatMemoryAsMarkdown } from "../../lib/storage/markdown-formatter";
import { MemoryRecord } from "../../types/memory";
import { getDatabase } from "../../lib/storage/database";
import Database from "better-sqlite3";
import { generateId } from "../../lib/utils/id";
import { getCurrentTime } from "../../lib/utils/date";

export type MemorySnapshot = {
  snapshotId: string;
  memoryId: string;
  version: number;
  data: MemoryRecord;
  createdAt: string;
  snapshotPath?: string;
};

export class VersionManager {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_snapshots (
        snapshotId TEXT PRIMARY KEY,
        memoryId TEXT,
        version INTEGER,
        data TEXT,
        createdAt TEXT
      )
    `);
    const columns = this.db.prepare("PRAGMA table_info(memory_snapshots)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "snapshotPath"))
      this.db.exec("ALTER TABLE memory_snapshots ADD COLUMN snapshotPath TEXT");
  }

  createSnapshot(memory: MemoryRecord, version: number): MemorySnapshot {
    const snapshot: MemorySnapshot = {
      snapshotId: generateId(),
      memoryId: memory.id,
      version,
      data: memory,
      createdAt: getCurrentTime(),
    };

    const directory = join(getArchivePath(), "versions");
    mkdirSync(directory, { recursive: true });
    const snapshotPath = join(
      directory,
      `${snapshot.createdAt.replace(/[:.]/g, "-")}-${snapshot.snapshotId}.md`,
    );
    writeFileSync(snapshotPath, formatMemoryAsMarkdown(memory), { encoding: "utf8", flag: "wx" });
    snapshot.snapshotPath = snapshotPath;
    const stmt = this.db.prepare(`
      INSERT INTO memory_snapshots (snapshotId, memoryId, version, data, createdAt, snapshotPath)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snapshot.snapshotId,
      snapshot.memoryId,
      snapshot.version,
      JSON.stringify(snapshot.data),
      snapshot.createdAt,
      snapshotPath,
    );

    return snapshot;
  }

  getSnapshot(memoryId: string, version: number): MemorySnapshot | null {
    const stmt = this.db.prepare(
      "SELECT * FROM memory_snapshots WHERE memoryId = ? AND version = ?",
    );
    const row = stmt.get(memoryId, version) as any;
    if (!row) return null;

    return {
      snapshotId: row.snapshotId,
      memoryId: row.memoryId,
      version: row.version,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
      snapshotPath: row.snapshotPath || undefined,
    };
  }

  listSnapshots(memoryId: string): MemorySnapshot[] {
    const stmt = this.db.prepare(
      "SELECT * FROM memory_snapshots WHERE memoryId = ? ORDER BY version DESC",
    );
    const rows = stmt.all(memoryId) as any[];
    return rows.map((row) => ({
      snapshotId: row.snapshotId,
      memoryId: row.memoryId,
      version: row.version,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
      snapshotPath: row.snapshotPath || undefined,
    }));
  }

  deleteOldSnapshots(memoryId: string, keepVersions: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM memory_snapshots WHERE memoryId = ? AND snapshotId NOT IN (
        SELECT snapshotId FROM memory_snapshots WHERE memoryId = ? ORDER BY version DESC LIMIT ?
      )
    `);
    stmt.run(memoryId, memoryId, keepVersions);
  }

  close(): void {
    // shared connection — no-op
  }
}
