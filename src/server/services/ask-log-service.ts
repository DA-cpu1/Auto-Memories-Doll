import Database from "better-sqlite3";
import { getDatabase } from "../../lib/storage/database";
import { generateId } from "../../lib/utils/id";
import { AskLoopMode, AskLogRecord, AskStats } from "../../types/ask";

type AskLogRow = {
  askId: string;
  question: string;
  answer: string;
  refused: number;
  citations: string;
  toolTrace: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  mode: string;
  durationMs: number;
  createdAt: string;
};

export class AskLogService {
  private db: Database.Database;

  constructor(db: Database.Database = getDatabase()) {
    this.db = db;
    this.init();
  }

  recordAsk(input: Omit<AskLogRecord, "askId" | "createdAt"> & { askId?: string }): AskLogRecord {
    const record: AskLogRecord = {
      askId: input.askId ?? generateId(),
      question: input.question,
      answer: input.answer,
      refused: input.refused,
      citations: input.citations,
      toolTrace: input.toolTrace,
      usage: input.usage,
      model: input.model,
      mode: input.mode,
      durationMs: input.durationMs,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
        INSERT INTO ask_logs (
          askId, question, answer, refused, citations, toolTrace,
          promptTokens, completionTokens, model, mode, durationMs, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.askId,
        record.question,
        record.answer,
        record.refused ? 1 : 0,
        JSON.stringify(record.citations),
        JSON.stringify(record.toolTrace),
        record.usage.promptTokens,
        record.usage.completionTokens,
        record.model,
        record.mode,
        record.durationMs,
        record.createdAt,
      );

    return record;
  }

  getStats(): AskStats {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS totalAsks,
               COALESCE(SUM(refused), 0) AS refusedAsks,
               COALESCE(SUM(promptTokens), 0) AS totalPromptTokens,
               COALESCE(SUM(completionTokens), 0) AS totalCompletionTokens,
               MAX(createdAt) AS lastAskedAt
        FROM ask_logs
      `,
      )
      .get() as {
      totalAsks: number;
      refusedAsks: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      lastAskedAt: string | null;
    };

    return {
      totalAsks: row.totalAsks,
      refusedAsks: row.refusedAsks,
      totalPromptTokens: row.totalPromptTokens,
      totalCompletionTokens: row.totalCompletionTokens,
      lastAskedAt: row.lastAskedAt,
    };
  }

  listRecent(limit = 20): AskLogRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM ask_logs ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as AskLogRow[];

    return rows.map(toRecord);
  }

  close(): void {
    // shared connection - closed by closeDatabase()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ask_logs (
        askId TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        refused INTEGER NOT NULL DEFAULT 0,
        citations TEXT NOT NULL DEFAULT '[]',
        toolTrace TEXT NOT NULL DEFAULT '[]',
        promptTokens INTEGER NOT NULL DEFAULT 0,
        completionTokens INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'stream',
        durationMs INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ask_logs_created_at ON ask_logs(createdAt);
    `);
  }
}

function toRecord(row: AskLogRow): AskLogRecord {
  return {
    askId: row.askId,
    question: row.question,
    answer: row.answer,
    refused: row.refused === 1,
    citations: parseJsonArray(row.citations),
    toolTrace: parseJsonArray(row.toolTrace),
    usage: {
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    },
    model: row.model,
    mode: (row.mode as AskLoopMode) || "stream",
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
