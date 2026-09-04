import Database from "better-sqlite3";
import { env } from "../../config/env";
import { getDatabase } from "../../lib/storage/database";
import { AiConfig, StorageConfig, ToolType, ToolWatchSource } from "../../types/config";

/** Persisted configuration used by the retained knowledge-processing product. */
export class KnowledgeConfigService {
  protected readonly db: Database.Database;

  constructor() {
    this.db = getDatabase();
    this.initKnowledgeConfig();
  }

  private initKnowledgeConfig(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    if (!this.getAiConfig()) {
      this.setAiConfig(this.getDefaultAiConfig());
    }
    if (!this.getStorageConfig()) {
      this.setStorageConfig(this.getDefaultStorageConfig());
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_watch_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        toolType TEXT NOT NULL,
        path TEXT NOT NULL,
        filePattern TEXT NOT NULL DEFAULT '*.jsonl',
        enabled INTEGER NOT NULL DEFAULT 1,
        topic TEXT,
        description TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
  }

  getStorageConfig(): StorageConfig | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'storage'").get() as
      { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as StorageConfig;
    } catch {
      return null;
    }
  }

  setStorageConfig(config: StorageConfig): void {
    this.db
      .prepare("INSERT OR REPLACE INTO config (key, value, updatedAt) VALUES (?, ?, ?)")
      .run("storage", JSON.stringify(config), new Date().toISOString());
  }

  getDefaultStorageConfig(): StorageConfig {
    return {
      notesPath: env.MEMORY_ROOT,
      updatedAt: new Date().toISOString(),
    };
  }

  getAiConfig(): AiConfig | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'ai'").get() as
      { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as AiConfig;
    } catch {
      return null;
    }
  }

  setAiConfig(config: AiConfig): void {
    this.db
      .prepare("INSERT OR REPLACE INTO config (key, value, updatedAt) VALUES (?, ?, ?)")
      .run("ai", JSON.stringify(config), new Date().toISOString());
  }

  getDefaultAiConfig(): AiConfig {
    return {
      provider: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      flagship: {
        model: "gpt-4o",
        maxTokens: 8192,
        temperature: 0.3,
        timeout: 60000,
        maxRetries: 3,
      },
      standard: {
        model: "gpt-4o-mini",
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 30000,
        maxRetries: 2,
      },
      budget: {
        model: "gpt-4o-mini",
        maxTokens: 2048,
        temperature: 0.6,
        timeout: 15000,
        maxRetries: 1,
      },
      embedding: {
        model: "text-embedding-3-small",
        dimensions: 1536,
        maxConcurrency: 8,
        queueTimeoutMs: 60000,
        apiKey: "",
        baseURL: "",
      },
    };
  }

  listToolSources(): ToolWatchSource[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_watch_sources ORDER BY updatedAt DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapToolSource(row));
  }

  getToolSource(id: string): ToolWatchSource | null {
    const row = this.db.prepare("SELECT * FROM tool_watch_sources WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.mapToolSource(row) : null;
  }

  createToolSource(
    source: Omit<ToolWatchSource, "id" | "createdAt" | "updatedAt">,
  ): ToolWatchSource {
    const now = new Date().toISOString();
    const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `
        INSERT INTO tool_watch_sources
          (id, name, toolType, path, filePattern, enabled, topic, description, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        source.name,
        source.toolType,
        source.path,
        source.filePattern || "*.jsonl",
        source.enabled ? 1 : 0,
        source.topic || null,
        source.description || null,
        now,
        now,
      );
    return this.getToolSource(id)!;
  }

  updateToolSource(id: string, updates: Partial<ToolWatchSource>): ToolWatchSource | null {
    const existing = this.getToolSource(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `
        UPDATE tool_watch_sources SET
          name = ?, toolType = ?, path = ?, filePattern = ?, enabled = ?, topic = ?, description = ?, updatedAt = ?
        WHERE id = ?
      `,
      )
      .run(
        merged.name,
        merged.toolType,
        merged.path,
        merged.filePattern,
        merged.enabled ? 1 : 0,
        merged.topic || null,
        merged.description || null,
        merged.updatedAt,
        id,
      );
    return this.getToolSource(id);
  }

  deleteToolSource(id: string): boolean {
    return this.db.prepare("DELETE FROM tool_watch_sources WHERE id = ?").run(id).changes > 0;
  }

  listEnabledToolSources(): ToolWatchSource[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_watch_sources WHERE enabled = 1 ORDER BY createdAt ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapToolSource(row));
  }

  private mapToolSource(row: Record<string, unknown>): ToolWatchSource {
    return {
      id: String(row.id),
      name: String(row.name),
      toolType: row.toolType as ToolType,
      path: String(row.path),
      filePattern: String(row.filePattern),
      enabled: Boolean(row.enabled),
      topic: row.topic ? String(row.topic) : undefined,
      description: row.description ? String(row.description) : undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  close(): void {
    // Shared connection; lifecycle is owned by database.ts.
  }
}
