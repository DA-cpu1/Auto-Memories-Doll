import { NextRequest, NextResponse } from "next/server";
import { VectorRetriever } from "../../../../lib/vector/retriever";
import { MemoryService } from "../../../../server/services/memory-service";
import { apiResponse, apiError } from "../../../../lib/api-response";
import { ErrorCode } from "../../../../lib/api-errors";
import { logger } from "../../../../lib/logger";
import type { RetrievalMode } from "../../../../lib/vector/retriever";
import { searchWithExpansionDetailed } from "../../../../lib/vector/query-expansion";
import { Ranker } from "../../../../lib/vector/ranker";
import { WikiGraph } from "../../../../lib/graph/wiki-graph";

const GRAPH_SEED_LIMIT = 5;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const category = searchParams.get("category");
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "10", 10)));
  // 可选相似度阈值：默认 0.3（与 VectorRetriever 默认一致），传 0 表示不过滤
  const threshold = Math.max(0, Math.min(1, parseFloat(searchParams.get("threshold") || "0.3")));

  if (!query && !category) {
    return NextResponse.json(
      apiError(ErrorCode.VALIDATION_FAILED, "query parameter 'q' or 'category' is required"),
      { status: 400 },
    );
  }

  const retriever = new VectorRetriever();
  const memoryService = new MemoryService();

  try {
    let candidateIds: string[] = [];
    let retrievalMode: RetrievalMode | null = null;
    let scores = new Map<string, number>();
    const channels = new Map<string, Set<"vector" | "keyword" | "tag" | "graph">>();

    if (query) {
      // 原句与 budget 模型改写变体并行召回；模型不可用时自动退回原句关键词通道。
      const search = await searchWithExpansionDetailed(retriever, query, Math.max(limit * 4, 20), {
        minSimilarity: threshold,
      });
      retrievalMode = search.mode;
      candidateIds = search.results.map((result) => result.memoryId);
      scores = new Map(search.results.map((result) => [result.memoryId, result.similarity]));
      for (const id of candidateIds) channels.set(id, new Set([retrievalMode]));
    }

    if (category) {
      const classified = memoryService.listClassifications(category);
      const classifiedIds = classified.map((c) => c.memoryId);
      candidateIds = query
        ? candidateIds.filter((id) => classifiedIds.includes(id))
        : classifiedIds.slice(0, limit);
      for (const id of candidateIds) {
        const hitChannels = channels.get(id) ?? new Set();
        hitChannels.add("tag");
        channels.set(id, hitChannels);
      }
    }

    // 图谱只扩展当前命中的前几条；带分类过滤时保持过滤边界，不跨主题引入邻居。
    if (query && !category && candidateIds.length > 0) {
      const graph = new WikiGraph();
      const graphIds = new Set<string>();
      for (const memoryId of candidateIds.slice(0, GRAPH_SEED_LIMIT)) {
        for (const neighborId of await graph.getNeighbors(memoryId)) graphIds.add(neighborId);
      }
      for (const graphId of graphIds) {
        if (candidateIds.includes(graphId)) continue;
        candidateIds.push(graphId);
        scores.set(graphId, 0.2);
        channels.set(graphId, new Set(["graph"]));
      }
    }

    const memories = memoryService.getMemoriesByIds(candidateIds);
    const memoryMap = new Map(memories.map((memory) => [memory.id, memory]));
    const ranked = new Ranker().rankWithMMR(
      candidateIds.map((memoryId) => ({ memoryId, similarity: scores.get(memoryId) ?? 1 })),
      memoryMap,
    );
    const formattedResults = ranked.slice(0, limit).flatMap((rankedResult) => {
      const memory = memoryMap.get(rankedResult.memoryId);
      if (!memory) return [];
      return [
        {
          ...memory,
          ...(category ? { category } : {}),
          score: Math.max(0, Math.min(1, rankedResult.score)),
          channels: [...(channels.get(memory.id) ?? new Set())],
        },
      ];
    });

    return NextResponse.json(
      apiResponse({
        results: formattedResults,
        total: formattedResults.length,
        retrievalMode,
        degradedMode: retrievalMode === "keyword",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    logger.api.error("[Memory/Search] 搜索失败:", { message });
    return NextResponse.json(apiError(ErrorCode.MEMORY_VECTOR_FAILED, `搜索失败: ${message}`), {
      status: 500,
    });
  } finally {
    retriever.close();
    memoryService.close();
  }
}
