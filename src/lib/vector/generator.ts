import { KnowledgeModelAdapter } from "../ai/knowledge-model-adapter";
import { VectorRecord } from "../../types/memory";
import { getCurrentTime } from "../utils/date";

export const generateEmbedding = async (text: string): Promise<number[]> => {
  const response = await KnowledgeModelAdapter.generateEmbedding(text);
  return response.embedding;
};

export const buildVectorRecord = async (memoryId: string, text: string): Promise<VectorRecord> => {
  const { embedding, model } = await KnowledgeModelAdapter.generateEmbedding(text);
  if (isEmbeddingEmpty(embedding)) throw new Error("Embedding unavailable");

  return {
    memoryId,
    embedding,
    model,
    dimensions: embedding.length,
    updatedAt: getCurrentTime(),
  };
};

export const isEmbeddingEmpty = (embedding: number[]): boolean => {
  return embedding.length === 0 || embedding.every((v) => v === 0);
};
