import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStudyGuideMarkdown } from "../lib/study-guide/markdown";
import { publishStudyGuideAtomically, readStudyGuide } from "../lib/study-guide/storage";
import { StudyGuideBuilder } from "../server/services/study-guide-builder";
import type { MemoryRecord } from "../types/memory";
import type { StudyGuide } from "../types/study-guide";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Phase 6 study guide generation", () => {
  it("builds a deterministic guide with complete knowledge and source references", async () => {
    const memories = [
      memory("m-2", "Zod 校验", ["TypeScript"]),
      memory("m-1", "类型设计", ["TypeScript"]),
    ];
    const builder = createBuilder(memories);

    const first = await builder.buildGuide("ai-coding", memories, {
      generatedAt: "2026-09-04T00:00:00.000Z",
    });
    const second = await builder.buildGuide("ai-coding", [...memories].reverse(), {
      generatedAt: "2026-09-05T00:00:00.000Z",
    });

    expect(first.memoryIds).toEqual(["m-1", "m-2"]);
    expect(first.sections).toHaveLength(1);
    expect(first.sections[0].memoryIds.slice().sort()).toEqual(first.memoryIds);
    expect(first.sourceVersions).toEqual([
      expect.objectContaining({
        sourceId: "source-1",
        revision: "rev-1",
        memoryIds: ["m-1", "m-2"],
      }),
    ]);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.generatedAt).not.toBe(second.generatedAt);
  });

  it("accepts title/order assistance only when all section memberships remain unchanged", async () => {
    const memories = [memory("m-1", "Alpha", ["one"]), memory("m-2", "Beta", ["two"])];
    const legalModel = {
      isAvailable: () => true,
      generate: vi.fn(async (prompt: string) => {
        const ids = [...prompt.matchAll(/section-[a-f0-9]{12}/g)].map((match) => match[0]);
        return JSON.stringify({
          sections: [
            { id: ids[1], title: "第二章", memoryIds: ["m-2"] },
            { id: ids[0], title: "第一章", memoryIds: ["m-1"] },
          ],
        });
      }),
    };
    const assisted = await createBuilder(memories, legalModel).buildGuide("ai-coding", memories, {
      modelAssist: true,
    });
    expect(assisted.modelAssisted).toBe(true);
    expect(assisted.sections.map((section) => section.title)).toEqual(["第二章", "第一章"]);

    const illegalModel = {
      isAvailable: () => true,
      generate: vi.fn(async () =>
        JSON.stringify({
          sections: [{ id: assisted.sections[0].id, title: "伪造", memoryIds: ["unknown"] }],
        }),
      ),
    };
    const fallback = await createBuilder(memories, illegalModel).buildGuide("ai-coding", memories, {
      modelAssist: true,
    });
    expect(fallback.modelAssisted).toBe(false);
    expect(fallback.memoryIds).toEqual(["m-1", "m-2"]);
  });

  it("writes a verified Markdown guide atomically and leaves no temporary file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "study-guide-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "ai-coding.md");
    const guide = await createBuilder([memory("m-1", "TypeScript", ["types"])]).buildGuide(
      "ai-coding",
      [memory("m-1", "TypeScript", ["types"])],
      { generatedAt: "2026-09-04T00:00:00.000Z" },
    );

    await publishStudyGuideAtomically(path, guide);

    expect(await readStudyGuide(path)).toEqual(guide);
    expect(parseStudyGuideMarkdown(readFileSync(path, "utf-8"))?.memoryIds).toEqual(["m-1"]);
    expect(statSync(path).isFile()).toBe(true);
  });

  it("deduplicates refresh requests and does not rebuild unrelated topics", async () => {
    const firstMemory = memory("m-1", "Alpha", ["one"]);
    const otherMemory = { ...memory("m-2", "Beta", ["two"]), topic: "learning" };
    const listMemories = vi.fn(({ topic }: { topic?: string }) =>
      [firstMemory, otherMemory].filter((item) => item.topic === topic),
    );
    const builder = createBuilder([firstMemory, otherMemory], undefined, listMemories);
    const generateSpy = vi.spyOn(builder, "generateTopic").mockResolvedValue({} as StudyGuide);

    await builder.refreshTopics(["ai-coding", "ai-coding"]);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy).toHaveBeenCalledWith("ai-coding");
    expect(listMemories).not.toHaveBeenCalled();
  });
});

function memory(id: string, title: string, tags: string[]): MemoryRecord {
  return {
    id,
    version: 1,
    source: "notes/source.md",
    sourceType: "ingest",
    kind: "fact",
    evidence: {
      text: `${title} evidence`,
      location: "notes/source.md",
      sourceId: "source-1",
      sourceRevision: "rev-1",
    },
    title,
    content: `${title} content`,
    summary: `${title} summary`,
    tags,
    topic: "ai-coding",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T01:00:00.000Z",
    accessedAt: "2026-09-04T01:00:00.000Z",
    accessCount: 0,
    heatScore: 0,
    graphLinks: [],
  };
}

function createBuilder(
  memories: MemoryRecord[],
  modelGateway: { isAvailable(): boolean; generate(prompt: string): Promise<string> } = {
    isAvailable: () => false,
    generate: async () => "",
  },
  listMemories = vi.fn(({ topic }: { topic?: string }) =>
    memories.filter((memory) => memory.topic === topic),
  ),
): StudyGuideBuilder {
  const memoryService = { listMemories, close: vi.fn() };
  const sourceRegistry = {
    getMemoryLinks: (memoryId: string) => [
      { sourceId: "source-1", revision: "rev-1", memoryId, createdAt: "2026-09-04T01:00:00.000Z" },
    ],
    getSource: () => ({
      sourceId: "source-1",
      sourceType: "markdown",
      sourcePath: "notes/source.md",
    }),
    getVersion: () => ({ observedAt: "2026-09-04T00:30:00.000Z" }),
    close: vi.fn(),
  };
  return new StudyGuideBuilder(memoryService as never, sourceRegistry as never, modelGateway);
}
