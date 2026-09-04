import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { getTopicLabelClient } from "../../config/topics-data";
import { KnowledgeModelAdapter } from "../../lib/ai/knowledge-model-adapter";
import { getStudyGuidePath } from "../../lib/storage/path-resolver";
import { publishStudyGuideAtomically, readStudyGuide } from "../../lib/study-guide/storage";
import type { MemoryRecord } from "../../types/memory";
import type { SourceMemoryLink } from "../../types/source";
import type {
  StudyGuide,
  StudyGuideSection,
  StudyGuideSourceVersion,
} from "../../types/study-guide";
import { MemoryService } from "./memory-service";
import { SourceRegistry } from "./source-registry";

type ModelGateway = {
  isAvailable(): boolean;
  generate(prompt: string): Promise<string>;
};

type GuideBuildOptions = {
  modelAssist?: boolean;
  force?: boolean;
  generatedAt?: string;
};

const defaultModelGateway: ModelGateway = {
  isAvailable: () => !KnowledgeModelAdapter.getDegradedCapabilities().includes("llm"),
  generate: async (prompt) => (await KnowledgeModelAdapter.generate(prompt, "standard")).content,
};

export class StudyGuideBuilder {
  constructor(
    private readonly memoryService = new MemoryService(),
    private readonly sourceRegistry = new SourceRegistry(),
    private readonly modelGateway: ModelGateway = defaultModelGateway,
  ) {}

  async getGuide(topic: string): Promise<StudyGuide | null> {
    return readStudyGuide(getStudyGuidePath(topic));
  }

  async generateTopic(topic: string, options: GuideBuildOptions = {}): Promise<StudyGuide | null> {
    const memories = this.memoryService.listMemories({
      topic,
      sortBy: "updatedAt",
      sortOrder: "asc",
    });
    const path = getStudyGuidePath(topic);
    if (memories.length === 0) {
      await fs.rm(path, { force: true });
      return null;
    }

    const guide = await this.buildGuide(topic, memories, options);
    const existing = await readStudyGuide(path);
    if (!options.force && existing?.contentHash === guide.contentHash) return existing;
    await publishStudyGuideAtomically(path, guide);
    return guide;
  }

  async refreshTopics(topics: Iterable<string>): Promise<StudyGuide[]> {
    const guides: StudyGuide[] = [];
    for (const topic of [...new Set(topics)].sort()) {
      const guide = await this.generateTopic(topic);
      if (guide) guides.push(guide);
    }
    return guides;
  }

  async buildGuide(
    topic: string,
    memories: MemoryRecord[],
    options: GuideBuildOptions = {},
  ): Promise<StudyGuide> {
    if (memories.length === 0) throw new Error(`主题 ${topic} 没有可生成资料的已接受知识`);
    if (memories.some((memory) => memory.topic !== topic)) {
      throw new Error("主题学习资料只能包含同一主题的知识单元");
    }

    const orderedMemories = [...memories].sort(compareMemories);
    let sections = buildDeterministicSections(orderedMemories);
    let modelAssisted = false;
    if (options.modelAssist && this.modelGateway.isAvailable()) {
      const assisted = await this.assistSections(topic, sections, orderedMemories);
      if (assisted) {
        sections = assisted;
        modelAssisted = true;
      }
    }

    const sourceVersions = this.collectSourceVersions(orderedMemories);
    const contentHash = hashGuideContent({ topic, sections, sourceVersions });
    return {
      schemaVersion: 1,
      topic,
      title: `${getTopicLabelClient(topic)}学习资料`,
      outline: sections.map((section) => ({ sectionId: section.id, title: section.title })),
      sections,
      memoryIds: orderedMemories.map((memory) => memory.id).sort(),
      sourceVersions,
      contentHash,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      modelAssisted,
    };
  }

  close(): void {
    this.memoryService.close();
    this.sourceRegistry.close();
  }

  private collectSourceVersions(memories: MemoryRecord[]): StudyGuideSourceVersion[] {
    const grouped = new Map<string, StudyGuideSourceVersion>();
    for (const memory of memories) {
      const links = this.sourceRegistry.getMemoryLinks(memory.id);
      const effectiveLinks: Array<Pick<SourceMemoryLink, "sourceId" | "revision">> =
        links.length > 0
          ? links
          : memory.evidence?.sourceId && memory.evidence.sourceRevision
            ? [{ sourceId: memory.evidence.sourceId, revision: memory.evidence.sourceRevision }]
            : [
                {
                  sourceId: memory.evidence?.sourceId || legacySourceId(memory.source),
                  revision:
                    memory.evidence?.sourceRevision ||
                    memory.evidence?.sourceHash ||
                    `memory-${memory.id}-v${memory.version}`,
                },
              ];
      for (const link of effectiveLinks) {
        const key = `${link.sourceId}\u0000${link.revision}`;
        const source = this.sourceRegistry.getSource(link.sourceId);
        const version = this.sourceRegistry.getVersion(link.sourceId, link.revision);
        const current = grouped.get(key) ?? {
          sourceId: link.sourceId,
          revision: link.revision,
          sourceType: source?.sourceType ?? memory.sourceType,
          sourcePath: source?.sourcePath ?? memory.evidence?.location ?? memory.source,
          capturedAt: version?.observedAt ?? memory.updatedAt,
          memoryIds: [],
        };
        current.memoryIds.push(memory.id);
        grouped.set(key, current);
      }
    }
    return [...grouped.values()]
      .map((source) => ({ ...source, memoryIds: [...new Set(source.memoryIds)].sort() }))
      .sort((a, b) => `${a.sourceId}:${a.revision}`.localeCompare(`${b.sourceId}:${b.revision}`));
  }

