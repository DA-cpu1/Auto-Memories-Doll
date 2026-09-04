import { join } from "node:path";
import Database from "better-sqlite3";
import { getDatabase } from "../../lib/storage/database";
import {
  createSourceId,
  normalizeSourcePath,
  parseSourceRevisionEvent,
} from "../../lib/source/source-revision";
import type { ToolWatchSource } from "../../types/config";
import type {
  SourceDocument,
  SourceHealth,
  SourceRevisionEvent,
  SourceType,
} from "../../types/source";

export type SourceRevisionDisposition = "new" | "changed" | "unchanged";

export type SourceObservation = {
  disposition: SourceRevisionDisposition;
  source: SourceDocument;
};

type SourceDocumentRow = {
  sourceId: string;
  sourceType: string;
  sourcePath: string | null;
  latestRevision: string | null;
  health: string;
  lastObservedAt: string | null;
  lastProcessedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SourceRegistry {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDatabase()) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_documents (
        sourceId TEXT PRIMARY KEY,
        sourceType TEXT NOT NULL,
        sourcePath TEXT,
        latestRevision TEXT,
        health TEXT NOT NULL DEFAULT 'unknown',
        lastObservedAt TEXT,
        lastProcessedAt TEXT,
        lastError TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
  }

  beginObservation(value: SourceRevisionEvent): SourceObservation {
    const event = parseSourceRevisionEvent(value);
    const existing = this.getSource(event.sourceId);
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(
          `UPDATE source_documents
             SET sourceType = ?, sourcePath = ?, lastObservedAt = ?, updatedAt = ?
           WHERE sourceId = ?`,
        )
        .run(event.sourceType, event.sourcePath ?? null, event.observedAt, now, event.sourceId);
    } else {
      this.db
        .prepare(
          `INSERT INTO source_documents (
             sourceId, sourceType, sourcePath, latestRevision, health,
             lastObservedAt, lastProcessedAt, lastError, createdAt, updatedAt
           ) VALUES (?, ?, ?, NULL, 'unknown', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          event.sourceId,
          event.sourceType,
          event.sourcePath ?? null,
          event.observedAt,
          now,
          now,
        );
    }

    const source = this.getSource(event.sourceId)!;
    const disposition: SourceRevisionDisposition = !existing
      ? "new"
      : existing.latestRevision === event.revision
        ? "unchanged"
        : "changed";
    return { disposition, source };
  }

  markProcessed(event: SourceRevisionEvent): SourceDocument {
    parseSourceRevisionEvent(event);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE source_documents
           SET latestRevision = ?, health = 'healthy', lastProcessedAt = ?,
               lastError = NULL, updatedAt = ?
         WHERE sourceId = ?`,
      )
      .run(event.revision, now, now, event.sourceId);
    return this.requireSource(event.sourceId);
  }

  markFailed(event: SourceRevisionEvent, error: string): SourceDocument {
    parseSourceRevisionEvent(event);
    this.setHealth(event.sourceId, "degraded", error);
    return this.requireSource(event.sourceId);
  }

  setHealth(sourceId: string, health: SourceHealth, error?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE source_documents
           SET health = ?, lastError = ?, updatedAt = ?
         WHERE sourceId = ?`,
      )
      .run(health, error ?? null, now, sourceId);
  }

  registerConfiguredSource(source: ToolWatchSource): SourceDocument {
    const sourcePath = normalizeConfiguredPath(source.path);
    const sourceType = source.toolType as SourceType;
    const sourceId = createSourceId(sourceType, sourcePath);
    const existing = this.getSource(sourceId);
    const now = new Date().toISOString();
    const health: SourceHealth = source.enabled ? (existing?.health ?? "unknown") : "disabled";

    this.db
      .prepare(
        `INSERT INTO source_documents (
           sourceId, sourceType, sourcePath, latestRevision, health,
           lastObservedAt, lastProcessedAt, lastError, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sourceId) DO UPDATE SET
           sourceType = excluded.sourceType,
           sourcePath = excluded.sourcePath,
           health = excluded.health,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        sourceId,
        sourceType,
        sourcePath,
        existing?.latestRevision ?? null,
        health,
        existing?.lastObservedAt ?? null,
        existing?.lastProcessedAt ?? null,
        existing?.lastError ?? null,
        existing?.createdAt ?? now,
        now,
      );

    return this.requireSource(sourceId);
  }

  syncConfiguredSources(sources: ToolWatchSource[]): SourceDocument[] {
    return sources.map((source) => this.registerConfiguredSource(source));
  }

  getSource(sourceId: string): SourceDocument | null {
    const row = this.db
      .prepare("SELECT * FROM source_documents WHERE sourceId = ?")
      .get(sourceId) as SourceDocumentRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listSources(): SourceDocument[] {
    const rows = this.db
      .prepare("SELECT * FROM source_documents ORDER BY updatedAt DESC")
      .all() as SourceDocumentRow[];
    return rows.map((row) => this.mapRow(row));
  }

  close(): void {
    // Shared database connection; lifecycle is owned by closeDatabase().
  }

  private requireSource(sourceId: string): SourceDocument {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`来源不存在: ${sourceId}`);
    return source;
  }

  private mapRow(row: SourceDocumentRow): SourceDocument {
    return {
      sourceId: row.sourceId,
      sourceType: row.sourceType as SourceType,
      sourcePath: row.sourcePath ?? undefined,
      latestRevision: row.latestRevision ?? undefined,
      health: row.health as SourceHealth,
      lastObservedAt: row.lastObservedAt ?? undefined,
      lastProcessedAt: row.lastProcessedAt ?? undefined,
      lastError: row.lastError ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function normalizeConfiguredPath(sourcePath: string): string {
  if (!sourcePath.startsWith("~")) return normalizeSourcePath(sourcePath);
  const homeDirectory = process.env.USERPROFILE || process.env.HOME;
  if (!homeDirectory) return sourcePath.replace(/\\/g, "/");
  return normalizeSourcePath(join(homeDirectory, sourcePath.slice(1)));
}
