import type { RetrievalMode, VectorRetriever } from "./retriever";
import { rewriteQueryVariants } from "./query-rewriter";
import { logger } from "../logger";

export interface SearchWithExpansionOptions {
  /** 是否启用多路召回（评测基线对比时可关闭，只跑原始查询） */
  expansionEnabled?: boolean;
  /** 单路召回的相似度下限，透传给 retriever.search */
  minSimilarity?: number;
}

/**
 * 多路召回：原始查询 + 改写变体分别检索，按最高相似度去重合并。
 *
 * 合并策略：同一记忆被多路命中时取最大相似度（而非平均），
 * 避免"只有原句命中"的记忆被稀释排序。
 *
 * 降级路径：改写器返回空（无 API / 模型降级 / 输出异常）时，
 * 本函数退化为对原始查询的单路召回，行为与升级前一致。
 */
export async function searchWithExpansion(
  retriever: Pick<VectorRetriever, "search">,
  query: string,
  limit: number,
  options: SearchWithExpansionOptions = {},
): Promise<{ memoryId: string; similarity: number }[]> {
  const { expansionEnabled = true, minSimilarity } = options;

  const best = new Map<string, number>();
  const search = (currentQuery: string) =>
    minSimilarity !== undefined
      ? retriever.search(currentQuery, limit, minSimilarity)
      : retriever.search(currentQuery, limit);
  const originalSearch = search(query.trim());
  const rewrittenSearches = (async () => {
    const variants = expansionEnabled ? await rewriteQueryVariants(query) : [];
    const results = await Promise.all(variants.map(search));
    return { variants, results };
  })();
  const [originalResults, { variants, results: variantResults }] = await Promise.all([
    originalSearch,
    rewrittenSearches,
  ]);
  const resultSets = [originalResults, ...variantResults];
  for (const results of resultSets) {
    for (const r of results) {
      const prev = best.get(r.memoryId);
      if (prev === undefined || r.similarity > prev) {
        best.set(r.memoryId, r.similarity);
      }
    }
  }

  if (variants.length > 0) {
    logger.vector.debug("多路召回合并完成", {
      variants: variants.length,
      merged: best.size,
    });
  }

  return Array.from(best.entries())
    .map(([memoryId, similarity]) => ({ memoryId, similarity }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/** 与生产搜索 API 共用的多路召回版本，同时返回实际检索模式。 */
export async function searchWithExpansionDetailed(
  retriever: Pick<VectorRetriever, "searchDetailed">,
  query: string,
  limit: number,
  options: SearchWithExpansionOptions = {},
): Promise<{
  results: { memoryId: string; similarity: number }[];
  mode: RetrievalMode;
}> {
  const { expansionEnabled = true, minSimilarity } = options;
  const best = new Map<string, number>();
  const originalSearch = retriever.searchDetailed(query.trim(), limit, minSimilarity);
  const rewrittenSearches = (async () => {
    const variants = expansionEnabled ? await rewriteQueryVariants(query) : [];
    return Promise.all(
      variants.map((currentQuery) => retriever.searchDetailed(currentQuery, limit, minSimilarity)),
    );
  })();
  const [originalResponse, variantResponses] = await Promise.all([
    originalSearch,
    rewrittenSearches,
  ]);
  const responses = [originalResponse, ...variantResponses];
  const mode: RetrievalMode = originalResponse.mode;

  for (const response of responses) {
    for (const result of response.results) {
      const previous = best.get(result.memoryId);
      if (previous === undefined || result.similarity > previous) {
        best.set(result.memoryId, result.similarity);
      }
    }
  }

  return {
    results: [...best.entries()]
      .map(([memoryId, similarity]) => ({ memoryId, similarity }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit),
    mode,
  };
}
