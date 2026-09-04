import { beforeEach, describe, expect, it } from "vitest";
import { getDatabase } from "../lib/storage/database";
import { createSourceRevisionEvent } from "../lib/source/source-revision";
import { SourceRegistry } from "../server/services/source-registry";

describe("SourceRegistry", () => {
  beforeEach(() => {
    const registry = new SourceRegistry();
    getDatabase().exec("DELETE FROM source_documents");
    registry.close();
  });

  it("persists new, unchanged, and changed source revisions without advancing failed work", () => {
    const registry = new SourceRegistry();
    const first = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath: "C:/knowledge/source.md",
      content: "first revision",
      operation: "add",
      observedAt: "2026-09-04T00:00:00.000Z",
    });

    expect(registry.beginObservation(first).disposition).toBe("new");
    expect(registry.getSource(first.sourceId)).toMatchObject({
      latestRevision: undefined,
      health: "unknown",
      lastObservedAt: first.observedAt,
    });

    registry.markProcessed(first);
    expect(registry.beginObservation(first).disposition).toBe("unchanged");

    const changed = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath: "C:/knowledge/source.md",
      content: "second revision",
      operation: "change",
      observedAt: "2026-09-04T01:00:00.000Z",
    });
    expect(registry.beginObservation(changed).disposition).toBe("changed");
    registry.markFailed(changed, "parser rejected input");

    const reopened = new SourceRegistry();
    expect(reopened.getSource(first.sourceId)).toMatchObject({
      latestRevision: first.revision,
      health: "degraded",
      lastError: "parser rejected input",
    });
    reopened.markProcessed(changed);
    expect(reopened.getSource(first.sourceId)).toMatchObject({
      latestRevision: changed.revision,
      health: "healthy",
      lastError: undefined,
    });
  });
});
