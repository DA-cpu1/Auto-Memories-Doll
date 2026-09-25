import type { ModelType } from "../lib/ai/knowledge-model";

/** 工具循环最大步数：search → read → 再检索 → 生成引用，6 步覆盖常见问题 */
export const ASK_MAX_STEPS = 6;

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

/** read_source_document 单次注入上下文的正文上限（字符），超出截断并标注 */
export const ASK_SOURCE_MAX_CHARS = 8000;

/** read_topic_guide 单个章节注入上下文的正文上限（字符） */
export const ASK_GUIDE_SECTION_MAX_CHARS = 600;
