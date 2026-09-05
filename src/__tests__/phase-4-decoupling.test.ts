import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseState = vi.hoisted(() => ({
  current: null as Database.Database | null,
}));

vi.mock("../lib/storage/database", () => ({
  getDatabase: () => databaseState.current,
}));

import { KnowledgeConfigService } from "../server/services/knowledge-config-service";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

describe("LKA-001 Phase 4 dependency boundaries", () => {
  it("keeps ranking independent from inferred profile data", () => {
    const ranker = source("src/lib/vector/ranker.ts");
    const scoring = source("src/config/scoring.config.ts");

    for (const content of [ranker, scoring]) {
      expect(content).not.toMatch(/profileTags|tagAffinity|readProfileTags/);
    }
    expect(ranker).toContain("qualityScore");
  });

  it("keeps storage migration independent from chat prompt caches", () => {
    expect(source("src/server/services/storage-migration-service.ts")).not.toContain("PromptCache");
    expect(source("src/lib/storage/path-resolver.ts")).not.toContain("PromptCache");
  });

  it("keeps retained AI consumers independent from chat event contracts", () => {
    const retainedConsumers = [
      "src/lib/vector/generator.ts",
      "src/lib/vector/query-rewriter.ts",
      "src/server/services/knowledge-agent.ts",
      "src/server/services/memory-extraction-service.ts",
      "src/server/services/orchestrator.ts",
      "src/server/services/quality-filter-service.ts",
      "src/server/services/topic-classification-service.ts",
    ];

    for (const file of retainedConsumers) {
      const content = source(file);
      expect(content, file).toContain("knowledge-model-adapter");
      expect(content, file).not.toContain('/model-adapter"');
      expect(content, file).not.toContain("ai-events");
    }
    expect(source("src/lib/ai/knowledge-model.ts")).not.toMatch(/AiEvent|ChatSessionEvent/);
    expect(source("src/lib/ai/knowledge-model-adapter.ts")).not.toMatch(/ai-events/);
  });

  it("keeps non-audited retention and nightly loops out of the production bootstrap", () => {
    expect(source("src/instrumentation.ts")).not.toMatch(/RetentionScheduler|NightlyScheduler/);
  });

  it("does not start the legacy MCP collector in the production bootstrap", () => {
    expect(source("src/instrumentation.ts")).not.toMatch(/McpCollectScheduler|mcp-collect/);
  });
});

describe("KnowledgeConfigService non-destructive migration", () => {
  beforeEach(() => {
    databaseState.current?.close();
    databaseState.current = new Database(":memory:");
  });

  it("does not create legacy MCP or Skills tables for retained consumers", () => {
    new KnowledgeConfigService().close();
    const names = databaseState
      .current!.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toContain("config");
    expect(names).toContain("tool_watch_sources");
    expect(names).not.toContain("mcp_servers");
    expect(names).not.toContain("skills");
  });

  it("leaves existing legacy rows untouched", () => {
    databaseState.current!.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO mcp_servers (id, name) VALUES ('legacy-server', 'preserved server');
    `);

    new KnowledgeConfigService().close();
    const row = databaseState
      .current!.prepare("SELECT name FROM mcp_servers WHERE id = ?")
      .get("legacy-server") as { name: string } | undefined;

    expect(row?.name).toBe("preserved server");
  });
});
