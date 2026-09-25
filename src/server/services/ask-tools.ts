import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  ASK_GUIDE_SECTION_MAX_CHARS,
  ASK_SEARCH_DEFAULT_LIMIT,
  ASK_SEARCH_MAX_LIMIT,
  ASK_SOURCE_MAX_CHARS,
} from "../../config/ask.config";
import { VectorRetriever } from "../../lib/vector/retriever";
import { MemoryRecord } from "../../types/memory";
import { StudyGuide } from "../../types/study-guide";
import { MemoryService } from "./memory-service";
import { SourceRegistry } from "./source-registry";
import { StudyGuideBuilder } from "./study-guide-builder";

/**
 * 问答 Agent 的四个取证工具。工具只负责"从本地知识库取事实"，
 * 不做任何生成；答案生成与引用校验在 ask-agent-service 中完成。
 *
 * 所有工具统一返回 ToolResult：失败返回 { ok: false, error } 而非抛错，
 * 让模型可以在循环内自行纠正（如换 memoryId 重试）。
 */

export type ToolOk<T> = { ok: true; data: T };
export type ToolErr = { ok: false; error: string };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export type SearchMemoryData = {
  mode: "vector" | "keyword";
  results: {
    memoryId: string;
    title: string;
    summary: string;
    topic: string;
    score: number;
  }[];
};

export type ReadMemoryData = {
  memoryId: string;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  topic: string;
  source: string;
  sourceType: string;
  createdAt: string;
  updatedAt: string;
};

export type ReadSourceDocumentData = {
  sourceId: string;
  sourceType: string;
  sourcePath: string;
  content: string;
  truncated: boolean;
};

export type ReadTopicGuideData = {
  topic: string;
  title: string;
  outline: { sectionId: string; title: string }[];
  sections: { id: string; title: string; memoryIds: string[]; content: string }[];
  generatedAt: string;
};

export const searchMemorySchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(ASK_SEARCH_MAX_LIMIT).optional(),
});
export const readMemorySchema = z.object({ memoryId: z.string().min(1).max(128) });
export const readSourceDocumentSchema = z.object({ sourceId: z.string().min(1).max(128) });
export const readTopicGuideSchema = z.object({ topic: z.string().min(1).max(128) });

export const ASK_TOOL_NAMES = {
  searchMemory: "search_memory",
  readMemory: "read_memory",
  readSourceDocument: "read_source_document",
  readTopicGuide: "read_topic_guide",
} as const;

export const ASK_TOOL_DESCRIPTIONS = {
  [ASK_TOOL_NAMES.searchMemory]:
    "语义检索记忆库，返回记忆卡摘要列表（memoryId/标题/摘要/主题/相似度）。回答任何事实问题前先用它找候选记忆。",
  [ASK_TOOL_NAMES.readMemory]:
    "按 memoryId 读取一条记忆的完整内容。引用片段必须来自这里读到的原文。",
  [ASK_TOOL_NAMES.readSourceDocument]:
    "按 sourceId 读取记忆的原始来源文件全文（用于来源追溯与上下文补全）。",
  [ASK_TOOL_NAMES.readTopicGuide]:
    "读取某主题的学习资料大纲与章节（含各章节关联的 memoryIds），适合回答'关于某主题都知道什么'类问题。",
} as const;

type RetrieverLike = Pick<VectorRetriever, "searchDetailed">;
type MemoryServiceLike = Pick<MemoryService, "getMemoriesByIds" | "getMemory">;
/** 来源读取只需要这三个字段，避免测试桩被 SourceDocument 全字段约束 */
type SourceRef = { sourceId: string; sourceType: string; sourcePath?: string };
type SourceRegistryLike = { getSource(sourceId: string): SourceRef | null };
type GuideReaderLike = { getGuide(topic: string): Promise<StudyGuide | null> };

export type AskToolkitDeps = {
  retriever?: RetrieverLike;
  memoryService?: MemoryServiceLike;
  sourceRegistry?: SourceRegistryLike;
  guideReader?: GuideReaderLike;
};

export class AskToolkit {
  private readonly retriever: RetrieverLike;
  private readonly memoryService: MemoryServiceLike;
  private readonly sourceRegistry: SourceRegistryLike;
  private readonly guideReader: GuideReaderLike;

  constructor(deps: AskToolkitDeps = {}) {
    this.retriever = deps.retriever ?? new VectorRetriever();
    this.memoryService = deps.memoryService ?? new MemoryService();
    this.sourceRegistry = deps.sourceRegistry ?? new SourceRegistry();
    this.guideReader = deps.guideReader ?? new StudyGuideBuilder();
  }

