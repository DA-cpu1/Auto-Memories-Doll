import type { ModelType } from "../lib/ai/knowledge-model";

/**
 * 工具循环最大步数。8 = 留余量的 5-6 次工具调用 + 最终作答步：
 * 实测 glm-4.7 在复杂问题上会用满 6 步工具，若上限贴着工具数会掐掉答案步。
 */
export const ASK_MAX_STEPS = 8;

/**
 * 单次问答整链路超时。问答走多步工具循环，明显高于单次 generate
 * 的档位超时（budget 15s / standard 30s），故独立配置。
 */
export const ASK_TIMEOUT_MS = 120_000;

export const ASK_QUESTION_MIN = 1;
export const ASK_QUESTION_MAX = 500;

/** search_memory 工具默认/最大返回条数 */
export const ASK_SEARCH_DEFAULT_LIMIT = 5;
export const ASK_SEARCH_MAX_LIMIT = 10;

/** 问答使用的模型档位：结构化抽取与引用生成都需要稳定输出 */
export const ASK_MODEL_TYPE: ModelType = "standard";

/** 引用片段归一化比对的最小长度：过短的引用（如单字）无溯源意义 */
export const ASK_CITATION_MIN_QUOTE_LENGTH = 6;

/** 引用自修正：最多注入候选记忆数与单条记忆正文截断长度（防 prompt 膨胀） */
export const ASK_REPAIR_MAX_CANDIDATES = 6;
export const ASK_REPAIR_MEMORY_CHARS = 3000;

/** read_source_document 单次注入上下文的正文上限（字符），超出截断并标注 */
export const ASK_SOURCE_MAX_CHARS = 8000;

/** read_topic_guide 单个章节注入上下文的正文上限（字符） */
export const ASK_GUIDE_SECTION_MAX_CHARS = 600;
