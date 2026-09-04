import { describe, expect, it } from "vitest";
import { createSourceRevisionEvent, parseSourceRevisionEvent } from "../lib/source/source-revision";

describe("SourceRevisionEvent contract", () => {
  it("gives the same normalized source revision a stable identity", () => {
    const first = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath: "C:\\Knowledge\\notes\\agent.md",
      content: "# Agent\n\nStable knowledge.",
      operation: "add",
      observedAt: "2026-09-04T00:00:00.000Z",
    });
    const repeated = createSourceRevisionEvent({
      sourceType: "markdown",
      sourcePath: "C:/Knowledge/notes/agent.md",
      content: "# Agent\n\nStable knowledge.",
      operation: "rescan",
      observedAt: "2026-09-04T01:00:00.000Z",
    });

    expect(first.sourcePath).toBe(repeated.sourcePath);
    expect(first.sourceId).toBe(repeated.sourceId);
    expect(first.revision).toBe(repeated.revision);
    expect(first.eventId).toBe(repeated.eventId);
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(parseSourceRevisionEvent(first)).toEqual(first);
  });

  it("rejects malformed hashes and timestamps", () => {
    expect(() =>
      parseSourceRevisionEvent({
        eventId: "source-event-invalid",
        sourceId: "source-invalid",
        sourceType: "markdown",
        sourcePath: "C:/notes/agent.md",
        revision: "not-a-sha256",
        observedAt: "today",
        operation: "add",
      }),
    ).toThrow();
  });
});
