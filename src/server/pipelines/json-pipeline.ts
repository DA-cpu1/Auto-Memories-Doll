import { splitText } from "./splitter";
import { formatMemoryContent, formatSummary } from "./formatter";

export interface ProcessedChunk {
  id: string;
  content: string;
  summary: string;
  tags: string[];
}

// LKA-004 起跨来源精确去重已取消：相同来源由 sourceHash/revision 幂等保证，
// 不同来源的相同正文允许各自保存（见 docs/specs/004-automatic-publishing/delivery.md）。
export const processJsonPipeline = async (
  rawContent: string,
): Promise<{ chunks: ProcessedChunk[] }> => {
  const formatted = formatMemoryContent(rawContent);

  const chunks = splitText(formatted);
  const processedChunks: ProcessedChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    processedChunks.push({
      id: `${Date.now()}-${i}`,
      content: chunks[i],
      summary: formatSummary(chunks[i]),
      tags: extractTags(chunks[i]),
    });
  }

  return { chunks: processedChunks };
};

export const extractTags = (content: string): string[] => {
  const tags: string[] = [];

  const patterns = [/#(\w+)/g, /@(\w+)/g, /\[(\w+)\]/g];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        const tag = match.substring(1, match.length - (match.endsWith("]") ? 1 : 0));
        if (tag.length > 2 && tag.length < 20 && !tags.includes(tag)) {
          tags.push(tag);
        }
      });
    }
  }

  return tags.slice(0, 5);
};
