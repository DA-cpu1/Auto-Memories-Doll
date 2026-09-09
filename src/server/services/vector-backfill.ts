import { createHash } from "node:crypto";
import { getDatabase } from "../../lib/storage/database";
import { getKnowledgeAiConfig, KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import { VectorIndex } from "../../lib/vector/index";
import { dependencyConfig } from "../../config/dependency.config";

export class VectorBackfill {
  private static running = false;
  private db = getDatabase();

  constructor() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS vector_jobs (
      memoryId TEXT PRIMARY KEY, contentHash TEXT NOT NULL, model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, status TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
  }

  async run(): Promise<void> {
    if (VectorBackfill.running) return;
    const index = new VectorIndex();
    VectorBackfill.running = true;
    try {
      const config = getKnowledgeAiConfig().embedding;
      const records = this.db
        .prepare("SELECT id, content, updatedAt FROM memories ORDER BY id")
        .all() as Array<{ id: string; content: string; updatedAt: string }>;
      let requests = 0;
      for (const record of records) {
        const contentHash = createHash("sha256").update(record.content).digest("hex");
        const job = this.db
          .prepare("SELECT * FROM vector_jobs WHERE memoryId = ?")
          .get(record.id) as
          { contentHash: string; model: string; dimensions: number; status: string } | undefined;
        const current = getKnowledgeAiConfig().embedding;
        const status = current.enabled === false ? "disabled" : "pending";
        const indexed = index.read(record.id);
        if (
          !job &&
          indexed?.model === config.model &&
          indexed.dimensions === config.dimensions &&
          indexed.updatedAt >= record.updatedAt
        ) {
          this.db
            .prepare("INSERT INTO vector_jobs VALUES (?, ?, ?, ?, 'ready', ?)")
            .run(record.id, contentHash, config.model, config.dimensions, indexed.updatedAt);
          continue;
        }
        if (
          job?.contentHash === contentHash &&
          job.model === config.model &&
          job.dimensions === config.dimensions &&
          job.status === "ready" &&
          indexed?.model === config.model &&
          indexed.dimensions === config.dimensions
        )
          continue;
        this.db
          .prepare("INSERT OR REPLACE INTO vector_jobs VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            record.id,
            contentHash,
            config.model,
            config.dimensions,
            status,
            new Date().toISOString(),
          );
        if (
          current.enabled === false ||
          KnowledgeModelAdapter.dependencyReason("embedding") ||
          requests >= dependencyConfig.batchSize
        )
          continue;
        requests++;
        const response = await KnowledgeModelAdapter.generateEmbedding(record.content);
        const latest = this.db
          .prepare("SELECT content, updatedAt FROM memories WHERE id = ?")
          .get(record.id) as { content: string; updatedAt: string } | undefined;
        const after = getKnowledgeAiConfig().embedding;
        if (
          !latest ||
          latest.content !== record.content ||
          latest.updatedAt !== record.updatedAt ||
          after.enabled === false ||
          after.model !== config.model ||
          after.dimensions !== config.dimensions
        )
          continue;
        if (
          response.model !== config.model ||
          response.embedding.length !== config.dimensions ||
          !response.embedding.every(Number.isFinite) ||
          response.embedding.every((value) => value === 0)
        ) {
          this.db
            .prepare("UPDATE vector_jobs SET status = 'failed' WHERE memoryId = ?")
            .run(record.id);
          continue;
        }
        index.create({
          memoryId: record.id,
          model: response.model,
          embedding: response.embedding,
          dimensions: response.embedding.length,
          updatedAt: new Date().toISOString(),
        });
        this.db.prepare("UPDATE memories SET vectorId = ? WHERE id = ?").run(record.id, record.id);
        this.db
          .prepare("UPDATE vector_jobs SET status = 'ready', updatedAt = ? WHERE memoryId = ?")
          .run(new Date().toISOString(), record.id);
      }
      this.db
        .prepare("DELETE FROM vector_jobs WHERE memoryId NOT IN (SELECT id FROM memories)")
        .run();
    } finally {
      index.close();
      VectorBackfill.running = false;
    }
  }

  counts(): Record<string, number> {
    const fallback = getKnowledgeAiConfig().embedding.enabled === false ? "disabled" : "pending";
    const rows = this.db
      .prepare(
        "SELECT COALESCE(v.status, ?) AS status, count(*) AS count FROM memories m LEFT JOIN vector_jobs v ON m.id = v.memoryId GROUP BY COALESCE(v.status, ?)",
      )
      .all(fallback, fallback) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}
