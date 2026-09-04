/** Model tiers used by structured knowledge-processing tasks. */
export type ModelType = "flagship" | "standard" | "budget";

export type LlmResponse = {
  content: string;
  finishReason: string;
  model: string;
  timestamp: string;
};

export type EmbeddingResponse = {
  embedding: number[];
  model: string;
  timestamp: string;
};

export type DegradedCapability = "llm" | "embedding";

/** Contract intentionally contains no streaming or chat event types. */
export interface KnowledgeModel {
  readonly isDegradedMode: boolean;
  generate(prompt: string, modelType: ModelType): Promise<LlmResponse>;
  generateEmbedding(text: string): Promise<EmbeddingResponse>;
  getDegradedCapabilities(): DegradedCapability[];
}