  async searchMemory(
    input: z.infer<typeof searchMemorySchema>,
  ): Promise<ToolResult<SearchMemoryData>> {
    try {
      const limit = input.limit ?? ASK_SEARCH_DEFAULT_LIMIT;
      const { results, mode } = await this.retriever.searchDetailed(input.query, limit);

      if (results.length === 0) {
        return { ok: true, data: { mode, results: [] } };
      }

      const memories = this.memoryService.getMemoriesByIds(results.map((r) => r.memoryId));
      const byId = new Map(memories.map((m) => [m.id, m]));

      return {
        ok: true,
        data: {
          mode,
          results: results
            .filter((r) => byId.has(r.memoryId))
            .map((r) => {
              const memory = byId.get(r.memoryId)!;
              return {
                memoryId: memory.id,
                title: memory.titleZh || memory.title,
                summary: memory.summaryZh || memory.summary,
                topic: memory.topic,
                score: Number(r.similarity.toFixed(4)),
              };
            }),
        },
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  async readMemory(input: z.infer<typeof readMemorySchema>): Promise<ToolResult<ReadMemoryData>> {
    try {
      const memory = this.memoryService.getMemory(input.memoryId);
      if (!memory) {
        return { ok: false, error: `记忆不存在: ${input.memoryId}` };
      }
      return { ok: true, data: toReadMemoryData(memory) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  async readSourceDocument(
    input: z.infer<typeof readSourceDocumentSchema>,
  ): Promise<ToolResult<ReadSourceDocumentData>> {
    try {
      const source = this.sourceRegistry.getSource(input.sourceId);
      if (!source) {
        return { ok: false, error: `来源不存在: ${input.sourceId}` };
      }
      if (!source.sourcePath) {
        return { ok: false, error: `来源 ${input.sourceId} 未登记文件路径` };
      }

      const raw = await fs.readFile(source.sourcePath, "utf-8");
      const truncated = raw.length > ASK_SOURCE_MAX_CHARS;
      return {
        ok: true,
        data: {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourcePath: source.sourcePath,
          content: truncated ? raw.slice(0, ASK_SOURCE_MAX_CHARS) : raw,
          truncated,
        },
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  async readTopicGuide(
    input: z.infer<typeof readTopicGuideSchema>,
  ): Promise<ToolResult<ReadTopicGuideData>> {
    try {
      const guide = await this.guideReader.getGuide(input.topic);
      if (!guide) {
        return { ok: false, error: `尚无主题「${input.topic}」的学习资料` };
      }
      return {
        ok: true,
        data: {
          topic: guide.topic,
          title: guide.title,
          outline: guide.outline,
          sections: guide.sections.map((section) => ({
            id: section.id,
            title: section.title,
            memoryIds: section.memoryIds,
            content:
              section.content.length > ASK_GUIDE_SECTION_MAX_CHARS
                ? `${section.content.slice(0, ASK_GUIDE_SECTION_MAX_CHARS)}…`
                : section.content,
          })),
          generatedAt: guide.generatedAt,
        },
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 引用校验专用：按 id 批量读记忆完整记录（含 content/summary/title）。
   * 不进入模型上下文，只供服务端逐字比对。
   */
  readMemoriesForVerification(ids: string[]): MemoryRecord[] {
    return this.memoryService.getMemoriesByIds(ids);
  }
}

export function toReadMemoryData(memory: MemoryRecord): ReadMemoryData {
  return {
    memoryId: memory.id,
    title: memory.titleZh || memory.title,
    content: memory.content,
    summary: memory.summaryZh || memory.summary,
    tags: memory.tags,
    topic: memory.topic,
    source: memory.source,
    sourceType: memory.sourceType,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

/** 工具结果的短摘要，用于 tool_trace 落库与 SSE tool_result 事件 */
export function summarizeToolResult(tool: string, result: unknown): string {
  if (result && typeof result === "object" && "ok" in result) {
    const typed = result as ToolResult<unknown>;
    if (!typed.ok) return `失败: ${typed.error}`;
    return summarizeOk(tool, typed.data);
  }
  return "未知结果";
}

function summarizeOk(tool: string, data: unknown): string {
  if (tool === ASK_TOOL_NAMES.searchMemory) {
    const typed = data as SearchMemoryData;
    return `命中 ${typed.results.length} 条（${typed.mode}）`;
  }
  if (tool === ASK_TOOL_NAMES.readMemory) {
    const typed = data as ReadMemoryData;
    return `读取 ${typed.memoryId}（${typed.content.length} 字）`;
  }
  if (tool === ASK_TOOL_NAMES.readSourceDocument) {
    const typed = data as ReadSourceDocumentData;
    return `读取来源 ${typed.sourceId}${typed.truncated ? "（已截断）" : ""}`;
  }
  if (tool === ASK_TOOL_NAMES.readTopicGuide) {
    const typed = data as ReadTopicGuideData;
    return `主题资料 ${typed.topic}（${typed.sections.length} 章）`;
  }
  return "完成";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