  private async assistSections(
    topic: string,
    sections: StudyGuideSection[],
    memories: MemoryRecord[],
  ): Promise<StudyGuideSection[] | null> {
    const prompt = [
      "你只负责改善现有主题资料的章节标题与章节顺序，不得增加事实、章节或知识引用。",
      '返回严格 JSON：{"sections":[{"id":"...","title":"...","memoryIds":["..."]}]}。',
      `主题：${topic}`,
      `章节：${JSON.stringify(sections.map(({ id, title, memoryIds }) => ({ id, title, memoryIds })))}`,
      `已接受知识：${JSON.stringify(memories.map((memory) => ({ id: memory.id, title: memory.titleZh || memory.title, summary: memory.summaryZh || memory.summary })))}`,
    ].join("\n");
    try {
      const response = await this.modelGateway.generate(prompt);
      const match = response.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        sections?: Array<{ id?: unknown; title?: unknown; memoryIds?: unknown }>;
      };
      if (!Array.isArray(parsed.sections) || parsed.sections.length !== sections.length)
        return null;
      const originals = new Map(sections.map((section) => [section.id, section]));
      const seen = new Set<string>();
      const result: StudyGuideSection[] = [];
      for (const candidate of parsed.sections) {
        if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
        if (
          !Array.isArray(candidate.memoryIds) ||
          candidate.memoryIds.some((id) => typeof id !== "string")
        ) {
          return null;
        }
        const original = originals.get(candidate.id);
        const title = cleanSectionTitle(candidate.title);
        if (!original || seen.has(candidate.id) || !title) return null;
        if (!sameStringSet(candidate.memoryIds as string[], original.memoryIds)) return null;
        seen.add(candidate.id);
        result.push({ ...original, title });
      }
      return result;
    } catch {
      return null;
    }
  }
}

function buildDeterministicSections(memories: MemoryRecord[]): StudyGuideSection[] {
  const parent = new Map(memories.map((memory) => [memory.id, memory.id]));
  const find = (id: string): string => {
    const value = parent.get(id)!;
    if (value === id) return id;
    const root = find(value);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      const [root, child] =
        leftRoot.localeCompare(rightRoot) <= 0 ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
      parent.set(child, root);
    }
  };
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const firstByTag = new Map<string, string>();
  for (const memory of memories) {
    for (const tag of memory.tags.map(normalizeTag).filter(Boolean)) {
      const first = firstByTag.get(tag);
      if (first) union(memory.id, first);
      else firstByTag.set(tag, memory.id);
    }
    for (const linkedId of memory.graphLinks) {
      if (byId.has(linkedId)) union(memory.id, linkedId);
    }
  }

  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const root = find(memory.id);
    groups.set(root, [...(groups.get(root) ?? []), memory]);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = group.sort(compareMemories);
      const memoryIds = sorted.map((memory) => memory.id);
      const title = cleanSectionTitle(
        mostFrequentTag(sorted) || sorted[0].titleZh || sorted[0].title,
      );
      const id = `section-${createHash("sha256").update(memoryIds.slice().sort().join("\u0000")).digest("hex").slice(0, 12)}`;
      const content = sorted
        .map(
          (memory) =>
            `### ${memory.titleZh || memory.title}\n\n${memory.summaryZh || memory.summary || memory.content.slice(0, 240)}`,
        )
        .join("\n\n");
      return { id, title, content, memoryIds };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function compareMemories(a: MemoryRecord, b: MemoryRecord): number {
  return (a.titleZh || a.title).localeCompare(b.titleZh || b.title) || a.id.localeCompare(b.id);
}

function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

function cleanSectionTitle(title: string): string {
  const cleaned = title
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= 160 ? cleaned : cleaned.slice(0, 160).trim();
}

function mostFrequentTag(memories: MemoryRecord[]): string {
  const counts = new Map<string, { count: number; label: string }>();
  for (const memory of memories) {
    const labels = memory.tagsZh?.length ? memory.tagsZh : memory.tags;
    for (const label of labels) {
      const key = normalizeTag(label);
      if (!key) continue;
      const current = counts.get(key) ?? { count: 0, label };
      current.count += 1;
      counts.set(key, current);
    }
  }
  return (
    [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0]
      ?.label ?? ""
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}

function hashGuideContent(value: {
  topic: string;
  sections: StudyGuideSection[];
  sourceVersions: StudyGuideSourceVersion[];
}): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function legacySourceId(source: string): string {
  return `legacy-source-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}
