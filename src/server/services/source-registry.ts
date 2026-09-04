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
  SourceMemoryLink,
  SourceVersion,
} from "../../types/source";
import type { NormalizationReport, SourceChunk } from "../../types/normalization";

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_versions (
        sourceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        eventId TEXT NOT NULL,
        operation TEXT NOT NULL,
        observedAt TEXT NOT NULL,
        processedAt TEXT NOT NULL,
        normalizationReport TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (sourceId, revision)
      );
      CREATE TABLE IF NOT EXISTS source_chunks (
        sourceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        chunkId TEXT NOT NULL,
        chunkHash TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        locator TEXT,
        boundary TEXT NOT NULL,
        PRIMARY KEY (sourceId, revision, chunkId)
      );
      CREATE INDEX IF NOT EXISTS idx_source_chunks_hash
        ON source_chunks(sourceId, chunkHash);
      CREATE TABLE IF NOT EXISTS source_memory_links (
        sourceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        memoryId TEXT NOT NULL,
        sourceEventId TEXT,
        chunkHash TEXT,
        locator TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, revision, memoryId)
      );
      CREATE INDEX IF NOT EXISTS idx_source_memory_links_memory
        ON source_memory_links(memoryId);
    `);
    this.migrateLegacyMemorySources();
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

  recordVersion(
    event: SourceRevisionEvent,
    report: NormalizationReport,
    chunks: SourceChunk[],
  ): { normalizedUnchanged: boolean } {
    parseSourceRevisionEvent(event);
    const previous = this.db
      .prepare(
        `SELECT revision FROM source_versions
         WHERE sourceId = ? AND revision <> ?
         ORDER BY processedAt DESC LIMIT 1`,
      )
      .get(event.sourceId, event.revision) as { revision: string } | undefined;
    const previousHashes = previous ? this.getChunkHashes(event.sourceId, previous.revision) : [];
    const currentHashes = chunks.map((chunk) => chunk.hash);
    const normalizedUnchanged =
      previousHashes.length > 0 &&
      previousHashes.length === currentHashes.length &&
      previousHashes.every((hash, index) => hash === currentHashes[index]);
    const processedAt = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source_versions (
             sourceId, revision, eventId, operation, observedAt, processedAt, normalizationReport
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sourceId, revision) DO UPDATE SET
             eventId = excluded.eventId,
             operation = excluded.operation,
             observedAt = excluded.observedAt,
             processedAt = excluded.processedAt,
             normalizationReport = excluded.normalizationReport`,
        )
        .run(
          event.sourceId,
          event.revision,
          event.eventId,
          event.operation,
          event.observedAt,
          processedAt,
          JSON.stringify(report),
        );
      this.db
        .prepare("DELETE FROM source_chunks WHERE sourceId = ? AND revision = ?")
        .run(event.sourceId, event.revision);
      const insertChunk = this.db.prepare(
        `INSERT INTO source_chunks (
           sourceId, revision, chunkId, chunkHash, ordinal, locator, boundary
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        insertChunk.run(
          event.sourceId,
          event.revision,
          chunk.chunkId,
          chunk.hash,
          chunk.ordinal,
          chunk.locator ?? null,
          chunk.boundary,
        );
      }
    })();
    return { normalizedUnchanged };
  }

  getVersion(sourceId: string, revision: string): SourceVersion | null {
    const row = this.db
      .prepare("SELECT * FROM source_versions WHERE sourceId = ? AND revision = ?")
      .get(sourceId, revision) as
      (Omit<SourceVersion, "normalizationReport"> & { normalizationReport: string }) | undefined;
    return row ? { ...row, normalizationReport: JSON.parse(row.normalizationReport) } : null;
  }

  linkMemory(link: Omit<SourceMemoryLink, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO source_memory_links (
           sourceId, revision, memoryId, sourceEventId, chunkHash, locator, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sourceId, revision, memoryId) DO UPDATE SET
           sourceEventId = excluded.sourceEventId,
           chunkHash = excluded.chunkHash,
           locator = excluded.locator`,
      )
      .run(
        link.sourceId,
        link.revision,
        link.memoryId,
        link.sourceEventId ?? null,
        link.chunkHash ?? null,
        link.locator ?? null,
        new Date().toISOString(),
      );
  }

  getMemoryLinks(memoryId: string): SourceMemoryLink[] {
    return this.db
      .prepare("SELECT * FROM source_memory_links WHERE memoryId = ? ORDER BY createdAt ASC")
      .all(memoryId) as SourceMemoryLink[];
  }

  private getChunkHashes(sourceId: string, revision: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT chunkHash FROM source_chunks WHERE sourceId = ? AND revision = ? ORDER BY ordinal ASC",
        )
        .all(sourceId, revision) as Array<{ chunkHash: string }>
    ).map((row) => row.chunkHash);
  }

  private migrateLegacyMemorySources(): void {
    const hasMemories = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get();
    if (!hasMemories) return;
    const rows = this.db
      .prepare(
        `SELECT id, source, sourceType, evidence, createdAt, updatedAt
         FROM memories
         WHERE source IS NOT NULL AND source <> ''`,
      )
      .all() as Array<{
      id: string;
      source: string;
      sourceType: string;
      evidence: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    for (const row of rows) {
      let evidence: Record<string, string>;
      try {
        evidence = row.evidence ? JSON.parse(row.evidence) : {};
      } catch {
        continue;
      }
      const revision = evidence.sourceRevision || evidence.sourceHash;
      if (!revision) continue;
      const sourceType = legacySourceType(row.sourceType, row.source);
      const sourceId =
        evidence.sourceId || createSourceId(sourceType, normalizeSourcePath(row.source));
      const timestamp = row.updatedAt || row.createdAt || new Date().toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO source_documents (
             sourceId, sourceType, sourcePath, latestRevision, health,
             lastObservedAt, lastProcessedAt, lastError, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, 'healthy', ?, ?, NULL, ?, ?)`,
        )
        .run(
          sourceId,
          sourceType,
          normalizeSourcePath(row.source),
          revision,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO source_versions (
             sourceId, revision, eventId, operation, observedAt, processedAt, normalizationReport
           ) VALUES (?, ?, ?, 'rescan', ?, ?, ?)`,
        )
        .run(
          sourceId,
          revision,
          evidence.sourceEventId || `legacy-${sourceId}-${revision.slice(0, 12)}`,
          timestamp,
          timestamp,
          JSON.stringify({ inputCharacters: 0, outputCharacters: 0, removedNoise: [] }),
        );
      this.linkMemory({
        sourceId,
        revision,
        memoryId: row.id,
        sourceEventId: evidence.sourceEventId,
        chunkHash: evidence.chunkHash,
        locator: evidence.location || row.source,
      });
    }
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

function legacySourceType(sourceType: string, source: string): SourceType {
  if (sourceType === "listen") return "listen";
  if (/\.txt$/i.test(source)) return "text";
  return "markdown";
}

function normalizeConfiguredPath(sourcePath: string): string {
  if (!sourcePath.startsWith("~")) return normalizeSourcePath(sourcePath);
  const homeDirectory = process.env.USERPROFILE || process.env.HOME;
  if (!homeDirectory) return sourcePath.replace(/\\/g, "/");
  return normalizeSourcePath(join(homeDirectory, sourcePath.slice(1)));
}
