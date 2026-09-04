import { createHash } from "node:crypto";
import type { SourceChunk } from "../../types/normalization";

export const DEFAULT_CHUNK_SIZE = 1_000;
export const DEFAULT_CHUNK_OVERLAP = 120;

export type SplitOptions = {
  maxChunkSize?: number;
  overlap?: number;
  sourceId?: string;
};

export function splitSemanticText(text: string, options: SplitOptions = {}): SourceChunk[] {
  const maxChunkSize = Math.max(1, options.maxChunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.floor(
    Math.min(Math.max(0, options.overlap ?? DEFAULT_CHUNK_OVERLAP), maxChunkSize / 3),
  );
  const sections = semanticSections(text);
  const chunks: SourceChunk[] = [];

  for (const section of sections) {
    const pieces = splitSection(section.content, maxChunkSize, overlap);
    for (const piece of pieces) {
      const hash = createHash("sha256").update(piece.content).digest("hex");
      const ordinal = chunks.length;
      chunks.push({
        chunkId: `chunk-${createHash("sha256")
          .update(`${options.sourceId ?? "source"}:${section.locator ?? ordinal}:${hash}`)
          .digest("hex")
          .slice(0, 32)}`,
        hash,
        ordinal,
        content: piece.content,
        locator: section.locator,
        boundary: pieces.length > 1 ? "length-fallback" : section.boundary,
      });
    }
  }
  return chunks;
}

export const splitText = (text: string, maxChunkSize: number = DEFAULT_CHUNK_SIZE): string[] =>
  splitSemanticText(text, { maxChunkSize, overlap: 0 }).map((chunk) => chunk.content);

type SemanticSection = Pick<SourceChunk, "content" | "locator" | "boundary">;

function semanticSections(text: string): SemanticSection[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const headings = [...normalized.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  if (headings.length === 0) {
    return normalized
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((content, index) => ({
        content: content.trim(),
        locator: `paragraph:${index + 1}`,
        boundary: "paragraph" as const,
      }));
  }

  const sections: SemanticSection[] = [];
  if ((headings[0].index ?? 0) > 0) {
    sections.push({
      content: normalized.slice(0, headings[0].index).trim(),
      locator: "preamble",
      boundary: "markdown-section",
    });
  }
  headings.forEach((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? normalized.length;
    const label = heading[2].trim();
    const conversationTurn = /^(?:用户|AI|我|系统|user|assistant|system)$/i.test(label);
    sections.push({
      content: normalized.slice(start, end).trim(),
      locator: `heading:${label}`,
      boundary: conversationTurn ? "conversation-turn" : "markdown-section",
    });
  });
  return sections.filter((section) => section.content.length > 0);
}

function splitSection(
  text: string,
  maxChunkSize: number,
  overlap: number,
): Array<{ content: string }> {
  if (text.length <= maxChunkSize) return [{ content: text }];
  const chunks: Array<{ content: string }> = [];
  let start = 0;
  while (start < text.length) {
    const desiredEnd = Math.min(text.length, start + maxChunkSize);
    const end = desiredEnd === text.length ? desiredEnd : findSplitPoint(text, start, desiredEnd);
    const content = text.slice(start, end).trim();
    if (content) chunks.push({ content });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function findSplitPoint(text: string, start: number, desiredEnd: number): number {
  const minimum = start + Math.floor((desiredEnd - start) * 0.5);
  const preferredDelimiters = ["\n\n", ". ", "。", "!", "！", "?", "？", "\n", ";", "；"];
  for (const delimiter of preferredDelimiters) {
    const index = text.lastIndexOf(delimiter, desiredEnd);
    if (index >= minimum) return index + delimiter.length;
  }
  return desiredEnd;
}
